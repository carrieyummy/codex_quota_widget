/**
 * 验证周期余额研究的关键财务边界：缓存写入、未知用量、重复扣费、过期和参考值隔离。
 * 仅使用脱敏数值与本地价格配置，不加载管理员密钥，不访问网络。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveRange, priceUsageRow, calculateBalance } = require("../research/estimate-cycle-balance.cjs");
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../research/cycle-balance.config.json"), "utf8"));

/**
 * 构造最新 API 结构的文本用量行，所有 token 分类均须明确提供。
 * @param {object} overrides 用于场景的模型和 token 数覆盖值，不得包含真实身份标识。
 * @returns {object} 可独立计价的文本用量行。
 */
function usageRow(overrides) {
  return { model: "gpt-6.2-sol", service_tier: "default", batch: false, num_model_requests: 16,
    input_tokens: 815741, input_cached_tokens: 755028, input_uncached_tokens: 48,
    input_cache_write_tokens: 60665, input_cache_write_30m_tokens: 60665,
    input_cache_write_12h_tokens: 0, output_tokens: 2494, ...overrides };
}

const rows = [usageRow({}), usageRow({ model: "gpt-6.1-sol", num_model_requests: 2,
  input_tokens: 126565, input_cached_tokens: 61704, input_uncached_tokens: 6,
  input_cache_write_tokens: 64855, input_cache_write_30m_tokens: 64855, output_tokens: 942 })];
const usage = { complete: true, buckets: [{ startTime: 1795564800, endTime: 1795651200, results: rows }] };
const emptyCosts = { complete: true, buckets: [{ startTime: 1795478400, endTime: 1795564800, results: [] }] };
const activeRange = resolveRange(config.cycle, Date.parse("2026-11-25T00:00:00Z") / 1000);

// 本次脱敏真实用量的独立期望值，包含 125,520 个 30m 缓存写入，不能再次按普通输入收费。
const result = calculateBalance(config, activeRange, emptyCosts, usage);
assert.equal(result.knownTokenCostUsd, 0.4299412);
assert.equal(result.estimatedRemainingUsd, 98.5700588);
assert.equal(result.displayedEstimateUsd, "98.57");
assert.equal(result.matchesReferenceDisplay, true);
assert.equal(result.billingVerified, false);
assert.equal(result.observedCostUsd, null);

// 12h 写入以独立单价计费，不能使用普通输入或 30m 写入价格。
const write12h = priceUsageRow(usageRow({ input_tokens: 1000000, input_cached_tokens: 0,
  input_uncached_tokens: 0, input_cache_write_tokens: 1000000,
  input_cache_write_30m_tokens: 0, input_cache_write_12h_tokens: 1000000,
  output_tokens: 0 }), config.prices);
assert.equal(write12h.estimatedCostUsd, 5);

// 费用 API 同时有值时只用于对照，不与同一区间的 Usage 重复相加扣减。
const withCosts = calculateBalance(config, activeRange, { complete: true, buckets: [{
  startTime: 1795478400, endTime: 1795564800, results: [{ amount: { value: 0.4, currency: "usd" } }]
}] }, usage);
assert.equal(withCosts.observedCostUsd, 0.4);
assert.equal(withCosts.estimatedRemainingUsd, result.estimatedRemainingUsd);

// 改变网页参考值不改变估算结果，不能用参考余额反推出价格或扣减金额。
const changedReference = calculateBalance({ ...config, webReference: { balanceUsd: 90 } }, activeRange, emptyCosts, usage);
assert.equal(changedReference.estimatedRemainingUsd, result.estimatedRemainingUsd);
assert.equal(changedReference.matchesReferenceDisplay, false);

// 未知模型、非文本数据、token 分类不一致和分页不完整时均不输出完整余额。
assert.equal(priceUsageRow(usageRow({ model: "unknown-model" }), config.prices).estimatedCostUsd, null);
assert.equal(priceUsageRow(usageRow({ input_audio_tokens: 1 }), config.prices).estimatedCostUsd, null);
assert.equal(priceUsageRow(usageRow({ input_uncached_tokens: 49 }), config.prices).estimatedCostUsd, null);
assert.equal(calculateBalance(config, activeRange, emptyCosts, { ...usage, complete: false }).estimatedRemainingUsd, null);
const mixed = { complete: true, buckets: [{ results: [...rows, usageRow({ model: "unknown-model" })] }] };
assert.equal(calculateBalance(config, activeRange, emptyCosts, mixed).estimatedRemainingUsd, null);

// 周期过期后不继续显示上一周期余额，输入日期不能隐式采用本机时区。
const expired = resolveRange(config.cycle, Date.parse("2026-12-20T00:00:00Z") / 1000);
assert.equal(calculateBalance(config, expired, emptyCosts, usage).estimatedRemainingUsd, null);
assert.throws(() => resolveRange({ ...config.cycle, start: "2026-11-19" }, 1795564800));

console.log("PASS: cache pricing, reference isolation, no duplicate debit, missing data, and cycle expiry");
