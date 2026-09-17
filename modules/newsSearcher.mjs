import dotenv from "dotenv";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

dotenv.config();

const SOURCES_FILE = new URL("../config/baiduSearchSources.json", import.meta.url);
const DEFAULT_OUTPUT_FILE = new URL("../data/candidate-news.json", import.meta.url);
const DEFAULT_PROGRESS_FILE = new URL("../data/collector-progress.json", import.meta.url);
const REQUEST_TIMEOUT_MS = Number(process.env.BAIDU_SEARCH_TIMEOUT_MS || 30_000);
const MAX_FETCH_ATTEMPTS = Number(process.env.BAIDU_SEARCH_MAX_ATTEMPTS || 2);
const RETRY_DELAY_MS = Number(process.env.BAIDU_SEARCH_RETRY_DELAY_MS || 1_500);
const REQUEST_DELAY_MS = Number(process.env.BAIDU_SEARCH_REQUEST_DELAY_MS || 1_500);
const REQUEST_JITTER_MS = Number(process.env.BAIDU_SEARCH_REQUEST_JITTER_MS || 1_500);
const MAX_ITEMS_PER_QUERY = Number(process.env.BAIDU_SEARCH_MAX_ITEMS || 10);
const MAX_AGE_DAYS = Number(process.env.BAIDU_SEARCH_MAX_AGE_DAYS || 7);

const BAIDU_RATE_LIMITED = "BAIDU_RATE_LIMITED";

const CATEGORY_QUERIES = {
  政治: ["政治"],
  汽车: ["汽车"],
  科技: ["科技"],
  文化: ["文化"],
  娱乐: ["娱乐"],
};

const CATEGORY_TERMS = {
  政治: /政治|政府|外交|选举|政策|法规|议会|总理|总统|部长/i,
  汽车: /汽车|新能源汽车|电动车|电动汽车|自动驾驶|智能座舱|电池|充电|车企|车辆/i,
  科技: /科技|人工智能|AI|大模型|机器学习|半导体|芯片|晶圆|数据中心|算力|云计算|机器人|5G|通信|软件|数字化|网络安全/i,
  文化: /文化|教育|语言|宗教|遗产|博物馆|艺术|传统|历史/i,
  娱乐: /娱乐|电影|音乐|电视剧|明星|演员|演唱会|游戏|电竞|票房/i,
};

