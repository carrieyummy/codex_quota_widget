/**
 * 额度分类研究的纯计算函数。API 美元与 Codex 时间窗口永不混算。
 * 充值/消费演示只解释规则，不替代缺失的组织发放、充值和调整账本。
 */

/**
 * 将有限的非负金额按研究计算精度取整，避免常见浮点尾差。
 * @param {number} value 非负美元金额，必须为有限数字。
 * @returns {number} 保留十位小数的金额；无效输入抛错。
 */
function money(value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("金额必须是有限非负数字。");
  return Number(value.toFixed(10));
}

/**
 * 在指定时刻模拟一次消费：先排除到期/未发放批次，再使用赠送额度和购买额度。
 * 同类多笔暂按最近到期优先，仅为研究假设，不能据此声称官方逐笔分摊顺序。
 * @param {object[]} lots 批次数组，含 id、kind(promotion/purchased)、amountUsd、issuedAt、expiresAt。
 * @param {number} spendUsd 本次模拟消费额，不得为负；不包含历史消费。
 * @param {string} asOf ISO 时刻，必须可解析；到期边界不含该时刻。
 * @returns {object} 分批余额、扣减、过期额及未覆盖消费；不会产生负赠送余额。
 */
function simulateSpend(lots, spendUsd, asOf) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new TypeError("演示时刻无效。");
  let outstanding = money(spendUsd);
  const ids = new Set();
  const rows = lots.map((lot) => {
    if (!lot.id || ids.has(lot.id) || !["promotion", "purchased"].includes(lot.kind)
        || !Number.isFinite(Date.parse(lot.issuedAt)) || !Number.isFinite(Date.parse(lot.expiresAt))
        || Date.parse(lot.expiresAt) <= Date.parse(lot.issuedAt)) throw new TypeError("演示批次无效。");
    ids.add(lot.id);
    const amount = money(lot.amountUsd);
    const expired = Date.parse(lot.expiresAt) <= now;
    const active = !expired && Date.parse(lot.issuedAt) <= now;
    return { ...lot, active, expired, deductedUsd: 0, expiredUsd: expired ? amount : 0,
      remainingUsd: active ? amount : 0 };
  });
  const ordered = rows.filter((row) => row.active).sort((a, b) =>
    (a.kind === "promotion" ? 0 : 1) - (b.kind === "promotion" ? 0 : 1)
      || Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    row.deductedUsd = Math.min(row.remainingUsd, outstanding);
    row.remainingUsd = money(row.remainingUsd - row.deductedUsd);
    outstanding = money(outstanding - row.deductedUsd);
  }
  return { rows, uncoveredUsd: outstanding,
    promotionRemainingUsd: money(rows.filter((row) => row.kind === "promotion").reduce((sum, row) => sum + row.remainingUsd, 0)),
    purchasedRemainingUsd: money(rows.filter((row) => row.kind === "purchased").reduce((sum, row) => sum + row.remainingUsd, 0)),
    totalRemainingUsd: money(rows.reduce((sum, row) => sum + row.remainingUsd, 0)),
    expiredUsd: money(rows.reduce((sum, row) => sum + row.expiredUsd, 0)) };
}

/**
 * 从已知周期估算构建资金摘要，未取得的购买与其他赠送余额始终用 null 表示。
 * @param {object} cycleReport 本次管理员 API 查询的周期报告。
 * @returns {object} 赠送已知子集、未知总额和到期信息；不将 null 转成零。
 */
function summarizeFunds(cycleReport) {
  const calculation = cycleReport.calculation;
  // 单笔赠送与其他调整分开；只有文本估算完整时才生成本笔的条件估算。
  const remaining = calculation.estimatedRemainingUsd === null ? null
    : cycleReport.cycle.grantedUsd - calculation.knownTokenCostUsd;
  return {
    totalBalanceUsd: null, purchasedBalanceUsd: null, otherPromotionsBalanceUsd: null,
    subscriptionGrantUsd: cycleReport.cycle.grantedUsd,
    subscriptionEstimateUsd: remaining === null ? null : money(Math.max(0, remaining)),
    estimatedConsumptionUsd: calculation.estimatedRemainingUsd === null ? null : calculation.knownTokenCostUsd,
    subscriptionExpiresAt: cycleReport.cycle.end,
    explanation: "缺少组织充值、其他赠送、退款和调整账本；本期赠送估算暂将文本消费归于该笔，只是已知子集，不能充当组织总余额。",
    boundariesConfirmed: cycleReport.cycle.boundariesConfirmed,
    verifiedAgainstBilling: false
  };
}

module.exports = { money, simulateSpend, summarizeFunds };
