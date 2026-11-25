/**
 * 独立额度研究页面。所有几何尺寸集中于 UI_SIZES；测试读取本对象，不复制尺寸。
 * 页面只使用已嵌入的脱敏快照，交互仅切换分类或本地演示，不访问网络和认证文件。
 */
var UI_SIZES = Object.freeze({
  maxWidth: 1180, cardMin: 210, padding: 26, gap: 18, smallGap: 9,
  font: 15, smallFont: 13, titleFont: 29, headingFont: 19, valueFont: 31,
  radius: 12, border: 1, controlPadding: 10, barHeight: 8,
  previewWidth: 1280, previewHeight: 1000, narrowPreviewWidth: 390
});
if (typeof document === "undefined") module.exports = { UI_SIZES };
else {
  /** 渲染本地研究快照；无参数，无返回值，不发出请求。 */
  function renderOverview() {
    var report = JSON.parse(document.getElementById("report-data").textContent);
    var funds = report.funds;
    var cycle = report.cycleReport;
    var calc = cycle.calculation;
    /** 将任意显示值转成安全 HTML 文本；value 为待显示值，返回转义字符串。 */
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    /** 格式化金额；value 为美元数或 null，digits 为小数位数，返回金额或未知标记。 */
    function usd(value, digits = 2) { return Number.isFinite(value) ? `US$${value.toFixed(digits)}` : "未知"; }
    /** 格式化快照时间；value 为 ISO 字符串，返回上海时区时间或未知。 */
    function date(value) {
      return value && Number.isFinite(Date.parse(value))
        ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知";
    }
    /** 构建滚动表格；heads 为列名，rows 为已转义的单元格数组，返回 HTML。 */
    function table(heads, rows) {
      return `<div class="table-wrap"><table><thead><tr>${heads.map((item) => `<th>${esc(item)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((item) => `<td>${item}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    /** 构建状态摘要；label/value/note 为显示文本，tone 为受控样式名，返回安全 HTML。 */
    function metric(label, value, note, tone = "") {
      return `<article class="metric ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
    }
    /** 展示限额读取结果；value 为选择性字段及状态，返回折叠明细 HTML。 */
    function limitDetail(value) {
      if (!value) return "未采集";
      if (value.state === "not_configured") return `未配置自定义月度支出上限（HTTP ${esc(value.status)}）。这不代表没有平台批准的使用上限。`;
      if (value.ok && Array.isArray(value.fields?.data)) return `<details><summary>HTTP ${esc(value.status)} · ${value.fields.data.length} 个模型上限 · ${value.complete ? "分页完整" : "分页未完整取得"}</summary>${table(["模型","请求/分钟","token/分钟","Batch日输入token","图像/分钟"], value.fields.data.map((row) => [esc(row.model),esc(row.max_requests_per_1_minute ?? "未返回"),esc(row.max_tokens_per_1_minute ?? "未返回"),esc(row.batch_1_day_max_input_tokens ?? "未返回"),esc(row.max_images_per_1_minute ?? "未返回")]))}</details>`;
      return value.ok ? `<details><summary>HTTP ${esc(value.status)} · 查看返回的上限</summary><pre>${esc(JSON.stringify(value.fields, null, 2))}</pre></details>`
        : `HTTP ${esc(value.status ?? "网络失败")} · ${esc(value.error?.message ?? "未取得数据")}`;
    }

    var vars = Object.entries(UI_SIZES).filter(([key]) => !key.includes("Preview") && !key.startsWith("preview"))
      .map(([key, value]) => `--${key}:${value}px`).join(";");
    var style = document.createElement("style");
    style.textContent = `:root{${vars};color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#192435;font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:var(--font);line-height:1.55}main{max-width:var(--maxWidth);margin:auto;padding:var(--padding)}h1,h2,p{margin:0}h1{font-size:var(--titleFont)}h2{font-size:var(--headingFont);margin-bottom:var(--smallGap)}header{display:flex;justify-content:space-between;gap:var(--gap);flex-wrap:wrap;margin-bottom:var(--gap)}small,.muted{color:#5d6b7c;font-size:var(--smallFont)}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--cardMin)),1fr));gap:var(--gap);margin-bottom:var(--gap)}.metric{background:white;border:var(--border) solid #dce3eb;border-radius:var(--radius);padding:var(--gap);display:grid;gap:var(--smallGap)}.metric strong{font-size:var(--valueFont);font-variant-numeric:tabular-nums}.metric.good{border-color:#a5d5be}.metric.good strong{color:#147149}.notice{padding:var(--gap);background:#eaf0fa;border-radius:var(--radius);margin-bottom:var(--gap)}nav{display:flex;flex-wrap:wrap;gap:var(--smallGap);margin-bottom:var(--gap)}button,input,select{font:inherit;padding:var(--controlPadding);border:var(--border) solid #c5ceda;border-radius:var(--smallGap);background:white;color:inherit}button{cursor:pointer}button[aria-selected=true]{background:#223c65;color:white;border-color:#223c65}section{background:white;border:var(--border) solid #dce3eb;border-radius:var(--radius);padding:var(--gap)}section[hidden]{display:none}.block+.block{margin-top:var(--gap)}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{border-bottom:var(--border) solid #e3e8ef;padding:var(--controlPadding);vertical-align:top}th{color:#5d6b7c;font-weight:600}td{font-variant-numeric:tabular-nums}td small{display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--smallFont)}.rules{display:grid;gap:var(--gap)}.rule{border-top:var(--border) solid #e3e8ef;padding-top:var(--gap)}a{color:#245b9c}label{display:grid;gap:var(--smallGap)}.controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--cardMin)),1fr));gap:var(--gap);margin-bottom:var(--gap)}#scenario-result{display:grid;gap:var(--smallGap)}.pill{display:inline-block;background:#eaf0fa;padding:0 var(--smallGap);border-radius:var(--radius)}.window{margin-bottom:var(--gap)}progress{width:100%;height:var(--barHeight);accent-color:#147149}footer{margin-top:var(--gap);color:#5d6b7c;font-size:var(--smallFont)}summary{cursor:pointer}ul{padding-inline-start:var(--padding)}`;
    document.head.appendChild(style);
    // 产品内部 credits 等紧凑 JSON 可能没有断行点，允许其在窄视口自然换行。
    style.textContent += "p,small,code,summary{overflow-wrap:anywhere}input,select,label{min-width:0;max-width:100%}";

    var fundingRows = [
      ["本期订阅赠送", usd(funds.subscriptionGrantUsd), usd(funds.estimatedConsumptionUsd, 7), usd(funds.subscriptionEstimateUsd), esc(cycle.cycle.end.slice(0, 10)), "用户发放记录 + 文本消费估算"],
      ["购买额度", "未知", "未知", "未知", "按每笔购买记录", "没有取得充值/余额批次账本"],
      ["其他赠送 / 试用 / 活动", "未知", "未知", "未知", "按每笔发放记录", "未采集，不能当作零"],
      ["组织总余额", "—", "—", "未知", "各批次分别到期", "资金范围不完整，不能使用本期估算代替"]
    ];
    var costRows = calc.usageRows.map((row) => [esc(row.model), esc(row.input_uncached_tokens), esc(row.input_cached_tokens),
      esc(row.input_cache_write_30m_tokens), esc(row.input_cache_write_12h_tokens), esc(row.output_tokens),
      usd(row.estimatedCostUsd, 7), esc(`${row.service_tier} / batch=${row.batch}`)]);
    var auxiliaryRows = report.auxiliary.map((item) => [esc(item.label), esc(item.statuses.join(", ")),
      item.complete ? (item.resultCount ? esc(`${item.resultCount} 条记录`) : "无返回记录") : "未完整取得",
      `<pre>${esc(item.resultCount ? JSON.stringify(item.counters, null, 2) : item.error?.message ?? "不能据此认定免费或零消费")}</pre>`]);
    var windows = [];
    for (const limit of report.codex?.limits ?? []) for (const key of ["primary", "secondary"]) {
      const window = limit[key];
      if (!window) continue;
      const minutes = window.windowDurationMins;
      const label = minutes && minutes % 1440 === 0 ? `${minutes / 1440}天` : minutes && minutes % 60 === 0 ? `${minutes / 60}小时` : `${minutes ?? "未知"}分钟`;
      windows.push(`<div class="window"><strong>Codex ${esc(label)} · 剩余 ${esc(window.remainingPercent)}%</strong><progress max="100" value="${Number(window.remainingPercent)}" aria-label="Codex ${esc(label)}剩余"></progress><small>重置 ${esc(date(window.resetsAt))}</small></div>`);
    }
    var codexCredits = report.codex?.limits?.map((limit) => limit.credits).filter(Boolean) ?? [];
    var limitsRows = report.limits ? [["组织月度支出上限", limitDetail(report.limits.organization)],
      ...report.limits.projects.flatMap((project) => [[`${esc(project.label)} 模型速率上限`, limitDetail(project.rates)], [`${esc(project.label)} 月度支出上限`, limitDetail(project.spend)]])] : [];
    var catalog = ["资金与到期", "消费与计价", "限额与产品边界"].map((group) => `<div class="block"><h2>${esc(group)}</h2><div class="rules">${report.catalog.filter((item) => item.group === group).map((item) => `<article class="rule"><strong>${esc(item.name)}</strong> <span class="pill">${esc(item.unit)}</span><p>${esc(item.access)}</p><p><code>${esc(item.formula)}</code></p><small>${esc(item.note)} <a href="${esc(report.sources[item.source])}" target="_blank" rel="noreferrer">官方资料</a></small></article>`).join("")}</div></div>`).join("");
    document.getElementById("app").innerHTML = `
      <header><div><p class="muted">CODEX QUOTA · 本地只读研究</p><h1>额度，按来源和用途分开看</h1></div><small>用量截止 ${esc(date(cycle.range.endUtc))}<br>页面生成 ${esc(date(report.generatedAt))} · 上海时区</small></header>
      <div class="metrics">${metric("组织总余额", "未知", "购买与其他发放记录尚未取得")}${metric("本期赠送估算", usd(funds.subscriptionEstimateUsd), "文本用量与配置价格计算", "good")}${metric("购买余额", "未知", "未取得不等于没有购买")}${metric("本期文本消费估算", usd(funds.estimatedConsumptionUsd, 6), "含缓存命中与缓存写入")}</div>
      <div class="notice">${esc(funds.explanation)} 当前估算与用户参考金额 ${usd(calc.referenceBalanceUsd)} ${calc.matchesReferenceDisplay ? "在两位小数上相同" : "未确认一致"}。所有演示金额仅在本页计算。</div>
      <nav role="tablist" aria-label="额度分类">${[["funding","资金分类"],["usage","消费明细"],["limits","Codex 与限额"],["rules","规则与来源"],["scenario","扣减演示"]].map(([id,label],index) => `<button role="tab" id="tab-${id}" aria-controls="${id}" aria-selected="${index === 0}" type="button">${label}</button>`).join("")}</nav>
      <section role="tabpanel" id="funding" aria-labelledby="tab-funding"><h2>可抵扣资金</h2>${table(["分类","已知发放","本期消费估算","剩余","到期","来源 / 范围"],fundingRows)}<div class="block"><h2>已知到期批次</h2><p>${esc(cycle.cycle.end.slice(0,10))} · 本期赠送估算剩余 ${usd(funds.subscriptionEstimateUsd)}</p><small>仅确认日历日期；UTC 零点是假设。其他批次未知，因此不能断言这是整个组织最近的一笔到期。</small></div><div class="block"><h2>账本如何计算</h2><p>按时间顺序处理发放、充值、消费、到期、退款或撤销。适用消费先扣赠送，再扣购买；不同批次保留自己的到期日期。</p><p class="muted">总余额、赠送估算与 Codex 百分比各自展示，避免合计不同单位。</p></div></section>
      <section role="tabpanel" id="usage" aria-labelledby="tab-usage" hidden><h2>文本消费拆分</h2><p class="muted">普通输入、缓存命中、缓存写入互斥计价；下表 token 数来自管理员 Usage。</p>${table(["模型","普通输入","缓存命中","30m写入","12h写入","输出","估算 USD","服务层级"],costRows)}<div class="block"><p>Costs：HTTP ${esc(cycle.costs.statuses.join(", "))} · ${calc.observedCostUsd === null ? "没有有效美元费用记录" : usd(calc.observedCostUsd,7)}。观测费用与文本估算独立对照，不重复扣减。</p></div><div class="block"><h2>其他收费类型的用量观测</h2>${table(["类别","HTTP","记录状态","原始计数 / 说明"],auxiliaryRows)}</div><details class="block"><summary>查看计算限制与价格来源</summary><ul>${calc.limitations.map((note) => `<li>${esc(note)}</li>`).join("")}</ul><a href="${esc(report.sources.prices)}" target="_blank" rel="noreferrer">官方价格</a></details></section>
      <section role="tabpanel" id="limits" aria-labelledby="tab-limits" hidden><h2>Codex 使用窗口</h2>${windows.join("") || `<p>${esc(report.codex?.error ?? "没有返回可显示窗口")}</p>`}<p>Codex 内部 credits（原单位）：${codexCredits.length ? `<code>${esc(JSON.stringify(codexCredits))}</code>` : "未知 / 本次未返回"}</p><small>这些窗口和内部 credits 不计入 API 美元总额。</small><div class="block"><h2>组织与项目的预算 / 速率上限</h2><p class="muted">上限不是剩余资金；缺少实时已用速率或同预算周期支出时，不计算“剩余限额”。项目列表 HTTP ${esc(report.limits?.projectListStatus ?? "未采集")}，已查 ${esc(report.limits?.projectsQueried ?? 0)} 个${report.limits?.moreProjects ? "，仍有未采集项目" : ""}。</p>${table(["作用域 / 类型","本次观测"],limitsRows)}</div></section>
      <section role="tabpanel" id="rules" aria-labelledby="tab-rules" hidden>${catalog}</section>
      <section role="tabpanel" id="scenario" aria-labelledby="tab-scenario" hidden><h2>赠送、购买与到期的扣减演示</h2><p class="notice">这是可编辑的假设情景，不是账户购买记录，不会发送充值、消费或设置请求。初始赠送取本期估算；购买到期日请按演示需要调整。同类多笔按最近到期优先仅作研究假设。</p><div class="controls"><label>假设新增购买 USD<input id="demo-purchase" type="number" min="0" step="0.01"></label><label>假设新增消费 USD<input id="demo-spend" type="number" min="0" step="0.01"></label><label>演示购买到期日<input id="demo-expiry" type="date"></label><label>演示时刻<select id="demo-time"><option value="now">快照时刻</option><option value="expired">赠送到期时</option></select></label></div><div id="scenario-result" aria-live="polite"></div></section>
      <footer>本页是离线快照，不会自动刷新。更新数据请重新运行 research 中的采集脚本。没有取得的数据保持未知；详情保存在同目录 quota-overview.json。</footer>`;

    for (const button of document.querySelectorAll('[role="tab"]')) button.addEventListener("click", () => {
      for (const tab of document.querySelectorAll('[role="tab"]')) tab.setAttribute("aria-selected", String(tab === button));
      for (const panel of document.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.id !== button.getAttribute("aria-controls");
    });
    const purchaseInput = document.getElementById("demo-purchase");
    const spendInput = document.getElementById("demo-spend");
    const expiryInput = document.getElementById("demo-expiry");
    const timeInput = document.getElementById("demo-time");
    purchaseInput.value = report.simulationDefaults.purchaseUsd;
    spendInput.value = report.simulationDefaults.spendUsd;
    const expiry = new Date(report.generatedAt);
    expiry.setUTCMonth(expiry.getUTCMonth() + report.simulationDefaults.purchaseExpiryMonths);
    expiryInput.value = expiry.toISOString().slice(0,10);
    /** 根据用户本地演示输入重新分配消费；无参数，无返回值，所有状态只保存在内存。 */
    function updateScenario() {
      const target = document.getElementById("scenario-result");
      try {
        if (purchaseInput.value.trim() === "" || spendInput.value.trim() === "" || funds.subscriptionEstimateUsd === null) {
          throw new Error("请填写演示金额；赠送估算未知时无法启动此情景。");
        }
        const asOf = timeInput.value === "expired" ? cycle.cycle.end : cycle.range.endUtc;
        const result = creditMath.simulateSpend([
          { id: "demo-promotion", kind: "promotion", amountUsd: funds.subscriptionEstimateUsd,
            issuedAt: cycle.range.endUtc, expiresAt: cycle.cycle.end },
          { id: "demo-purchase", kind: "purchased", amountUsd: Number(purchaseInput.value),
            issuedAt: cycle.range.endUtc, expiresAt: `${expiryInput.value}T23:59:59Z` }
        ], Number(spendInput.value), asOf);
        target.innerHTML = `<strong>演示结果：剩余 ${usd(result.totalRemainingUsd)}</strong><p>赠送 ${usd(result.promotionRemainingUsd)} · 购买 ${usd(result.purchasedRemainingUsd)} · 到期失效 ${usd(result.expiredUsd)} · 未覆盖消费 ${usd(result.uncoveredUsd)}</p>${table(["演示批次","本次扣减","剩余","状态"],result.rows.map((row) => [row.kind === "promotion" ? "赠送" : "购买", usd(row.deductedUsd), usd(row.remainingUsd), row.expired ? "到期" : row.active ? "有效" : "未生效"]))}`;
      } catch (error) { target.innerHTML = `<p role="alert">${esc(error.message)}</p>`; }
    }
    for (const input of [purchaseInput, spendInput, expiryInput, timeInput]) input.addEventListener("input", updateScenario);
    updateScenario();
  }
  renderOverview();
}
