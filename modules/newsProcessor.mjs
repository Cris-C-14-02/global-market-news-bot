import dotenv from "dotenv";
import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createTokenUsageTracker } from "./tokenUsage.mjs";

dotenv.config();

const processorTokenUsage = createTokenUsageTracker("Processor");
const PROCESSOR_MAX_RETRIES = 1;
const PROCESSOR_RETRY_DELAY_MS = 3000;

const requiredEnv = ["ANALYSIS_API_KEY", "ANALYSIS_BASE_URL", "ANALYSIS_MODEL"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  throw new Error(`缺少环境变量: ${missingEnv.join(", ")}。请检查 .env 文件。`);
}

const analysisApiKey = process.env.ANALYSIS_API_KEY;
const analysisBaseUrl = process.env.ANALYSIS_BASE_URL;
const analysisModel = process.env.ANALYSIS_MODEL;
const analysisEndpoint = `${analysisBaseUrl.replace(/\/$/, "")}/chat/completions`;

const RANKED_NEWS_FILE = new URL("../data/ranked-news.json", import.meta.url);
const PROCESSED_NEWS_FILE = new URL("../data/processed-news.json", import.meta.url);

export const defaultTestNews = {
  region: "东南亚",
  country: "泰国",
  category: "汽车",
  title: "Chinese EV brand plans to expand local production in Thailand",
  content:
    "A Chinese electric vehicle company plans to expand production capacity in Thailand. This content is only for API testing and is not real news.",
  source: "测试新闻源",
  publishedAt: "2026-08-05",
  url: "https://example.com/test-news",
  rankReason: "该新闻涉及汽车产业与当地市场动态。",
  rankScore: 90,
};

export function buildPrompt(news = defaultTestNews) {
  return `
请根据下面的新闻生成中文摘要和业务价值，并只返回严格 JSON。

规则：
1. 只返回 JSON，不要返回 Markdown，不要添加解释。
2. summary 必须是1～2句简体中文，忠实概括原新闻；英文原文必须翻译成中文。
3. summary 只写新闻事实，不要混入业务分析。
4. businessImpact 必须是1句简体中文，从跨境产品、市场研究或国际化业务视角说明为什么值得关注。
5. 业务价值可关注市场进入、用户需求、竞争格局、AI应用、汽车产业、数据合规和本土化，但只能写与新闻实际相关的内容。
6. 保留原文中的机构、人名、日期和数字，不得编造原文中不存在的信息。

返回格式：
{
  "summary": "",
  "businessImpact": ""
}

新闻信息：
区域：${news.region || ""}
国家：${news.country || ""}
分类：${news.category || ""}
标题：${news.title || ""}
正文：${news.content || news.title || ""}
来源：${news.source || ""}
发布时间：${news.publishedAt || ""}
排序理由：${news.rankReason || ""}
`;
}

export function buildRequestBody(news = defaultTestNews) {
  const requestBody = {
    model: analysisModel,
    messages: [
      {
        role: "system",
        content: "你是全球市场资讯编辑，负责忠实翻译新闻摘要并生成简洁的业务价值说明。",
      },
      { role: "user", content: buildPrompt(news) },
    ],
    temperature: 0.1,
    max_tokens: 800,
  };

  if (analysisModel.toLowerCase().includes("spark")) {
    requestBody.thinking = { type: "disabled" };
  }

  return requestBody;
}

export function extractTextFromResponse(payload) {
  const choice = payload?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return null;
}

export function cleanJson(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export function validateStructuredOutput(parsed, news = defaultTestNews) {
  const summary = String(parsed?.summary || "").trim();
  const businessImpact = String(parsed?.businessImpact || "").trim();

  if (!summary) throw new Error("模型输出缺少 summary");
  if (!businessImpact) throw new Error("模型输出缺少 businessImpact");

  return { ...news, summary, businessImpact };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableProcessorError(message = "") {
  const text = String(message);
  if (/LLM请求失败 401\b/i.test(text) || /LLM请求失败 403\b/i.test(text)) {
    return false;
  }

  return (
    /fetch failed|ETIMEDOUT|timeout|AbortError|ECONNRESET|ENOTFOUND|network|socket/i.test(text) ||
    /LLM请求失败 (429|500|502|503|504)\b/i.test(text) ||
    /接口返回不是JSON|无法解析模型输出|模型输出不是合法JSON|模型输出缺少 summary|模型输出缺少 businessImpact/i.test(text)
  );
}

export async function processNews(news = defaultTestNews) {
  const requestBody = buildRequestBody(news);

  for (let attempt = 1; attempt <= PROCESSOR_MAX_RETRIES + 1; attempt += 1) {
    try {
      const response = await fetch(analysisEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${analysisApiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(120_000),
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`LLM请求失败 ${response.status}:\n${responseText}`);
      }

      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(`接口返回不是JSON:\n${responseText}`);
      }

      processorTokenUsage.record(payload);
      const modelText = extractTextFromResponse(payload);
      if (!modelText) throw new Error(`无法解析模型输出:\n${responseText}`);

      let parsedOutput;
      try {
        parsedOutput = JSON.parse(cleanJson(modelText));
      } catch {
        throw new Error(`模型输出不是合法JSON:\n${modelText}`);
      }

      return validateStructuredOutput(parsedOutput, news);
    } catch (error) {
      const message = getErrorMessage(error);
      const canRetry =
        attempt <= PROCESSOR_MAX_RETRIES && isRetryableProcessorError(message);

      if (!canRetry) throw error;
      console.warn(`Processor第 ${attempt} 次处理失败，将在 ${PROCESSOR_RETRY_DELAY_MS / 1000} 秒后重试`);
      await sleep(PROCESSOR_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Processor处理失败：${news.country}｜${news.title}`);
}

export async function processRankedNews() {
  const text = await readFile(RANKED_NEWS_FILE, "utf-8");
  const rankedNews = JSON.parse(text);

  if (!Array.isArray(rankedNews)) throw new Error("ranked-news.json 必须是数组");
  if (rankedNews.length === 0) throw new Error("ranked-news.json 中没有新闻");

  const processedNews = [];

  try {
    for (const news of rankedNews) {
      processedNews.push(await processNews(news));
    }
  } finally {
    processorTokenUsage.print();
  }

  await writeFile(
    PROCESSED_NEWS_FILE,
    JSON.stringify(processedNews, null, 2),
    "utf-8"
  );

  return processedNews;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  processRankedNews()
    .then((processedNews) => {
      console.log(`处理完成：${processedNews.length} 条`);
    })
    .catch((error) => {
      console.error(error?.message || String(error));
      process.exitCode = 1;
    });
}

