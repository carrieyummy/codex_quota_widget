/**
 * 按用户提供的额度周期查询管理员 Costs/Usage API，按公开模型单价估算余额。
 * 金额、周期和价格来自 JSON 配置；估算不代表 Billing 账本，也不从网页余额反推单价。
 * 只保存日期、模型、计费层级和数值，不保存组织、用户、项目或密钥标识。
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateConfig, requestJson, serializeSafe } = require("./probe-billing.cjs");

/**
 * 将配置中的含时区时间转换成 Unix 秒，拒绝隐式依赖本机时区的日期。
 * @param {string} value 带 Z 或 +/-HH:mm 时区的 ISO 时间，精确到秒。
 * @returns {number} Unix 秒；格式错误时抛错。
 */
function parseInstant(value) {
  if (typeof value !== "string" || !/T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error("周期时间必须显式包含时区。");
  return Math.floor(Date.parse(value) / 1000);
}

/**
 * 计算一个周期的查询范围，最多覆盖 32 天，并明确额度是否已过期。
 * @param {object} cycle 含 start/end、授予金额及其他已知额度增减的周期配置。
 * @param {number} now Unix 秒，主程序用当前时间，单元验证可传固定时间。
 * @returns {object} startTime、endTime、active；日期或金额无效时抛错。
 */
function resolveRange(cycle, now) {
  const startTime = parseInstant(cycle.start);
  const expiryTime = parseInstant(cycle.end);
  if (expiryTime <= startTime || expiryTime - startTime > 32 * 86400 || now <= startTime
      || !Number.isFinite(cycle.grantedUsd) || cycle.grantedUsd <= 0
      || !Number.isFinite(cycle.otherCreditChangesUsd)) throw new Error("周期或额度配置无效。");
  return { startTime, endTime: Math.min(now, expiryTime), active: now < expiryTime };
}

/**
 * 完整分页读取日桶，将每行限定为公开计费维度和数字字段。
 * @param {object} endpoint 从连接配置选出的 costs/usage 地址，已校验官方源。
 * @param {object} connection 原研究连接配置，含超时和最大页数。
 * @param {object} config 本研究配置，含分组维度与每页桶数。
 * @param {string} adminKey 本机管理员密钥，只用于官方认证头。
 * @param {object} range resolveRange 返回的左闭右开 Unix 秒区间。
 * @returns {Promise<object>} 分页状态、桶时间范围、脱敏计费行及错误摘要。
 */
async function queryCycle(endpoint, connection, config, adminKey, range) {
  const url = new URL(endpoint.path, connection.apiOrigin);
  for (const [name, value] of Object.entries({ start_time: range.startTime, end_time: range.endTime,
    bucket_width: "1d", limit: config.bucketLimit })) url.searchParams.set(name, String(value));
  for (const group of config.groupBy[endpoint.kind]) url.searchParams.append("group_by", group);
  const report = { path: endpoint.path, statuses: [], complete: false, buckets: [] };
  const cursors = new Set();
  for (let page = 0; page < connection.maxPages; page += 1) {
    const response = await requestJson(url, adminKey, connection.timeoutMs);
    report.statuses.push(response.status);
    if (!response.ok) { report.error = response.error; break; }
    const data = response.data;
    if (!Array.isArray(data?.data) || data.data.some((bucket) => !Array.isArray(bucket.results)
        || !Number.isFinite(bucket.start_time) || !Number.isFinite(bucket.end_time))) {
      report.error = { message: "响应缺少有效的日桶或结果数组。" }; break;
    }
    for (const bucket of data.data) {
      report.buckets.push({ startTime: bucket.start_time, endTime: bucket.end_time,
        results: bucket.results.map((row) => {
          const selected = {};
          for (const [key, value] of Object.entries(row)) {
            if (typeof value === "number" || ["model", "service_tier", "batch", "line_item"].includes(key)) {
              selected[key] = value;
            }
          }
          if (endpoint.kind === "costs") selected.amount = row.amount;
          return selected;
        }) });
    }
    if (data.has_more === false) { report.complete = true; break; }
    if (!data.next_page || cursors.has(data.next_page)) {
      report.error = { message: "分页游标缺失或重复。" }; break;
    }
    cursors.add(data.next_page);
    url.searchParams.set("page", data.next_page);
  }
  return report;
}

/**
 * 按普通输入、缓存命中、30 分钟/12 小时缓存写入及输出分别计价，不重复计入总输入。
 * @param {object} row 按 model/service_tier/batch 分组的最新用量行，必须完整提供各类 token 数。
 * @param {object[]} prices 配置中的精确模型/层级/Batch 价格及来源，每百万 token 计美元。
 * @returns {object} 明细与 estimatedCostUsd；不支持时金额为 null，并给出原因。
 */
function priceUsageRow(row, prices) {
  const result = { ...row, estimatedCostUsd: null };
  const price = prices.find((item) => item.model === row.model
    && item.serviceTier === row.service_tier && item.batch === row.batch);
  if (!price) return { ...result, reason: "没有匹配模型、服务层级与 Batch 类型的已验证价格。" };
  if (!price.source || ![price.inputUsdPerMillion, price.cachedInputUsdPerMillion,
    price.cacheWrite30mUsdPerMillion, price.cacheWrite12hUsdPerMillion, price.outputUsdPerMillion]
    .every((value) => Number.isFinite(value) && value >= 0)) {
    return { ...result, reason: "价格配置不完整。" };
  }
  const counts = [row.input_tokens, row.input_cached_tokens, row.output_tokens, row.input_uncached_tokens,
    row.input_cache_write_tokens, row.input_cache_write_30m_tokens, row.input_cache_write_12h_tokens];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)
      || row.input_uncached_tokens + row.input_cached_tokens + row.input_cache_write_tokens !== row.input_tokens
      || row.input_cache_write_30m_tokens + row.input_cache_write_12h_tokens !== row.input_cache_write_tokens) {
    return { ...result, reason: "token 分类数据不完整或与总输入不一致。" };
  }
  const unsupported = ["input_audio_tokens", "input_cached_audio_tokens", "output_audio_tokens",
    "input_image_tokens", "input_cached_image_tokens", "output_image_tokens"];
  if (unsupported.some((field) => row[field] > 0)) {
    return { ...result, reason: "包含图像或音频，当前文本估算未覆盖这些计费项。" };
  }
  const componentsUsd = {
    uncachedInput: row.input_uncached_tokens * price.inputUsdPerMillion / 1_000_000,
    cachedInput: row.input_cached_tokens * price.cachedInputUsdPerMillion / 1_000_000,
    cacheWrite30m: row.input_cache_write_30m_tokens * price.cacheWrite30mUsdPerMillion / 1_000_000,
    cacheWrite12h: row.input_cache_write_12h_tokens * price.cacheWrite12hUsdPerMillion / 1_000_000,
    output: row.output_tokens * price.outputUsdPerMillion / 1_000_000
  };
  const cost = Object.values(componentsUsd).reduce((sum, value) => sum + value, 0);
  return { ...result, componentsUsd, estimatedCostUsd: Number(cost.toFixed(10)), price };
}

