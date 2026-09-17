import process from "node:process";
import { processNews } from "../modules/newsProcessor.mjs";

try {
  const result = await processNews();
  console.log("\n✅ 新闻处理成功\n");
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error("\n❌ 新闻处理失败:");
  console.error(err.message);
  process.exit(1);
}

