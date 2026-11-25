/**
 * 只读采集 API 资金研究、各类用量、管理限额与本机 Codex 窗口，并生成本地分类展示。
 * 配置来自 research；凭据只在进程内使用。展示文件嵌入脱敏结果，不包含密钥或网络刷新能力。
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateConfig, requestJson, serializeSafe } = require("./probe-billing.cjs");
const { collectCycle, queryCycle } = require("./estimate-cycle-balance.cjs");
const { summarizeFunds } = require("./credit-math.cjs");

/**
 * 从限额响应选择数字、布尔和公开模型/币种字段，不保存身份标识或其他配置内容。
 * @param {unknown} value 官方响应中的待筛选节点，可为数组或嵌套对象。
 * @returns {unknown} 选择性数值结构；不包含项目、用户、密钥标识及名称。
 */
function selectLimitFields(value) {
  if (Array.isArray(value)) return value.map(selectLimitFields);
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["data", "amount", "limit", "spend_limit", "monthly_limit", "budget"].includes(key)
        && item && typeof item === "object") result[key] = selectLimitFields(item);
    else if (/(limit|budget|spend|token|request|image|audio|currency|enforc|reset|amount|value|enabled|period|model)/i.test(key)
        && ["number", "boolean"].includes(typeof item)) result[key] = item;
    else if (["model", "currency"].includes(key) && typeof item === "string") result[key] = item;
  }
  return result;
}

/**
 * 执行限额地址 GET，只保留 HTTP 状态、错误和选择性数值字段。
 * @param {string} pathname 同一官方源的路径，允许包含由本次项目列表得到的项目标识。
 * @param {object} connection 已校验的网络配置。
 * @param {string} adminKey 管理员认证密钥。
 * @param {object|null} pagination 速率列表分页设置，含 pageSize/maxPages；预算查询传 null。
 * @returns {Promise<object>} 不含身份的观测；速率列表明确记录是否完成分页。
 */
async function readLimit(pathname, connection, adminKey, pagination = null) {
  const url = new URL(pathname, connection.apiOrigin);
  if (url.origin !== connection.apiOrigin) throw new Error("限额地址不得离开官方源。");
  if (pagination) url.searchParams.set("limit", String(pagination.pageSize));
  const statuses = [];
  const rows = [];
  const cursors = new Set();
  for (let page = 0; page < (pagination?.maxPages ?? 1); page += 1) {
    const result = await requestJson(url, adminKey, connection.timeoutMs);
    statuses.push(result.status);
    const notConfigured = result.error?.code === "not_found"
      && /^No (?:organization|project) spend limit is configured\.$/.test(result.error?.message ?? "");
    if (!result.ok) return { status: result.status, statuses, ok: false,
      state: notConfigured ? "not_configured" : "unavailable", complete: false,
      fields: rows.length ? { data: rows } : null, error: result.error ?? null };
    const fields = selectLimitFields(result.data);
    if (!pagination) return { status: result.status, statuses, ok: true, complete: true, fields, error: null };
    if (!Array.isArray(result.data?.data)) break;
    rows.push(...fields.data);
    if (result.data.has_more === false) return { status: result.status, statuses, ok: true,
      complete: true, fields: { data: rows }, error: null };
    const cursor = result.data.data.at(-1)?.id;
    if (typeof cursor !== "string" || cursors.has(cursor) || result.data.has_more !== true) break;
    cursors.add(cursor);
    url.searchParams.set("after", cursor);
  }
  return { status: statuses.at(-1), statuses, ok: true, complete: false,
    fields: { data: rows }, error: { message: "速率列表分页未完整取得，不能视为全部模型。" } };
}

/**
 * 有界查询组织与项目限额；项目标识仅在内存中用于后续官方请求。
 * @param {object} config 分类配置，含路径模板和最大项目数。
 * @param {object} connection 已校验的网络配置。
 * @param {string} adminKey 管理员密钥，不写入报告。
 * @returns {Promise<object>} 用匿名项目标签表示的限额观测和采集范围。
 */