/**
 * 汇总独立的费用观测与 token 估算，二者不相加；缺少费用记录不当作零消费。
 * @param {object} config 周期、网页参考数与价格配置；参考数只用于最后对比。
 * @param {object} range 含 active 的周期查询范围。
 * @param {object} costs 完整分页的 Costs 查询结果，允许空记录。
 * @param {object} usage 按模型分组的 Usage 查询结果。
 * @returns {object} 可核对的估算金额、参考差异及不确定性，始终标明不是账单真值。
 */
function calculateBalance(config, range, costs, usage) {
  const costRows = costs.buckets.flatMap((bucket) => bucket.results);
  const usageRows = usage.buckets.flatMap((bucket) => bucket.results).map((row) => priceUsageRow(row, config.prices));
  const usdRows = costRows.filter((row) => row.amount?.currency === "usd" && Number.isFinite(row.amount.value));
  const observedCostUsd = usdRows.length ? Number(usdRows.reduce((sum, row) => sum + row.amount.value, 0).toFixed(10)) : null;
  const pricedRows = usageRows.filter((row) => row.estimatedCostUsd !== null);
  const knownTokenCostUsd = Number(pricedRows.reduce((sum, row) => sum + row.estimatedCostUsd, 0).toFixed(10));
  const canEstimate = range.active && usage.complete && usageRows.length > 0 && pricedRows.length === usageRows.length;
  const estimatedRemainingUsd = canEstimate
    ? Number((config.cycle.grantedUsd + config.cycle.otherCreditChangesUsd - knownTokenCostUsd).toFixed(10)) : null;
  const reference = config.webReference.balanceUsd;
  const usageTotals = {};
  for (const field of ["num_model_requests", "input_tokens", "input_cached_tokens", "input_uncached_tokens",
    "input_cache_write_30m_tokens", "input_cache_write_12h_tokens", "output_tokens"]) {
    usageTotals[field] = usageRows.reduce((sum, row) => sum + (Number.isFinite(row[field]) ? row[field] : 0), 0);
  }
  return {
    kind: "text-token-estimate", billingVerified: false,
    observedCostUsd, costRowCount: costRows.length,
    costBucketsEndUtc: costs.buckets.length ? new Date(Math.max(...costs.buckets.map((bucket) => bucket.endTime)) * 1000).toISOString() : null,
    knownTokenCostUsd, pricedRowCount: pricedRows.length, usageTotals, estimatedRemainingUsd,
    displayedEstimateUsd: estimatedRemainingUsd === null ? null : estimatedRemainingUsd.toFixed(2),
    referenceBalanceUsd: reference,
    differenceFromReferenceUsd: estimatedRemainingUsd === null ? null : Number((estimatedRemainingUsd - reference).toFixed(10)),
    matchesReferenceDisplay: estimatedRemainingUsd === null ? null : estimatedRemainingUsd.toFixed(2) === reference.toFixed(2),
    usageRows,
    limitations: [
      ...(!config.cycle.boundariesConfirmed ? ["用户只确认发放/到期日期，UTC 零点边界尚未确认。"] : []),
      ...(!config.cycle.otherCreditChangesConfirmed ? ["其他充值、赠送、退款或账本调整尚未确认；本次暂按配置的其他额度增减计算。"] : []),
      ...(!range.active ? ["该额度周期已经结束，不能用未到期余额公式代表当前余额。"] : []),
      ...(!canEstimate ? ["用量分页、价格或计费项不完整，未生成完整 token 余额估算。"] : []),
      ...(observedCostUsd === null ? ["Costs 没有返回有效美元费用记录，不能确认真实消费金额。"] : []),
      "token 估算仅覆盖查询到的文本模型用量，不包括未查询的工具、存储、图像、音频等收费。",
      "使用配置中的标准短上下文价格；聚合用量不能识别单次请求的长上下文加价、地区加价或合同折扣。",
      "未将 Costs 与同区间 Usage 费用相加，避免重复扣减。",
      "网页参考金额不是同步快照，差异可能包含后续使用及报表延迟。",
      "即使两位小数相同，也不能证明已完整复现 Billing 账本。"
    ]
  };
}

