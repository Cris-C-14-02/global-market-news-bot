import { collectBaiduNews } from "../modules/newsSearcher.mjs";

const countries = process.argv.slice(2);
const result = await collectBaiduNews({
  countries: countries.length ? countries : ["泰国"],
  outputFile: new URL("../data/baidu-candidate-news.json", import.meta.url),
});

console.log("");
console.log("Baidu collector test complete");
console.log(`Candidates: ${result.newsList.length}`);
console.log("Output: data/baidu-candidate-news.json");
console.log(JSON.stringify(result.report, null, 2));

