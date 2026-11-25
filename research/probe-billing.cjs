/**
 * 只读研究 OpenAI 管理员密钥能获取的费用、用量及 Billing 余额信息。
 * 配置来自同目录 JSON；密钥仅用于官方 API 的请求头，不输出原始响应或请求头。
 * 本脚本独立运行，不接入桌面组件；未公开的地址仅作为研究假设进行探测。
 */
const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * 校验研究配置，拒绝错误的范围及非官方请求目标。
 * @param {object} config JSON 配置，路径相对 research，查询范围为 1 至 30 天。
 * @returns {void} 校验成功无返回；不合法时抛错。
 */
function validateConfig(config) {
  const origin = new URL(config.apiOrigin);
  if (origin.protocol !== "https:" || origin.hostname !== "api.openai.com"
      || origin.port || origin.username || origin.password || origin.origin !== config.apiOrigin) {
    throw new Error("研究请求目标必须是官方 OpenAI API 的 HTTPS 源。");
  }
  for (const field of ["lookbackDays", "timeoutMs", "maxPages"]) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0) {
      throw new Error(`配置 ${field} 必须为正整数。`);
    }
  }
  if (config.lookbackDays > 30 || config.maxPages > 10 || !config.endpoints?.length) {
    throw new Error("研究范围不得超过 30 天、10 页，且必须配置查询地址。");
  }
  for (const endpoint of config.endpoints) {
    const url = new URL(endpoint.path, config.apiOrigin);
    if (url.origin !== config.apiOrigin || url.username || url.password
        || !["costs", "usage", "billing"].includes(endpoint.kind)) {
      throw new Error("查询地址或数据类别无效。");
    }
  }
}

/**
 * 清除报告中的完整密钥、掩码密钥及组织/项目标识，供磁盘和控制台共用。
 * @param {unknown} value 待序列化的结果对象，不应包含原始响应。
 * @param {string} adminKey 从本地文件加载的密钥，仅用于精确脱敏。
 * @returns {string} 已脱敏的 JSON 文本。
 */
function serializeSafe(value, adminKey) {
  return JSON.stringify(value, null, 2)
    .split(adminKey).join("[REDACTED]")
    .replace(/sk-[A-Za-z0-9_*.-]+/g, "[REDACTED_KEY]")
    .replace(/\b(?:org|proj)_[A-Za-z0-9_-]+\b/g, "[REDACTED_ID]")
    .replace(/\borg-[A-Za-z0-9_-]+\b/g, "[REDACTED_ID]");
}

/**
 * 在官方源执行一次限时 GET，不自动跳转，不发送 Cookie，也不调用模型。
 * @param {URL} url 经配置校验的官方查询地址，允许附加分页参数。
 * @param {string} adminKey 只放入 Authorization 请求头的管理员密钥。
 * @param {number} timeoutMs 请求与响应体读取的总超时毫秒数，必须大于 0。
 * @returns {Promise<object>} HTTP 状态、非秘密响应类型和内存中的 JSON；不输出请求头。
 */
async function requestJson(url, adminKey, timeoutMs) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch { /* 非 JSON 只记录类型，不输出原始 HTML。 */ }
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      server: response.headers.get("server"),
      challenge: response.headers.get("cf-mitigated"),
      data,
      error: response.ok ? null : {
        type: data?.error?.type ?? null,
        code: data?.error?.code ?? null,
        message: String(data?.error?.message ?? (typeof data?.error === "string" ? data.error : null)
          ?? data?.message ?? "未返回 JSON 错误说明").slice(0, 1000)
      }
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      error: { type: error.name, code: error.cause?.code ?? null, message: error.message }
    };
  }
}

/**
 * 汇总组织费用或 completions 用量，只保留总量，不保存组织、用户或密钥明细。
 * @param {object[]} buckets API 返回的日桶数组，可包含空结果。
 * @param {"costs"|"usage"} kind 汇总类别；用量不代表所有 API 产品的总用量。
 * @returns {object} 桶数、记录数及按币种费用或输入/输出 token、请求次数。
 */
function summarizeBuckets(buckets, kind) {
  const rows = buckets.flatMap((bucket) => bucket.results);
  const summary = { bucketCount: buckets.length, resultCount: rows.length };
  if (kind === "costs") {
    const totals = new Map();
    for (const row of rows) {
      if (Number.isFinite(row.amount?.value) && typeof row.amount.currency === "string") {
        const currency = row.amount.currency;
        totals.set(currency, (totals.get(currency) ?? 0) + row.amount.value);
      }
    }
    summary.costByCurrency = Object.fromEntries(
      [...totals].map(([currency, value]) => [currency, Number(value.toFixed(10))])
    );
  } else {
    for (const field of ["input_tokens", "output_tokens", "input_cached_tokens", "num_model_requests"]) {
      summary[field] = rows.reduce((sum, row) => sum + (Number.isFinite(row[field]) ? row[field] : 0), 0);
    }
  }
  return summary;
}

/**
 * 分页查询费用或用量，遇到错误或页数限制时明确标记不完整。
 * @param {object} endpoint 配置中的 costs 或 usage 查询项。
 * @param {object} config 已校验的全局配置。
 * @param {string} adminKey 本地读取的管理员密钥。
 * @param {{startTime:number,endTime:number}} range UTC Unix 秒查询范围，左闭右开。
 * @returns {Promise<object>} 脱离原始响应的状态、分页信息和汇总。
 */
