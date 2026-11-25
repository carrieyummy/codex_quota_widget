/**
 * 从既有脱敏 JSON 重新生成分类页面，用于离线查看及布局调整，不读取密钥、不访问网络。
 * 文件位置统一读取 quota-overview.config.json；几何尺寸由 overview-view.js 维护。
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const { renderHtml } = require("./collect-quota-overview.cjs");

/**
 * 读取已有分类快照及当前展示代码，生成同目录 HTML；无参数。
 * @returns {Promise<void>} 写入 index.html；快照缺失时抛错，不生成虚构数据。
 */
async function main() {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, "quota-overview.config.json"), "utf8"));
  const directory = path.resolve(__dirname, config.outputDirectory);
  const report = JSON.parse(await fs.readFile(path.join(directory, "quota-overview.json"), "utf8"));
  const view = await fs.readFile(path.join(__dirname, "overview-view.js"), "utf8");
  const math = await fs.readFile(path.join(__dirname, "credit-math.cjs"), "utf8");
  await fs.writeFile(path.join(directory, "index.html"), renderHtml(report, view, math), "utf8");
  console.log("分类页面已从已有脱敏快照重新生成；未访问网络或认证文件。");
}

if (require.main === module) main().catch(() => {
  console.error("离线渲染失败，请先生成有效的分类 JSON 快照。");
  process.exitCode = 1;
});
