import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config();

const CATEGORIES = ["政治", "汽车", "科技", "文化", "娱乐"];
const MAX_NEWS_PER_CATEGORY = 5;

const PROCESSED_NEWS_FILE = new URL(
  "../data/processed-news.json",
  import.meta.url
);

const webhook = process.env.FEISHU_WEBHOOK;
const secret = process.env.FEISHU_SECRET;

if (!webhook || !secret) {
  throw new Error("缺少 FEISHU_WEBHOOK 或 FEISHU_SECRET");
}

function formatReportDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);

  const result = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );

  return `${result.year}${result.month}${result.day}`;
}

function cleanUrl(url = "") {
  const value = String(url).trim();
  const markdownMatch = value.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/);
  return markdownMatch ? markdownMatch[1] : value;
}

async function loadProcessedNews() {
  console.log("正在读取 processed-news.json...");
  const text = await readFile(PROCESSED_NEWS_FILE, "utf-8");
  const newsList = JSON.parse(text);

  if (!Array.isArray(newsList)) {
    throw new Error("processed-news.json 必须是数组");
  }

  console.log(`读取到 ${newsList.length} 条处理结果`);
  return newsList;
}

function buildCardNews(newsList) {
  return newsList.map((news) => ({
    region: news.region,
    country: news.country,
    category: news.category,
    title: news.title,
    summary: String(news.summary || news.content || news.title || "").trim(),
    businessImpact: String(news.businessImpact || news.rankReason || "").trim(),
    rankScore: Number(news.rankScore || 0),
    source: news.source || "未知",
    publishedAt: news.publishedAt || "未知",
    url: cleanUrl(news.url),
  }));
}

function renderNewsItem(news, index) {
  const title = news.url ? `[${news.title}](${news.url})` : news.title;

  return (
    `**${index + 1}. ${news.country}｜${title}**\n` +
    `**摘要：** ${news.summary}\n` +
    `**业务价值：** ${news.businessImpact}\n` +
    `**来源：** ${news.source}｜${news.publishedAt}`
  );
}

function buildCategoryElement(category, newsList) {
  const selectedNews = newsList
    .filter((news) => news.category === category)
    .slice(0, MAX_NEWS_PER_CATEGORY);

  const content = selectedNews.length > 0
    ? selectedNews.map(renderNewsItem).join("\n\n")
    : "*今日暂无入选新闻*";

  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content: `### 【${category}】\n${content}`,
    },
  };
}

function buildNewsCard(newsList) {
  if (!Array.isArray(newsList)) {
    throw new Error("newsList 必须是数组");
  }

  const invalidNews = newsList.find(
    (news) => !CATEGORIES.includes(news.category)
  );

  if (invalidNews) {
    throw new Error(`不支持的新闻分类：${invalidNews.category}`);
  }

  const selectedCount = CATEGORIES.reduce((total, category) => {
    const count = newsList.filter((news) => news.category === category).length;
    return total + Math.min(count, MAX_NEWS_PER_CATEGORY);
  }, 0);

  const elements = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          "**五大分类｜15个重点国家**\n" +
          `今日共入选 **${selectedCount}** 条重点资讯\n`,
      },
    },
    { tag: "hr" },
  ];

  CATEGORIES.forEach((category, index) => {
    elements.push(buildCategoryElement(category, newsList));
    if (index < CATEGORIES.length - 1) elements.push({ tag: "hr" });
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: `${formatReportDate()} 全球重点市场资讯`,
      },
    },
    elements,
  };
}

console.log("==============================");
console.log("开始生成全球重点市场资讯卡片");
console.log("==============================");

const processedNews = await loadProcessedNews();

if (processedNews.length === 0) {
  throw new Error("没有可发送的新闻，停止发送空卡片");
}

const selectedNews = buildCardNews(processedNews);
console.log(`准备推送 ${selectedNews.length} 条新闻`);

const card = buildNewsCard(selectedNews);
const timestamp = Math.floor(Date.now() / 1000).toString();
const stringToSign = `${timestamp}\n${secret}`;
const sign = crypto
  .createHmac("sha256", stringToSign)
  .digest("base64");

const body = {
  timestamp,
  sign,
  msg_type: "interactive",
  card,
};

console.log("正在发送到 Feishu/Lark Webhook...");

const response = await fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const responseText = await response.text();
console.log("Webhook 返回：");
console.log(responseText);

if (!response.ok) {
  throw new Error(`卡片发送失败：${response.status}`);
}

console.log("==============================");
console.log("卡片发送完成");
console.log("==============================");