async function probeBuckets(endpoint, config, adminKey, range) {
  const url = new URL(endpoint.path, config.apiOrigin);
  url.searchParams.set("start_time", String(range.startTime));
  url.searchParams.set("end_time", String(range.endTime));
  url.searchParams.set("bucket_width", "1d");
  url.searchParams.set("limit", String(config.lookbackDays + 1));
  const report = { ...endpoint, statuses: [], complete: false };
  const buckets = [];
  const cursors = new Set();
  for (let page = 0; page < config.maxPages; page += 1) {
    const response = await requestJson(url, adminKey, config.timeoutMs);
    report.statuses.push(response.status);
    if (!response.ok) {
      report.error = response.error;
      report.contentType = response.contentType ?? null;
      break;
    }
    const data = response.data;
    if (!Array.isArray(data?.data) || data.data.some((bucket) => !Array.isArray(bucket.results))) {
      report.error = { message: "成功响应不符合日桶结构，未将其认作有效用量/费用。" };
      break;
    }
    buckets.push(...data.data);
    if (data.has_more === false) {
      report.complete = true;
      break;
    }
    if (!data.next_page || cursors.has(data.next_page)) {
      report.error = { message: "缺少后续分页游标，或游标重复。" };
      break;
    }
    cursors.add(data.next_page);
    url.searchParams.set("page", data.next_page);
  }
  report.summary = summarizeBuckets(buckets, endpoint.kind);
  return report;
}

/**
 * 探测未公开的余额查询地址，仅报告字段名和明确存在的金额，不推算余额。
 * @param {object} endpoint 配置中的 billing 查询项，不作为生产接口契约。
 * @param {object} config 已校验的全局配置。
 * @param {string} adminKey 只用于该次官方源 GET 的管理员密钥。
 * @returns {Promise<object>} HTTP 结果和选择性字段；失败时保留脱敏后的错误。
 */
async function probeBilling(endpoint, config, adminKey) {
  const response = await requestJson(new URL(endpoint.path, config.apiOrigin), adminKey, config.timeoutMs);
  const report = {
    ...endpoint,
    status: response.status,
    ok: response.ok,
    contentType: response.contentType ?? null,
    server: response.server ?? null,
    challenge: response.challenge ?? null
  };
  if (!response.ok) {
    report.error = response.error;
  } else {
    report.topLevelFields = Object.keys(response.data ?? {});
    report.amounts = {};
    for (const field of ["total_available", "total_granted", "total_used", "balance", "available_balance", "credit_balance"]) {
      if (Number.isFinite(response.data?.[field])) report.amounts[field] = response.data[field];
    }
    report.grantFields = Object.keys(response.data?.grants?.data?.[0] ?? {});
    report.note = "字段属于未公开接口；即使成功也须核对币种、组织和余额含义。";
  }
  return report;
}

/**
 * 读取非秘密配置和本地密钥，按顺序执行探测，并保存/输出脱敏研究报告。
 * 无命令行参数；所有可调值来自同目录 billing-probe.config.json。
 * @returns {Promise<void>} 完成后写入配置指定的报告；配置错误时抛错。
 */
async function main() {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, "billing-probe.config.json"), "utf8"));
  validateConfig(config);
  const adminKey = (await fs.readFile(path.resolve(__dirname, config.keyFile), "utf8")).replace(/^\uFEFF/, "").trim();
  if (!/^sk-admin-[A-Za-z0-9_-]+$/.test(adminKey)) {
    throw new Error("密钥文件必须只包含一条管理员密钥，不含引号或配置语句。");
  }
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = Math.floor(endTime / 86400) * 86400 - config.lookbackDays * 86400;
  const report = {
    fetchedAt: new Date().toISOString(),
    range: { startUtc: new Date(startTime * 1000).toISOString(), endUtc: new Date(endTime * 1000).toISOString() },
    note: "仅执行 GET；费用为报告区间消费，不等于可用信用余额。未保存原始响应、请求头和密钥。",
    endpoints: []
  };
  for (const endpoint of config.endpoints) {
    const result = endpoint.kind === "billing"
      ? await probeBilling(endpoint, config, adminKey)
      : await probeBuckets(endpoint, config, adminKey, { startTime, endTime });
    report.endpoints.push(result);
  }
  const safeJson = serializeSafe(report, adminKey);
  const outputFile = path.resolve(__dirname, config.outputFile);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, `${safeJson}\n`, "utf8");
  console.log(safeJson);
  // HTTP 查询拒绝也是有效研究结果；全部网络失败时用非零状态提示未完成验证。
  if (report.endpoints.every((endpoint) => (endpoint.status ?? endpoint.statuses?.[0]) == null)) {
    process.exitCode = 1;
  }
}

// 导入时只提供研究工具函数，不读取密钥或发送请求。
module.exports = { validateConfig, requestJson, serializeSafe };

if (require.main === module) {
  main().catch(() => {
    // 不输出异常对象，避免第三方错误或文件内容意外携带认证信息。
    console.error("研究脚本未完成：请检查配置、密钥格式、文件权限和本机网络。");
    process.exitCode = 1;
  });
}