async function readApiLimits(config, connection, adminKey) {
  const organization = await readLimit(config.limitPaths.organizationSpend, connection, adminKey);
  const url = new URL(config.limitPaths.projects, connection.apiOrigin);
  if (url.origin !== connection.apiOrigin) throw new Error("项目地址不得离开官方源。");
  url.searchParams.set("limit", String(config.maxProjects));
  const projects = await requestJson(url, adminKey, connection.timeoutMs);
  const selected = Array.isArray(projects.data?.data) ? projects.data.data.slice(0, config.maxProjects) : [];
  const result = { organization, projectListStatus: projects.status,
    projectsQueried: selected.length, moreProjects: projects.data?.has_more ?? null, projects: [] };
  for (const [index, project] of selected.entries()) {
    if (typeof project.id !== "string") continue;
    const encoded = encodeURIComponent(project.id);
    const rates = await readLimit(config.limitPaths.projectRates.replace("{project}", encoded), connection, adminKey,
      { pageSize: config.ratePageSize, maxPages: config.maxRatePages });
    const spend = await readLimit(config.limitPaths.projectSpend.replace("{project}", encoded), connection, adminKey);
    result.projects.push({ label: `项目 ${index + 1}`, rates, spend });
  }
  return result;
}

/**
 * 汇总一个非文本 Usage 观测，只合计同名数字字段，不把用量当成美元费用。
 * @param {object} result queryCycle 返回的选择性日桶数据。
 * @param {string} label 配置中的类别名称。
 * @returns {object} 接口状态、记录数和各自原始计数单位。
 */
function summarizeAuxiliary(result, label) {
  const rows = result.buckets.flatMap((bucket) => bucket.results);
  const counters = {};
  for (const row of rows) for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number") counters[key] = (counters[key] ?? 0) + value;
  }
  return { label, path: result.path, statuses: result.statuses, complete: result.complete,
    resultCount: rows.length, counters, error: result.error ?? null };
}

/**
 * 读取本机 Codex 额度，保留实际返回的窗口和内部 credits，不换算成 API 美元。
 * 无参数；使用项目已有的 Codex 查找和认证链路。
 * @returns {Promise<object>} 成功时返回选择性窗口；失败时保留待脱敏的错误说明。
 */
async function readCodex() {
  try {
    const quota = await require("../src/main/quota-service.js").getQuota();
    return { ok: true, fetchedAt: quota.fetchedAt, planType: quota.planType,
      limits: quota.limits.map((limit) => ({ limitId: limit.limitId,
        primary: limit.primary, secondary: limit.secondary,
        credits: limit.credits ? { hasCredits: limit.credits.hasCredits,
          unlimited: limit.credits.unlimited, balance: limit.credits.balance } : null })) };
  } catch (error) { return { ok: false, error: String(error.message).slice(0, 1000) }; }
}

/**
 * 构建可双击打开的本地 HTML 入口，仅嵌入脱敏 JSON 和本地展示脚本。
 * @param {object} report 已脱敏的分类报告，不得包含管理员密钥或浏览器会话。
 * @param {string} viewSource 仓库内维护的展示脚本源码。
 * @param {string} mathSource 同版本纯计算模块源码，仅用于离线演示。
 * @returns {string} 无外部脚本、无后台请求的独立 HTML。
 */
