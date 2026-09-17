import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { collectBaiduNews } from "./newsSearcher.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const COLLECTOR_SCRIPT = fileURLToPath(import.meta.url);
const OUTPUT_FILE = new URL("../data/candidate-news.json", import.meta.url);
const SEARCH_PROGRESS_FILE = new URL("../data/collector-progress.json", import.meta.url);
const BATCH_STATE_FILE = new URL("../data/collector-batch-progress.json", import.meta.url);
const BATCH_DELAY_MS = Number(
  process.env.BAIDU_SEARCH_BATCH_DELAY_MS ||
    process.env.BAIDU_SEARCH_PROCESS_RESTART_DELAY_MS ||
    10 * 60_000,
);
const RATE_LIMIT_EXIT_CODE = 75;
const RATE_LIMIT_ERROR_CODE = "BAIDU_RATE_LIMITED";

const COLLECTION_BATCHES = [
  { name: "东南亚", countries: ["泰国", "印度尼西亚", "马来西亚"] },
  { name: "中东", countries: ["阿联酋", "沙特阿拉伯"] },
  { name: "大洋洲+欧洲英国德国", countries: ["澳大利亚", "英国", "德国"] },
  { name: "欧洲意大利葡萄牙西班牙", countries: ["意大利", "葡萄牙", "西班牙"] },
  { name: "俄罗斯及独联体", countries: ["俄罗斯", "哈萨克斯坦"] },
  { name: "拉美", countries: ["巴西", "墨西哥"] },
];

function isWorkerProcess() {
  return process.argv.includes("--worker");
}

function hasResumeFlag() {
  return process.argv.includes("--resume");
}

function getBatchIndex() {
  const position = process.argv.indexOf("--batch-index");
  if (position === -1) return null;
  const value = Number(process.argv[position + 1]);
  return Number.isInteger(value) ? value : null;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function readExistingCandidates() {
  try {
    const candidates = await readJson(OUTPUT_FILE);
    return Array.isArray(candidates) ? candidates : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeBatchState(nextBatchIndex, { resume = false } = {}) {
  await writeFile(
    BATCH_STATE_FILE,
    JSON.stringify(
      {
        version: 1,
        nextBatchIndex,
        resume,
        batchCount: COLLECTION_BATCHES.length,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function clearBatchState() {
  await unlink(BATCH_STATE_FILE).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function getResumePoint() {
  try {
    const state = await readJson(BATCH_STATE_FILE);
    if (
      state?.version === 1 &&
      Number.isInteger(state.nextBatchIndex) &&
      state.nextBatchIndex >= 0 &&
      state.nextBatchIndex <= COLLECTION_BATCHES.length
    ) {
      return {
        batchIndex: state.nextBatchIndex,
        resume: state.resume === true,
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    const progress = await readJson(SEARCH_PROGRESS_FILE);
    if (
      progress?.version === 1 &&
      Number.isInteger(progress.batchIndex) &&
      progress.batchIndex >= 0 &&
      progress.batchIndex < COLLECTION_BATCHES.length
    ) {
      return {
        batchIndex: progress.batchIndex,
        resume: true,
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  console.warn("未找到新的六批采集断点，将从第一批开始新采集");
  return {
    batchIndex: 0,
    resume: false,
  };
}

function runCollectorWorker({ batchIndex, resume }) {
  return new Promise((resolve, reject) => {
    const args = [COLLECTOR_SCRIPT, "--worker", "--batch-index", String(batchIndex)];
    if (resume) args.push("--resume");

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", code => resolve(code));
  });
}

export async function runNewsCollector({ resume = hasResumeFlag() } = {}) {
  const startedAt = Date.now();
  let batchIndex;
  let shouldResume;

  if (resume) {
    ({ batchIndex, resume: shouldResume } = await getResumePoint());
  } else {
    await clearBatchState();
    batchIndex = 0;
    shouldResume = false;
  }

  if (batchIndex === COLLECTION_BATCHES.length) {
    await clearBatchState();
    const newsList = await readExistingCandidates();
    return {
      newsList,
      report: [],
      durationSeconds: ((Date.now() - startedAt) / 1000).toFixed(1),
    };
  }

  while (batchIndex < COLLECTION_BATCHES.length) {
    const batch = COLLECTION_BATCHES[batchIndex];
    console.log(
      `Starting collection batch ${batchIndex + 1}/${COLLECTION_BATCHES.length}: ${batch.name}`,
    );

    const exitCode = await runCollectorWorker({
      batchIndex,
      resume: shouldResume,
    });

    if (exitCode === 0) {
      const nextBatchIndex = batchIndex + 1;
      await writeBatchState(nextBatchIndex);

      if (nextBatchIndex >= COLLECTION_BATCHES.length) {
        await clearBatchState();
        const newsList = await readExistingCandidates();
        return {
          newsList,
          report: [],
          durationSeconds: ((Date.now() - startedAt) / 1000).toFixed(1),
        };
      }

      console.log(
        `Collection batch ${batchIndex + 1}/${COLLECTION_BATCHES.length} complete. Waiting ${Math.round(
          BATCH_DELAY_MS / 60_000,
        )} minutes before the next batch...`,
      );
      await wait(BATCH_DELAY_MS);
      batchIndex = nextBatchIndex;
      shouldResume = false;
      continue;
    }

    if (exitCode !== RATE_LIMIT_EXIT_CODE) {
      throw new Error(`新闻采集批次“${batch.name}”退出码：${exitCode}`);
    }

    await writeBatchState(batchIndex, { resume: true });
    shouldResume = true;
    console.warn(
      `Baidu rate limit detected in batch “${batch.name}”. The worker exited and checkpoint was saved. Waiting ${Math.round(
        BATCH_DELAY_MS / 60_000,
      )} minutes before retrying this batch...`,
    );
    await wait(BATCH_DELAY_MS);
  }

  throw new Error("新闻采集批次状态异常");
}

export async function fetchCandidateNews() {
  const { newsList } = await runNewsCollector();
  return newsList;
}

export async function fetchLatestNews() {
  const newsList = await fetchCandidateNews();
  if (newsList.length === 0) throw new Error("No Baidu news was collected");
  return newsList[0];
}

async function runWorker() {
  const batchIndex = getBatchIndex();
  if (
    batchIndex === null ||
    batchIndex < 0 ||
    batchIndex >= COLLECTION_BATCHES.length
  ) {
    console.error("缺少有效的 --batch-index");
    process.exitCode = 1;
    return;
  }

  const batch = COLLECTION_BATCHES[batchIndex];
  const resume = hasResumeFlag();
  try {
    const initialNews = resume || batchIndex === 0 ? [] : await readExistingCandidates();
    await collectBaiduNews({
      countries: batch.countries,
      initialNews,
      resume,
      batchIndex,
    });
  } catch (error) {
    if (error?.code === RATE_LIMIT_ERROR_CODE) {
      process.exitCode = RATE_LIMIT_EXIT_CODE;
      return;
    }
    console.error(`Baidu collection failed for batch “${batch.name}”: ${error.message}`);
    process.exitCode = 1;
  }
}

async function runMain() {
  try {
    const result = await runNewsCollector();
    console.log("");
    console.log("==============================");
    console.log("Baidu news collection complete");
    console.log(`Candidates: ${result.newsList.length}`);
    console.log(`Duration: ${result.durationSeconds}s`);
    console.log("Output: data/candidate-news.json");
    console.log("==============================");
  } catch (error) {
    console.error(`Baidu collection failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (isWorkerProcess()) await runWorker();
  else await runMain();
}

