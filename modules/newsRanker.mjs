import dotenv from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createTokenUsageTracker } from "./tokenUsage.mjs";

dotenv.config();

const rankerTokenUsage = createTokenUsageTracker("Ranker");
const INPUT_FILE = new URL("../data/filtered-news.json", import.meta.url);
const OUTPUT_FILE = new URL("../data/ranked-news.json", import.meta.url);

const CATEGORIES = ["政治", "汽车", "科技", "文化", "娱乐"];
const TOP_N_PER_CATEGORY = 3;
const MAX_CONTENT_LENGTH = 160;
const RANK_MAX_RETRIES = 1;
const RANK_RETRY_DELAY_MS = 3000;

const analysisApiKey = process.env.ANALYSIS_API_KEY;
const analysisBaseUrl = process.env.ANALYSIS_BASE_URL;
const analysisModel = process.env.ANALYSIS_MODEL;

if (!analysisApiKey || !analysisBaseUrl || !analysisModel) {
  throw new Error("缺少 ANALYSIS_API_KEY / ANALYSIS_BASE_URL / ANALYSIS_MODEL");
}

const endpoint = `${analysisBaseUrl.replace(/\/$/, "")}/chat/completions`;

function getBeijingDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function loadFilteredNews() {
  const text = await readFile(INPUT_FILE, "utf-8");
  const newsList = JSON.parse(text);
  if (!Array.isArray(newsList)) throw new Error("filtered-news.json 必须是数组");
  return newsList;
}

function buildCompactCandidates(newsList) {
  return newsList.map((news, index) => ({
    id: index,
    country: news.country,
    title: news.title,
    source: news.source,
    publishedAt: news.publishedAt,
    content: String(news.content || "").trim().slice(0, MAX_CONTENT_LENGTH),
  }));
}

function buildRankingPrompt(category, candidates) {
  const currentDate = getBeijingDate();

  return `
你是全球市场资讯编辑。

当前日期为 ${currentDate}（北京时间）。
请从“${category}”类候选新闻中选出当天最值得推送的 Top ${TOP_N_PER_CATEGORY}。

【硬门槛】
1. 国家相关性：新闻必须与标注 country 直接相关。不能仅凭搜索标签推断。
2. 分类准确性：必须判断新闻核心事件，而不是只看关键词。

分类定义：
- 政治：政府政策、法律、监管、外交、政局、公共治理。
- 汽车：汽车市场、销量、车型、车企布局、生产投资、新能源、充电、智能座舱、智能驾驶。
- 科技：AI、LLM、ASR、TTS、AI Agent、芯片、半导体、技术平台与重要技术产品。
- 文化：语言、宗教、节日、社会文化变化、社会舆情、文化习惯、本土化风险。
- 娱乐：影视、音乐、明星、演唱会、电影节、音乐节、票房、流媒体、娱乐消费趋势。

如果核心事件明显属于其他分类，必须淘汰。

【排序因素】
在通过国家相关性和分类准确性后，再比较：
1. 信源质量：政府/官方机构、Reuters/AP等权威媒体、当地主流媒体、权威行业媒体优先。
2. 时效性：过去24小时优先，72小时内次之，超过7天原则上不选。
3. 类内重要性：优先选择对市场、产业、技术、监管或社会趋势影响更大的新闻。
4. 重复事件：同一事件只保留信源质量最高的一条。

【禁止事项】
- 不得添加 title 和 content 中不存在的事实。
- 不得把一条候选新闻的信息写进另一条新闻的 reason。
- 不得为了凑够 Top ${TOP_N_PER_CATEGORY} 选择分类错误、信源差或价值低的新闻。

【输出】
只返回 JSON 数组，不要 Markdown，不要解释分析过程。
格式：
[
  {
    "id": 0,
    "score": 95,
    "reason": "一句简短原因"
  }
]

score 范围 0～100。
reason 只说明该新闻为什么在“${category}”分类中值得入选。
如果真正值得推送的新闻不足 ${TOP_N_PER_CATEGORY} 条，可以少于 ${TOP_N_PER_CATEGORY} 条或返回空数组。

候选新闻：
${JSON.stringify(candidates)}
`;
}

function extractText(payload) {
  const choice = payload?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return null;
}

function cleanJson(text = "") {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableRankError(message = "") {
  const text = String(message);
  if (/\b401\b/.test(text) || /\b403\b/.test(text)) return false;
  return /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|socket|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|接口返回不是JSON|Ranker输出不是合法JSON|Ranker结果不是数组|无法获得模型输出/i.test(text);
}

async function rankCategory(category, newsList) {
  if (newsList.length === 0) return [];

  const compactCandidates = buildCompactCandidates(newsList);
  const requestBody = {
    model: analysisModel,
    messages: [
      {
        role: "system",
        content: "你是全球市场新闻编辑，只负责从候选新闻中进行筛选和排序。",
      },
      {
        role: "user",
        content: buildRankingPrompt(category, compactCandidates),
      },
    ],
    temperature: 0.1,
    max_tokens: 2000,
  };

  if (analysisModel.toLowerCase().includes("spark")) {
    requestBody.thinking = { type: "disabled" };
  }

  let ranking;

  for (let attempt = 1; attempt <= RANK_MAX_RETRIES + 1; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${analysisApiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`${category} Ranker请求失败 ${response.status}:\n${responseText}`);
      }

      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`${category}接口返回不是JSON:\n${responseText}`);
      }

      rankerTokenUsage.record(payload);
      const modelText = extractText(payload);
      if (!modelText) throw new Error(`${category}无法获得模型输出`);

      try {
        ranking = JSON.parse(cleanJson(modelText));
      } catch {
        throw new Error(`${category} Ranker输出不是合法JSON:\n${modelText}`);
      }

      if (!Array.isArray(ranking)) {
        throw new Error(`${category} Ranker结果不是数组`);
      }

      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = attempt <= RANK_MAX_RETRIES && isRetryableRankError(message);
      if (!canRetry) throw error;
      await sleep(RANK_RETRY_DELAY_MS);
    }
  }

  const selected = [];
  const usedIds = new Set();

  for (const result of ranking) {
    const id = Number(result.id);
    if (!Number.isInteger(id) || id < 0 || id >= newsList.length || usedIds.has(id)) {
      continue;
    }

    usedIds.add(id);
    selected.push({
      ...newsList[id],
      rankScore: Number(result.score || 0),
      rankReason: String(result.reason || "").trim(),
    });

    if (selected.length >= TOP_N_PER_CATEGORY) break;
  }

  selected.sort((a, b) => b.rankScore - a.rankScore);
  return selected;
}

export async function rankNews() {
  const filteredNews = await loadFilteredNews();
  const rankedNews = [];

  for (const category of CATEGORIES) {
    const categoryNews = filteredNews.filter((news) => news.category === category);

    try {
      rankedNews.push(...(await rankCategory(category, categoryNews)));
    } catch (error) {
      console.error(`${category} Rank失败：${error?.message || String(error)}`);
    }
  }

  rankerTokenUsage.print();

  await writeFile(
    OUTPUT_FILE,
    JSON.stringify(rankedNews, null, 2),
    "utf-8"
  );

  return rankedNews;
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  rankNews()
    .then((rankedNews) => console.log(`Rank完成：${rankedNews.length} 条`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

