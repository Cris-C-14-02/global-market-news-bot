import { spawn } from "node:child_process";
import { mkdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOG_DIR = fileURLToPath(new URL("../logs/", import.meta.url));

await mkdir(LOG_DIR, { recursive: true });

const timestamp = new Date()
  .toISOString()
  .replace(/:/g, "-")
  .replace(/\..+/, "");

const LOG_FILE = `${LOG_DIR}run-${timestamp}.log`;

async function log(text) {
  console.log(text);
  await appendFile(LOG_FILE, `${text}\n`, "utf-8");
}

const STEPS = [
  { name: "新闻搜索", script: "./modules/newsCollector.mjs" },
  { name: "新闻过滤", script: "./modules/newsFilter.mjs" },
  { name: "新闻排序", script: "./modules/newsRanker.mjs" },
  { name: "中文摘要与业务分析", script: "./modules/newsProcessor.mjs" },
  { name: "Webhook 推送", script: "./modules/send-card.mjs" },
];

async function runStep(step) {
  await log("");
  await log(`===== ${step.name} =====`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [step.script], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", async (data) => {
      const text = data.toString();
      process.stdout.write(text);
      await appendFile(LOG_FILE, text, "utf-8");
    });

    child.stderr.on("data", async (data) => {
      const text = data.toString();
      process.stderr.write(text);
      await appendFile(LOG_FILE, text, "utf-8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${step.name}执行失败，退出码：${code}`));
    });
  });
}

async function main() {
  await log("======================================");
  await log("全球重点市场资讯机器人开始运行");
  await log(`启动时间：${new Date().toLocaleString("zh-CN")}`);
  await log("======================================");

  for (const step of STEPS) {
    await runStep(step);
  }

  await log("");
  await log("======================================");
  await log("全部流程执行成功");
  await log(`完成时间：${new Date().toLocaleString("zh-CN")}`);
  await log("======================================");
}

main().catch(async (error) => {
  await log("");
  await log("自动运行失败");
  await log(error.message);
  process.exitCode = 1;
});