function decodeHtml(value = "") {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(value = "") {
  return decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getBeijingDateParts(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
}

export function parseBaiduDate(value, now = new Date()) {
  const text = stripHtml(value);
  const parts = getBeijingDateParts(now);
  let match;
  if (!text) return "";
  if (/刚刚/.test(text)) return now.toISOString();
  if ((match = text.match(/(\d+)\s*分钟前/))) return new Date(now.getTime() - Number(match[1]) * 60_000).toISOString();
  if ((match = text.match(/(\d+)\s*小时前/))) return new Date(now.getTime() - Number(match[1]) * 3_600_000).toISOString();
  if ((match = text.match(/(\d+)\s*天前/))) return new Date(now.getTime() - Number(match[1]) * 86_400_000).toISOString();
  if (/前天/.test(text)) return new Date(now.getTime() - 2 * 86_400_000).toISOString();
  if (/昨天/.test(text)) return new Date(now.getTime() - 86_400_000).toISOString();
  if ((match = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)).toISOString();
  }
  if ((match = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) {
    return new Date(Date.UTC(parts.year, Number(match[1]) - 1, Number(match[2]), 12)).toISOString();
  }
  return "";
}

function isRecent(value, now = new Date()) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  const ageDays = (now.getTime() - time) / 86_400_000;
  return ageDays >= -1 && ageDays <= MAX_AGE_DAYS;
}

function normalizeTitle(value = "") {
  return stripHtml(value).toLowerCase().replace(/[\s，。！？、；：“”‘’"'（）()【】[\]<>:：\-—_]/g, "");
}

function containsCountry(text, source) {
  return (source.aliases || [source.country]).some(alias => text.includes(alias));
}

function isRelevant(item, source, category) {
  const text = `${item.title} ${item.content}`;
  // “国泰国证”等词会把“泰国”作为机构名称的一部分，不能算泰国新闻。
  if (source.country === "泰国" && /国泰国证/.test(text)) return false;
  return containsCountry(text, source) && CATEGORY_TERMS[category].test(text);
}

export function parseBaiduResults(html, { source, category, query, searchUrl, now = new Date() }) {
  const results = [];
  const seenUrls = new Set();
  for (const match of String(html).matchAll(/<!--s-data:(\{[\s\S]*?\})-->/g)) {
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    if (!data?.title || !data?.titleUrl || !data?.summary || !data?.sourceName) continue;
    const title = stripHtml(data.title);
    const content = stripHtml(data.summary);
    const url = decodeHtml(data.titleUrl).trim();
    if (!title || !content || !/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
    const publishedAt = parseBaiduDate(data.dispTime, now);
    const item = { title, content, source: stripHtml(data.sourceName), publishedAt };
    if (!publishedAt || !isRecent(publishedAt, now) || !isRelevant(item, source, category)) continue;
    seenUrls.add(url);
    results.push({
      region: source.region,
      country: source.country,
      category,
      title,
      content,
      source: item.source,
      publishedAt,
      url,
      sourceType: "baidu-news",
      provider: "baidu",
      searchQuery: query,
      searchUrl,
    });
    if (results.length >= MAX_ITEMS_PER_QUERY) break;
  }
  return results;
}

function makeSearchUrl(query) {
  const url = new URL("https://www.baidu.com/s");
  url.searchParams.set("tn", "news");
  url.searchParams.set("rtt", "4");
  url.searchParams.set("bsst", "1");
  url.searchParams.set("cl", "2");
  url.searchParams.set("wd", query);
  return url.href;
}

async function fetchSearchPage(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      const html = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!/<!--s-data:\{/.test(html)) {
        const error = new Error("Baidu structured records not found");
        error.code = BAIDU_RATE_LIMITED;
        throw error;
      }
      return html;
    } catch (error) {
      lastError = error;
      const detail = error?.cause?.code || error?.message || String(error);
      const retryable = /fetch failed|timeout|abort|UND_ERR|ECONN|HTTP 429|HTTP 5\d\d/i.test(detail);
      if (!retryable || attempt === MAX_FETCH_ATTEMPTS) break;
      console.warn(`Baidu ${url}: attempt ${attempt} failed (${detail}), retrying...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError?.code === BAIDU_RATE_LIMITED) throw lastError;
  throw new Error(lastError?.cause?.code || lastError?.message || String(lastError));
}

function deduplicate(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  return items.filter(item => {
    const title = normalizeTitle(item.title);
    if (seenUrls.has(item.url) || seenTitles.has(title)) return false;
    seenUrls.add(item.url);
    seenTitles.add(title);
    return true;
  });
}

function getRequestDelayMs() {
  const jitter =
    REQUEST_JITTER_MS > 0
      ? Math.floor(Math.random() * (REQUEST_JITTER_MS + 1))
      : 0;
  return REQUEST_DELAY_MS + jitter;
}

export async function collectBaiduNews({
  outputFile = DEFAULT_OUTPUT_FILE,
  progressFile = DEFAULT_PROGRESS_FILE,
  resume = false,
  batchIndex,
  initialNews = [],
  countries,
  categories = Object.keys(CATEGORY_QUERIES),
} = {}) {
  const configuredSources = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  const selectedSources = countries?.length
    ? configuredSources.filter(source => countries.includes(source.country))
    : configuredSources;
  const tasks = selectedSources.flatMap(source =>
    categories.flatMap(category =>
      (CATEGORY_QUERIES[category] || []).map(keyword => ({
        source,
        category,
        keyword,
      })),
    ),
  );
  const taskSignature = JSON.stringify(
    tasks.map(({ source, category, keyword }) => [source.country, category, keyword]),
  );
  let allNews = Array.isArray(initialNews) ? initialNews : [];
  let report = [];
  let startTaskIndex = 0;
  let requestCount = 0;

  await mkdir(new URL("./", outputFile), { recursive: true });

  async function saveCheckpoint(nextTaskIndex) {
    const newsList = deduplicate(allNews);
    await writeFile(outputFile, JSON.stringify(newsList, null, 2), "utf8");
    await writeFile(
      progressFile,
      JSON.stringify(
        {
          version: 1,
          ...(Number.isInteger(batchIndex) ? { batchIndex } : {}),
          taskSignature,
          nextTaskIndex,
          newsList,
          report,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return newsList;
  }

  if (resume) {
    try {
      const progress = JSON.parse(await readFile(progressFile, "utf8"));
      if (
        progress?.version !== 1 ||
        progress?.taskSignature !== taskSignature ||
        (Number.isInteger(batchIndex) && progress?.batchIndex !== batchIndex) ||
        !Number.isInteger(progress?.nextTaskIndex) ||
        !Array.isArray(progress?.newsList) ||
        !Array.isArray(progress?.report)
      ) {
        throw new Error("Collector progress does not match the current search tasks");
      }
      startTaskIndex = progress.nextTaskIndex;
      allNews = progress.newsList;
      report = progress.report;
      console.log(
        `Resuming Baidu collection at task ${startTaskIndex + 1}/${tasks.length} with ${allNews.length} saved candidates`,
      );
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("Collector progress file was not found");
      throw error;
    }
  } else {
    await unlink(progressFile).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
    await saveCheckpoint(0);
  }

  for (let taskIndex = startTaskIndex; taskIndex < tasks.length; taskIndex += 1) {
    const { source, category, keyword } = tasks[taskIndex];
    if (requestCount > 0 && REQUEST_DELAY_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, getRequestDelayMs()));
    }
    requestCount += 1;

    const query = `${source.country} ${keyword}`;
    const searchUrl = makeSearchUrl(query);
    try {
      const html = await fetchSearchPage(searchUrl);
      const items = parseBaiduResults(html, { source, category, query, searchUrl });
      allNews.push(...items);
      report.push({ source: source.country, category, keyword, status: "ok", count: items.length });
      console.log(`Baidu ${source.country} / ${keyword}: ${items.length} items`);
      await saveCheckpoint(taskIndex + 1);
    } catch (error) {
      if (error?.code === BAIDU_RATE_LIMITED) {
        await saveCheckpoint(taskIndex);
        console.warn(
          `Baidu ${source.country} / ${keyword}: suspected rate limit; restarting collector process`,
        );
        throw error;
      }

      report.push({ source: source.country, category, keyword, status: "error", error: error.message });
      console.warn(`Baidu ${source.country} / ${keyword}: ${error.message}`);
      await saveCheckpoint(taskIndex + 1);
    }
  }

  const newsList = deduplicate(allNews);
  if (!newsList.length) throw new Error("No recent Baidu news was collected");
  await writeFile(outputFile, JSON.stringify(newsList, null, 2), "utf8");
  await unlink(progressFile).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
  return { newsList, report };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = await collectBaiduNews();
    console.log(`Baidu collection complete: ${result.newsList.length} items`);
    console.log(`Output: ${DEFAULT_OUTPUT_FILE.pathname}`);
  } catch (error) {
    console.error(`Baidu collection failed: ${error.message}`);
    process.exitCode = 1;
  }
}