/**
 * 将脱敏报告转换成直接可阅读的中文终端预览。
 * @param {object} report 已脱敏的周期查询及 calculation 结果。
 * @returns {string} 余额、扣减与各模型明细的文本，不包含认证信息。
 */
function renderPreview(report) {
  const value = report.calculation;
  const amount = (number) => number === null ? "无法确认" : `US$${number.toFixed(6)}`;
  return [
    "API 周期额度研究（估算，不是实时账单余额）",
    `发放日期/到期日期：${report.cycle.start} / ${report.cycle.end}`,
    `本期发放：US$${report.cycle.grantedUsd.toFixed(2)}`,
    `Costs 实际返回费用：${amount(value.observedCostUsd)}；HTTP ${report.costs.statuses.join(", ")}`,
    `Usage 已定价部分费用：${amount(value.knownTokenCostUsd)}（${value.pricedRowCount}/${value.usageRows.length} 行）；HTTP ${report.usage.statuses.join(", ")}`,
    `输入分类：普通 ${value.usageTotals.input_uncached_tokens} / 缓存命中 ${value.usageTotals.input_cached_tokens}`
      + ` / 30m 写入 ${value.usageTotals.input_cache_write_30m_tokens} / 12h 写入 ${value.usageTotals.input_cache_write_12h_tokens}`,
    `估算剩余：${value.displayedEstimateUsd === null ? "暂无法计算" : `US$${value.displayedEstimateUsd}`}`,
    `用户提供的网页参考：US$${value.referenceBalanceUsd.toFixed(2)}`,
    `估算与参考之差：${amount(value.differenceFromReferenceUsd)}`,
    "",
    ...value.usageRows.map((row) => `${row.model} | ${row.service_tier} | batch=${row.batch} | `
      + `input=${row.input_tokens} cached=${row.input_cached_tokens} output=${row.output_tokens} | `
      + (row.estimatedCostUsd === null ? row.reason : amount(row.estimatedCostUsd))),
    "", "计算限制：", ...value.limitations.map((note) => `- ${note}`)
  ].join("\n");
}

