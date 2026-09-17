import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const INPUT_FILE = new URL("../data/candidate-news.json", import.meta.url);
const OUTPUT_FILE = new URL("../data/filtered-news.json", import.meta.url);
const MAX_AGE_DAYS = 7;
const URL_VERIFY_TIMEOUT_MS = 8_000;
const URL_VERIFY_CONCURRENCY = 8;

function normalizeUrl(value = "") {
  return String(value).trim().replace(/\/$/, "");
}

function normalizeTitle(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：“”‘’"'（）()【】[\]\-—_:：]/g, "");
}

function parseHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function beijingDayNumber(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)])
  );

  return Date.UTC(values.year, values.month - 1, values.day) / 86_400_000;
}

function isRecentNews(publishedAt, now = new Date()) {
  const publishedDay = beijingDayNumber(publishedAt);
  const currentDay = beijingDayNumber(now);
  if (publishedDay === null || currentDay === null) return false;

  const ageDays = currentDay - publishedDay;
  return ageDays >= -1 && ageDays <= MAX_AGE_DAYS;
}

export function filterNews(newsList, now = new Date()) {
  if (!Array.isArray(newsList)) {
    throw new Error("filterNews 输入必须是新闻数组");
  }

  const seenUrls = new Set();
  const seenTitles = new Set();
  const result = [];

  for (const news of newsList) {
    if (
      !news?.title ||
      !parseHttpUrl(news.url) ||
      !isRecentNews(news.publishedAt, now)
    ) {
      continue;
    }

    const url = normalizeUrl(news.url);
    const title = normalizeTitle(news.title);
    if (!title || seenUrls.has(url) || seenTitles.has(title)) continue;

    seenUrls.add(url);
    seenTitles.add(title);
    result.push(news);
  }

  return result;
}

export async function verifyUrl(urlValue) {
  const parsedUrl = parseHttpUrl(urlValue);
  if (!parsedUrl) {
    return {
      status: "invalid",
      reason: "URL格式不合法",
      httpStatus: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(parsedUrl.href, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      },
    });

    if (response.status === 404 || response.status === 410) {
      return {
        status: "invalid",
        reason: "HTTP " + response.status,
        httpStatus: response.status,
      };
    }

    return {
      status: "valid",
      reason: "HTTP " + response.status + "，非404/410",
      httpStatus: response.status,
    };
  } catch (error) {
    const detail =
      error?.cause?.code ||
      error?.code ||
      error?.name ||
      error?.message ||
      "网络请求失败";

    return {
      status: "valid",
      reason: "核验失败但按宽松策略保留：" + detail,
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function verifyNewsUrls(newsList) {
  console.log("");
  console.log("开始核验 " + newsList.length + " 个URL...");
  console.log("并发数：" + URL_VERIFY_CONCURRENCY);
  console.log("单个URL超时：" + URL_VERIFY_TIMEOUT_MS / 1000 + "秒");

  const checkedItems = await mapWithConcurrency(
    newsList,
    URL_VERIFY_CONCURRENCY,
    async news => ({
      news,
      verification: await verifyUrl(news.url),
    })
  );

  const keptNews = [];
  const removedItems = [];
  let uncertainKept = 0;

  for (const { news, verification } of checkedItems) {
    if (verification.status === "invalid") {
      removedItems.push({
        country: news.country,
        category: news.category,
        title: news.title,
        url: news.url,
        reason: verification.reason,
      });
      continue;
    }

    if (verification.httpStatus === null) uncertainKept += 1;
    keptNews.push(news);
  }

  return {
    newsList: keptNews,
    removedItems,
    stats: {
      kept: keptNews.length,
      removed: removedItems.length,
      uncertainKept,
    },
  };
}

export async function runNewsFilter() {
  console.log("正在读取 candidate-news.json...");

  const candidateNews = JSON.parse(await readFile(INPUT_FILE, "utf8"));
  if (!Array.isArray(candidateNews)) {
    throw new Error("candidate-news.json 必须是数组");
  }

  console.log("原始候选新闻：" + candidateNews.length + " 条");

  const deduplicatedNews = filterNews(candidateNews);
  console.log("7天时效、格式和去重后：" + deduplicatedNews.length + " 条");
  console.log(
    "过期、格式异常或重复：" +
      (candidateNews.length - deduplicatedNews.length) +
      " 条"
  );

  if (typeof fetch !== "function") {
    throw new Error("当前Node.js未启用fetch，无法执行URL核验");
  }

  const urlResult = await verifyNewsUrls(deduplicatedNews);
  const filteredNews = urlResult.newsList;

  console.log("");
  console.log("==============================");
  console.log("URL核验结果");
  console.log("==============================");
  console.log("非404/410并保留：" + urlResult.stats.kept + " 条");
  console.log("明确404/410并过滤：" + urlResult.stats.removed + " 条");
  console.log("网络异常但保留：" + urlResult.stats.uncertainKept + " 条");
  console.log("最终保留：" + filteredNews.length + " 条");

  if (urlResult.removedItems.length > 0) {
    console.log("");
    console.log("已过滤URL：");
    for (const item of urlResult.removedItems) {
      console.log("- " + item.country + "｜" + item.category + "｜" + item.title);
      console.log("  原因：" + item.reason);
      console.log("  URL：" + item.url);
    }
  }

  const distribution = {};
  for (const news of filteredNews) {
    const key = news.country + "｜" + news.category;
    distribution[key] = (distribution[key] || 0) + 1;
  }

  console.log("");
  console.log("过滤后分布：");
  for (const [key, count] of Object.entries(distribution)) {
    console.log(key + "：" + count + " 条");
  }

  await writeFile(OUTPUT_FILE, JSON.stringify(filteredNews, null, 2), "utf8");
  console.log("");
  console.log("过滤完成：data/filtered-news.json");
  return filteredNews;
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    await runNewsFilter();
  } catch (error) {
    console.error("\n新闻过滤失败：");
    console.error(error);
    process.exitCode = 1;
  }
}

