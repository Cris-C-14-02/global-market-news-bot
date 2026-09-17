// 千问价格：元 / 百万Token
const INPUT_PRICE_PER_MILLION = 0.24;
const OUTPUT_PRICE_PER_MILLION = 1.92;


function toTokenNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}


export function createTokenUsageTracker(stageName) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    recordedCalls: 0,
    missingUsageCalls: 0,
  };


  function record(payload) {
    const usage = payload?.usage;

    if (!usage) {
      totals.missingUsageCalls += 1;
      return;
    }


    // 兼容OpenAI和部分其他接口字段
    const inputValue =
      usage.prompt_tokens ??
      usage.input_tokens;

    const outputValue =
      usage.completion_tokens ??
      usage.output_tokens;

    const totalValue =
      usage.total_tokens;


    const hasUsage =
      inputValue !== undefined ||
      outputValue !== undefined ||
      totalValue !== undefined;


    if (!hasUsage) {
      totals.missingUsageCalls += 1;
      return;
    }


    const inputTokens =
      toTokenNumber(inputValue);

    const outputTokens =
      toTokenNumber(outputValue);

    const totalTokens =
      totalValue !== undefined
        ? toTokenNumber(totalValue)
        : inputTokens + outputTokens;


    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.totalTokens += totalTokens;
    totals.recordedCalls += 1;
  }


  function getSummary() {
    const inputCost =
      totals.inputTokens /
      1_000_000 *
      INPUT_PRICE_PER_MILLION;

    const outputCost =
      totals.outputTokens /
      1_000_000 *
      OUTPUT_PRICE_PER_MILLION;

    return {
      ...totals,
      inputCost,
      outputCost,
      totalCost:
        inputCost + outputCost,
    };
  }


  function print() {
    const summary =
      getSummary();

    console.log("");
    console.log("==============================");
    console.log(`${stageName} Token用量`);
    console.log("==============================");

    console.log(
      `输入Token：${summary.inputTokens}`
    );

    console.log(
      `输出Token：${summary.outputTokens}`
    );

    console.log(
      `总Token：${summary.totalTokens}`
    );

    console.log(
      `已记录接口调用：${summary.recordedCalls}`
    );

    console.log(
      `未返回usage：${summary.missingUsageCalls}`
    );

    console.log(
      `输入费用：¥${summary.inputCost.toFixed(4)}`
    );

    console.log(
      `输出费用：¥${summary.outputCost.toFixed(4)}`
    );

    console.log(
      `本模块费用：¥${summary.totalCost.toFixed(4)}`
    );

    console.log("==============================");
  }


  return {
    record,
    getSummary,
    print,
  };
}
