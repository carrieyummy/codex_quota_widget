/**
 * 验证额度分类的关键边界：赠送优先、逐笔到期、未知资金、数值精度和离线报告注入防护。
 * 测试不读取认证文件、不发送请求、不复制 UI 尺寸。
 */
const assert = require("node:assert/strict");
const { simulateSpend, summarizeFunds } = require("../research/credit-math.cjs");
const { selectLimitFields, summarizeAuxiliary, renderHtml } = require("../research/collect-quota-overview.cjs");
const now = "2026-11-25T00:00:00Z";
const expiry = "2026-12-19T00:00:00Z";
const lots = [
  { id: "promotion", kind: "promotion", amountUsd: 99, issuedAt: "2026-11-19T00:00:00Z", expiresAt: expiry },
  { id: "purchase", kind: "purchased", amountUsd: 20, issuedAt: now, expiresAt: "2027-11-25T00:00:00Z" }
];
const split = simulateSpend(lots, 100, now);
assert.equal(split.promotionRemainingUsd, 0);
assert.equal(split.purchasedRemainingUsd, 19);
assert.equal(split.uncoveredUsd, 0);
const expired = simulateSpend(lots, 5, expiry);
assert.equal(expired.expiredUsd, 99);
assert.equal(expired.purchasedRemainingUsd, 15);
assert.equal(expired.rows[0].deductedUsd, 0);
assert.equal(simulateSpend(lots, 150, now).uncoveredUsd, 31);
assert.equal(simulateSpend(lots, 0, "2026-11-24T00:00:00Z").purchasedRemainingUsd, 0);
assert.throws(() => simulateSpend(lots, -1, now));
assert.throws(() => simulateSpend([lots[0], lots[0]], 0, now));
const decimal = simulateSpend([{ ...lots[0], amountUsd: 0.3 }], 0.1, now);
assert.equal(decimal.promotionRemainingUsd, 0.2);

const funds = summarizeFunds({ cycle: { grantedUsd: 99, end: expiry, boundariesConfirmed: false },
  calculation: { estimatedRemainingUsd: 98.57, knownTokenCostUsd: 0.43 } });
assert.equal(funds.subscriptionEstimateUsd, 98.57);
assert.equal(funds.totalBalanceUsd, null);
assert.equal(funds.purchasedBalanceUsd, null);
assert.equal(funds.verifiedAgainstBilling, false);
const missing = summarizeFunds({ cycle: { grantedUsd: 99, end: expiry },
  calculation: { estimatedRemainingUsd: null, knownTokenCostUsd: 0 } });
assert.equal(missing.estimatedConsumptionUsd, null);
assert.equal(missing.subscriptionEstimateUsd, null);

assert.deepEqual(selectLimitFields({ id: "private", project_id: "private", name: "private",
  monthly_limit: 50, data: [{ id: "private", model: "model-a", max_requests_per_1_minute: 10 }] }),
{ monthly_limit: 50, data: [{ model: "model-a", max_requests_per_1_minute: 10 }] });
const aux = summarizeAuxiliary({ path: "/usage/example", statuses: [200], complete: true,
  buckets: [{ results: [] }] }, "示例");
assert.equal(aux.resultCount, 0);
assert.deepEqual(aux.counters, {});
assert.equal(aux.error, null);

const html = renderHtml({ text: "</script><script>alert(1)</script>" }, "", "");
assert(!html.includes("</script><script>alert(1)</script>"));
assert(html.includes("connect-src 'none'"));
assert(!html.includes("https://api.openai.com"));
console.log("PASS: promotion priority, expiry, unknown balances, precision, sanitization, and offline HTML");