/**
 * 加载本机配置与密钥，查询本周期数据，输出脱敏 JSON 和文本预览。
 * 无命令行参数；周期/价格来自 cycle-balance.config.json，网络设置复用原研究配置。
 * @returns {Promise<void>} 写入被 Git 忽略的 output 文件，并输出预览。
 */
async function main() {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, "cycle-balance.config.json"), "utf8"));
  const connectionPath = path.resolve(__dirname, config.connectionConfig);
  const connection = JSON.parse(await fs.readFile(connectionPath, "utf8"));
  validateConfig(connection);
  if (!Number.isSafeInteger(config.bucketLimit) || config.bucketLimit < 1 || config.bucketLimit > 31
      || !Array.isArray(config.prices) || !Number.isFinite(config.webReference.balanceUsd)) throw new Error("估算配置无效。");
  const adminKey = (await fs.readFile(path.resolve(path.dirname(connectionPath), connection.keyFile), "utf8"))
    .replace(/^\uFEFF/, "").trim();
  if (!/^sk-admin-[A-Za-z0-9_-]+$/.test(adminKey)) throw new Error("管理员密钥格式无效。");
  const report = await collectCycle(config, connection, adminKey);
  const safeJson = serializeSafe(report, adminKey);
  const preview = renderPreview(JSON.parse(safeJson));
  for (const [filename, content] of [[config.outputJson, safeJson], [config.outputText, preview]]) {
    const target = path.resolve(__dirname, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${content}\n`, "utf8");
  }
  console.log(preview);
  if (!report.costs.complete || !report.usage.complete) process.exitCode = 1;
}

/**
 * 按同一截止时刻采集周期数据，供独立脚本与分类展示复用；不落盘、不输出密钥。
 * @param {object} config 已加载的周期配置，日期与单价均来自配置文件。
 * @param {object} connection 已验证的官方网络配置。
 * @param {string} adminKey 本机管理员密钥，只发往官方查询源。
 * @param {number} now Unix 秒截止时刻，默认当前时间。
 * @returns {Promise<object>} 脱敏前的选择性周期报告，不包含认证头或身份字段。
 */
async function collectCycle(config, connection, adminKey, now = Math.floor(Date.now() / 1000)) {
  const range = resolveRange(config.cycle, now);
  const report = { fetchedAt: new Date(now * 1000).toISOString(), cycle: config.cycle, reference: config.webReference,
    range: { startUtc: new Date(range.startTime * 1000).toISOString(), endUtc: new Date(range.endTime * 1000).toISOString() } };
  for (const kind of ["costs", "usage"]) {
    const endpoint = connection.endpoints.find((item) => item.kind === kind && item.documented);
    if (!endpoint) throw new Error("连接配置缺少官方查询项。");
    report[kind] = await queryCycle(endpoint, connection, config, adminKey, range);
  }
  report.calculation = calculateBalance(config, range, report.costs, report.usage);
  return report;
}

module.exports = { parseInstant, resolveRange, priceUsageRow, calculateBalance, renderPreview, collectCycle, queryCycle };

if (require.main === module) {
  main().catch(() => {
    console.error("周期研究未完成，请检查周期/价格配置、密钥文件或网络。未输出错误原文以避免泄露认证信息。");
    process.exitCode = 1;
  });
}