function renderHtml(report, viewSource, mathSource) {
  const data = JSON.stringify(report).replace(/</g, "\\u003c");
  const script = (source) => source.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>额度分类研究</title><body><main id="app"></main>
<script id="report-data" type="application/json">${data}</script>
<script>var module={exports:{}};${script(mathSource)};var creditMath=module.exports;</script>
<script>${script(viewSource)}</script></body></html>`;
}

/**
 * 采集并生成研究文件；全部调节项来自配置，不接入或改变原小组件。
 * 无命令行参数；先查询当前周期，再顺序读取其他 API 与本机 Codex。
 * @returns {Promise<void>} 写入 output 内的 JSON/HTML，并打印无凭据的分类摘要。
 */
async function main() {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, "quota-overview.config.json"), "utf8"));
  const cyclePath = path.resolve(__dirname, config.cycleConfig);
  const cycle = JSON.parse(await fs.readFile(cyclePath, "utf8"));
  const connectionPath = path.resolve(path.dirname(cyclePath), cycle.connectionConfig);
  const connection = JSON.parse(await fs.readFile(connectionPath, "utf8"));
  validateConfig(connection);
  if (!Number.isSafeInteger(config.maxProjects) || config.maxProjects < 1 || config.maxProjects > 5
      || !Number.isSafeInteger(config.ratePageSize) || config.ratePageSize < 1 || config.ratePageSize > 100
      || !Number.isSafeInteger(config.maxRatePages) || config.maxRatePages < 1 || config.maxRatePages > 10) {
    throw new Error("项目查询范围无效。");
  }
  for (const item of config.auxiliaryUsage) {
    if (new URL(item.path, connection.apiOrigin).origin !== connection.apiOrigin) throw new Error("用量源无效。");
  }
  const key = (await fs.readFile(path.resolve(path.dirname(connectionPath), connection.keyFile), "utf8")).trim();
  if (!/^sk-admin-[A-Za-z0-9_-]+$/.test(key)) throw new Error("管理员密钥格式无效。");
  const cycleReport = await collectCycle(cycle, connection, key);
  console.log("周期费用与文本用量已采集。");
  const range = { startTime: Date.parse(cycleReport.range.startUtc) / 1000,
    endTime: Date.parse(cycleReport.range.endUtc) / 1000 };
  const auxiliary = [];
  for (const endpoint of config.auxiliaryUsage) {
    const result = await queryCycle({ ...endpoint, kind: "usage" }, connection,
      { ...cycle, groupBy: { usage: [] } }, key, range);
    auxiliary.push(summarizeAuxiliary(result, endpoint.label));
    console.log(`${endpoint.label}：HTTP ${result.statuses.join(", ")}，${result.complete ? "采集完成" : "未完整取得"}`);
  }
  const report = { generatedAt: new Date().toISOString(), cycleReport, funds: summarizeFunds(cycleReport),
    auxiliary, limits: config.readApiLimits ? await readApiLimits(config, connection, key) : null,
    codex: config.readCodex ? await readCodex() : null,
    sources: config.sources, simulationDefaults: config.simulationDefaults,
    catalog: JSON.parse(await fs.readFile(path.join(__dirname, "quota-catalog.json"), "utf8")) };
  const json = serializeSafe(report, key);
  const safeReport = JSON.parse(json);
  const viewSource = await fs.readFile(path.join(__dirname, "overview-view.js"), "utf8");
  const mathSource = await fs.readFile(path.join(__dirname, "credit-math.cjs"), "utf8");
  const directory = path.resolve(__dirname, config.outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "quota-overview.json"), `${json}\n`, "utf8");
  await fs.writeFile(path.join(directory, "index.html"), renderHtml(safeReport, viewSource, mathSource), "utf8");
  console.log(`本期赠送估算：${safeReport.funds.subscriptionEstimateUsd?.toFixed(2) ?? "未知"} USD；购买余额与组织总余额：未知。`);
  console.log(`分类展示已生成：${config.outputDirectory}/index.html`);
  if (!cycleReport.usage.complete) process.exitCode = 1;
}

module.exports = { selectLimitFields, summarizeAuxiliary, renderHtml };
if (require.main === module) main().catch(() => {
  console.error("分类研究未完成，请检查配置、认证文件和网络；未输出错误原文。");
  process.exitCode = 1;
});
