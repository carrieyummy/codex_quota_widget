const i18n = {
  zh: {
    brand: "Codex 额度",
    loading: "读取中",
    ready: "已更新",
    warning: "接近用尽",
    danger: "额度告急",
    empty: "额度用尽",
    error: "读取失败",
    primary: "5小时",
    secondary: "7天",
    palette: "调色盘",
    bgColor: "背景色",
    textColor: "字体色",
    opacity: "透明度",
    fontScale: "字体",
    refresh: "刷新",
    hide: "隐藏",
    exit: "退出",
    edgeDock: "贴边收起",
    restore: "恢复窗口",
    pin: "置顶",
    unpin: "取消置顶",
    reading: "正在读取 Codex 额度...",
    noData: "未读到额度窗口",
    unknown: "未知",
    after: "后",
    used: "已用",
    lang: "EN"
  },
  en: {
    brand: "Codex Quota",
    loading: "Loading",
    ready: "Updated",
    warning: "Running low",
    danger: "Critical",
    empty: "Quota empty",
    error: "Read failed",
    primary: "5h",
    secondary: "7d",
    palette: "Theme",
    bgColor: "Color",
    textColor: "Text",
    opacity: "Opacity",
    fontScale: "Font",
    refresh: "Refresh",
    hide: "Hide",
    exit: "Exit",
    edgeDock: "Edge dock",
    restore: "Restore window",
    pin: "Pin",
    unpin: "Unpin",
    reading: "Reading Codex quota...",
    noData: "No quota window found",
    unknown: "Unknown",
    after: "left",
    used: "used",
    lang: "中"
  }
};

let language = localStorage.getItem("language") || "zh";
let isAlwaysOnTop = true;
let edgeDockEnabled = localStorage.getItem("edgeDockEnabled") !== "false";
let edgeDockState = { enabled: edgeDockEnabled, docked: false, edge: null };
let refreshTimer = null;
let latestQuota = null;
let windowLimits = null;
let lockedWidgetHeight = null;
let appliedFontScale = null;
let reportedExpandedSparkVisible = null;
let sparkVisibilityFrame = null;

const THEME_CONFIG = {
  // 默认背景色；本地没有保存主题时使用。
  defaultBackgroundColor: "#ffffff",
  // 默认文字色；背景色较深时也会作为推荐文字色。
  defaultTextColor: "#ffae00",
  // 默认背景不透明度，单位是百分比。
  defaultOpacity: 16,
  // 透明度滑块和运行时校验共用的最低值；需要更透明时只改这里。
  minOpacity: 0,
  // 透明度滑块和运行时校验共用的最高值。
  maxOpacity: 95,
  defaultFontScale: 1,
  minFontScale: 1,
  maxFontScale: 1.8,
  fontScaleStep: 0.05,
  // 背景渐变较实一端比当前透明度额外增加的 alpha。
  strongAlphaOffset: 0.12,
  // 背景渐变较实一端的 alpha 上限，避免高透明度时完全糊成实色。
  maxStrongAlpha: 0.96
};

const els = {
  body: document.body,
  trafficLight: document.getElementById("trafficLight"),
  stateText: document.getElementById("stateText"),
  brandName: document.getElementById("brandName"),
  paletteBtn: document.getElementById("paletteBtn"),
  themeOverlay: document.getElementById("themeOverlay"),
  themePanel: document.getElementById("themePanel"),
  bgColorInput: document.getElementById("bgColorInput"),
  textColorInput: document.getElementById("textColorInput"),
  opacityInput: document.getElementById("opacityInput"),
  fontScaleInput: document.getElementById("fontScaleInput"),
  bgColorLabel: document.getElementById("bgColorLabel"),
  textColorLabel: document.getElementById("textColorLabel"),
  opacityLabel: document.getElementById("opacityLabel"),
  fontScaleLabel: document.getElementById("fontScaleLabel"),
  langBtn: document.getElementById("langBtn"),
  pinBtn: document.getElementById("pinBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  minimizeBtn: document.getElementById("minimizeBtn"),
  closeBtn: document.getElementById("closeBtn"),
  dockStrip: document.getElementById("dockStrip"),
  dockTrafficLight: document.getElementById("dockTrafficLight"),
  dockCodexPrimary: document.getElementById("dockCodexPrimary"),
  dockCodexPrimaryReset: document.getElementById("dockCodexPrimaryReset"),
  dockCodexSecondary: document.getElementById("dockCodexSecondary"),
  dockSparkPrimary: document.getElementById("dockSparkPrimary"),
  dockSparkPrimaryReset: document.getElementById("dockSparkPrimaryReset"),
  dockSparkSecondary: document.getElementById("dockSparkSecondary"),
  dockUpdatedAt: document.getElementById("dockUpdatedAt"),
  quotaList: document.getElementById("quotaList")
};

function t(key) {
  return i18n[language][key];
}

function applyLabels() {
  els.brandName.textContent = t("brand");
  els.langBtn.textContent = t("lang");
  els.paletteBtn.title = t("palette");
  els.paletteBtn.setAttribute("aria-label", t("palette"));
  els.bgColorLabel.textContent = t("bgColor");
  els.textColorLabel.textContent = t("textColor");
  els.opacityLabel.textContent = t("opacity");
  els.fontScaleLabel.textContent = t("fontScale");
  els.refreshBtn.title = t("refresh");
  els.refreshBtn.setAttribute("aria-label", t("refresh"));
  els.closeBtn.title = t("hide");
  els.closeBtn.setAttribute("aria-label", t("hide"));
  els.dockStrip.setAttribute("aria-label", t("restore"));
  updatePinButton();
  updateEdgeDockButton();
  updateDockSummary(latestQuota);
}

function loadTheme() {
  const backgroundColor = localStorage.getItem("theme.backgroundColor") || THEME_CONFIG.defaultBackgroundColor;

  return {
    backgroundColor,
    textColor: localStorage.getItem("theme.textColor") || THEME_CONFIG.defaultTextColor,
    opacity: normalizeOpacity(localStorage.getItem("theme.backgroundOpacity")),
    fontScale: normalizeFontScale(localStorage.getItem("theme.fontScale"))
  };
}

function saveTheme(theme) {
  localStorage.setItem("theme.backgroundColor", theme.backgroundColor);
  localStorage.setItem("theme.textColor", theme.textColor);
  localStorage.setItem("theme.backgroundOpacity", String(theme.opacity));
  localStorage.setItem("theme.fontScale", String(theme.fontScale));
}

function applyTheme(theme) {
  const backgroundRgb = hexToRgb(theme.backgroundColor) || hexToRgb(THEME_CONFIG.defaultBackgroundColor);
  const textRgb = hexToRgb(theme.textColor) || hexToRgb(THEME_CONFIG.defaultTextColor);
  const opacity = normalizeOpacity(theme.opacity);
  const fontScale = normalizeFontScale(theme.fontScale);
  const alpha = opacity / 100;

  document.documentElement.style.setProperty("--glass-rgb", `${backgroundRgb.r}, ${backgroundRgb.g}, ${backgroundRgb.b}`);
  document.documentElement.style.setProperty("--glass-alpha", alpha.toFixed(2));
  document.documentElement.style.setProperty("--glass-alpha-strong", Math.min(THEME_CONFIG.maxStrongAlpha, alpha + THEME_CONFIG.strongAlphaOffset).toFixed(2));
  document.documentElement.style.setProperty("--text", `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, 0.94)`);
  document.documentElement.style.setProperty("--muted", `rgba(${textRgb.r}, ${textRgb.g}, ${textRgb.b}, 0.68)`);
  document.documentElement.style.setProperty("--font-scale", fontScale.toFixed(2));
  applyScaledLengthVariables(fontScale);
  syncFontScaleToWindow(fontScale);
}

function applyScaledLengthVariables(fontScale) {
  const scale = normalizeFontScale(fontScale);
  const scaledLengths = {
    "--font-size-10": 10,
    "--font-size-11": 11,
    "--font-size-14": 14,
    "--ui-1": 1,
    "--ui-2": 2,
    "--ui-4": 4,
    "--ui-5": 5,
    "--ui-6": 6,
    "--ui-7": 7,
    "--ui-8": 8,
    "--ui-11": 11,
    "--ui-14": 14,
    "--ui-18": 18,
    "--ui-20": 20,
    "--ui-26": 26,
    "--ui-28": 28,
    "--ui-40": 40,
    "--ui-46": 46,
    "--quota-label-column": 36,
    "--quota-progress-column": 120
  };

  for (const [name, basePx] of Object.entries(scaledLengths)) {
    document.documentElement.style.setProperty(name, `${(basePx * scale).toFixed(2)}px`);
  }
}

function syncFontScaleToWindow(fontScale) {
  const nextFontScale = normalizeFontScale(fontScale);
  if (appliedFontScale === nextFontScale) return;

  appliedFontScale = nextFontScale;
  window.codexQuota?.setFontScale?.(nextFontScale)
    .then((limits) => {
      if (!limits) return;
      windowLimits = limits;
      updateLimitLayout();
    })
    .catch(() => {});
}

function configureThemeControls() {
  els.opacityInput.min = String(THEME_CONFIG.minOpacity);
  els.opacityInput.max = String(THEME_CONFIG.maxOpacity);
  els.opacityInput.value = String(THEME_CONFIG.defaultOpacity);
  els.fontScaleInput.min = String(THEME_CONFIG.minFontScale);
  els.fontScaleInput.max = String(THEME_CONFIG.maxFontScale);
  els.fontScaleInput.step = String(THEME_CONFIG.fontScaleStep);
  els.fontScaleInput.value = String(THEME_CONFIG.defaultFontScale);
}

function normalizeOpacity(value) {
  const opacity = Number(value);
  return clampNumber(Number.isFinite(opacity) ? opacity : THEME_CONFIG.defaultOpacity, THEME_CONFIG.minOpacity, THEME_CONFIG.maxOpacity);
}

function normalizeFontScale(value) {
  const scale = Number(value);
  return clampNumber(Number.isFinite(scale) ? scale : THEME_CONFIG.defaultFontScale, THEME_CONFIG.minFontScale, THEME_CONFIG.maxFontScale);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16)
  };
}

function getRecommendedTextColor(backgroundColor) {
  const rgb = hexToRgb(backgroundColor) || hexToRgb(THEME_CONFIG.defaultBackgroundColor);
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.58 ? "#17202a" : THEME_CONFIG.defaultTextColor;
}

function updateThemeFromControls() {
  const theme = {
    backgroundColor: els.bgColorInput.value,
    textColor: els.textColorInput.value,
    opacity: normalizeOpacity(els.opacityInput.value),
    fontScale: normalizeFontScale(els.fontScaleInput.value)
  };

  els.opacityInput.value = String(theme.opacity);
  els.fontScaleInput.value = String(theme.fontScale);
  applyTheme(theme);
  saveTheme(theme);
}

function updateBackgroundTheme() {
  els.textColorInput.value = getRecommendedTextColor(els.bgColorInput.value);
  updateThemeFromControls();
}

function updatePinButton() {
  const label = isAlwaysOnTop ? t("unpin") : t("pin");
  els.pinBtn.classList.toggle("active", isAlwaysOnTop);
  els.pinBtn.title = label;
  els.pinBtn.setAttribute("aria-label", label);
}

function updateEdgeDockButton() {
  const label = t("edgeDock");
  els.minimizeBtn.classList.toggle("active", edgeDockEnabled);
  els.minimizeBtn.title = label;
  els.minimizeBtn.setAttribute("aria-label", label);
  els.minimizeBtn.setAttribute("aria-pressed", String(edgeDockEnabled));
}

function setState(state, message) {
  els.body.dataset.state = state;
  els.trafficLight.classList.toggle("loading", state === "loading");
  els.dockTrafficLight.classList.toggle("loading", state === "loading");
  els.stateText.textContent = message || t(state === "loading" ? "loading" : state);
}

function stateForRemaining(percent) {
  if (percent <= 0) return "empty";
  if (percent < 10) return "danger";
  if (percent < 30) return "warning";
  return "ready";
}

function getWindowPercent(window) {
  if (!window || !Number.isFinite(window.remainingPercent)) return null;
  return Math.max(0, Math.min(100, Math.round(window.remainingPercent)));
}

function formatWindowValue(window, resetFormat = "auto") {
  if (!window) return "--";
  const remaining = getWindowPercent(window);
  const reset = formatResetTime(window.resetsAt, resetFormat);
  const percentPart = remaining === null ? "--" : `${remaining}%`;
  return reset ? `${percentPart} ${reset}` : percentPart;
}

function formatResetTime(iso, resetFormat = "auto") {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";

  if (resetFormat === "time") {
    return formatClockTime(date);
  }

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    return date.toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  if (language === "en") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function updateQuota(quota) {
  latestQuota = quota;
  const percent = Number.isFinite(quota.remainingPercent) ? quota.remainingPercent : 0;
  const state = stateForRemaining(percent);

  renderQuotaList(quota.limits || []);
  updateDockSummary(quota);
  setState(state, statusTextForQuota(quota, state));
}

function updateDockSummary(quota) {
  const limits = quota?.limits || [];
  const codexLimit = findDockLimit(limits, /codex/i) || limits[0];
  const sparkLimit = findDockLimit(limits, /spark|gpt/i, codexLimit) || limits.find((limit) => limit !== codexLimit);
  const fetchedAt = quota?.fetchedAt ? new Date(quota.fetchedAt) : null;

  els.dockCodexPrimary.textContent = formatCompactPercent(codexLimit?.primary);
  els.dockCodexPrimaryReset.textContent = formatCompactReset(codexLimit?.primary, "time");
  els.dockCodexSecondary.textContent = formatCompactPercent(codexLimit?.secondary);
  els.dockSparkPrimary.textContent = formatCompactPercent(sparkLimit?.primary);
  els.dockSparkPrimaryReset.textContent = formatCompactReset(sparkLimit?.primary, "time");
  els.dockSparkSecondary.textContent = formatCompactPercent(sparkLimit?.secondary);
  els.dockUpdatedAt.textContent = fetchedAt && Number.isFinite(fetchedAt.getTime()) ? formatClockTime(fetchedAt) : "--:--";
}

function findDockLimit(limits, pattern, excludedLimit) {
  return limits.find((limit) => {
    if (limit === excludedLimit) return false;
    return pattern.test(`${limit.limitId || ""} ${limit.limitName || ""}`);
  });
}

function formatCompactPercent(window) {
  if (!window || !Number.isFinite(window.remainingPercent)) return "--";
  return `${Math.round(window.remainingPercent)}%`;
}

function formatCompactReset(window, resetFormat = "auto") {
  return formatResetTime(window?.resetsAt, resetFormat) || "--:--";
}

function renderQuotaList(limits) {
  els.quotaList.replaceChildren();

  for (const limit of limits) {
    const group = document.createElement("section");
    group.className = "quota-group";
    group.dataset.limitId = limit.limitId || "";
    if (limit.limitId !== "codex") group.classList.add("secondary-limit");

    const title = document.createElement("h2");
    title.textContent = limit.limitName || t("unknown");
    group.appendChild(title);

    group.appendChild(createQuotaRow(t("primary"), limit.primary, "primary"));
    group.appendChild(createQuotaRow(t("secondary"), limit.secondary, "secondary"));
    els.quotaList.appendChild(group);
  }

  updateLimitLayout();
}

function createQuotaRow(label, window, type) {
  const row = document.createElement("div");
  row.className = `quota-row ${type}`;
  const percent = getWindowPercent(window);
  const quotaState = percent === null ? "unknown" : stateForRemaining(percent);
  row.dataset.quotaState = quotaState;

  const labelEl = document.createElement("span");
  labelEl.className = "quota-label";
  labelEl.textContent = `${label}:`;

  const progressEl = document.createElement("div");
  progressEl.className = "quota-progress";
  progressEl.style.setProperty("--quota-percent", String(percent ?? 0));
  progressEl.style.setProperty("--quota-progress", `${percent ?? 0}%`);
  progressEl.setAttribute("role", "progressbar");
  progressEl.setAttribute("aria-label", label);
  progressEl.setAttribute("aria-valuemin", "0");
  progressEl.setAttribute("aria-valuemax", "100");
  if (percent === null) {
    progressEl.setAttribute("aria-valuetext", "--");
  } else {
    progressEl.setAttribute("aria-valuenow", String(percent));
  }

  const progressFillEl = document.createElement("span");
  progressFillEl.className = "quota-progress-fill";
  progressEl.appendChild(progressFillEl);

  const valueEl = document.createElement("strong");
  valueEl.className = "quota-value";
  valueEl.textContent = formatWindowValue(window, type === "primary" ? "time" : "auto");

  row.append(labelEl, progressEl, valueEl);
  return row;
}

function statusTextForQuota(quota, state) {
  const fetchedAt = quota.fetchedAt ? new Date(quota.fetchedAt) : new Date();
  const time = formatClockTime(fetchedAt);

  if (!quota.limits || quota.limits.length === 0) return t("noData");
  return `${t(state)} · ${time}`;
}

function formatClockTime(date) {
  return date.toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

async function refreshQuota() {
  clearTimeout(refreshTimer);
  setState("loading");

  try {
    const quota = await window.codexQuota.getQuota();
    updateQuota(quota);
    refreshTimer = setTimeout(refreshQuota, 60000);
  } catch (error) {
    els.quotaList.textContent = "";
    updateDockSummary(latestQuota);
    setState("error", `${t("error")} · ${formatClockTime(new Date())}`);
    refreshTimer = setTimeout(refreshQuota, 60000);
  }
}

async function bootstrap() {
  configureThemeControls();
  if (window.codexQuota?.getWindowLimits) {
    windowLimits = await window.codexQuota.getWindowLimits();
  }
  updateLimitLayout();
  window.addEventListener("resize", updateLimitLayout);

  const theme = loadTheme();
  els.bgColorInput.value = theme.backgroundColor;
  els.textColorInput.value = theme.textColor;
  els.opacityInput.value = String(theme.opacity);
  els.fontScaleInput.value = String(theme.fontScale);
  applyTheme(theme);
  applyLabels();

  if (window.codexQuota) {
    isAlwaysOnTop = await window.codexQuota.getAlwaysOnTop();
    window.codexQuota.setLanguage?.(language);
    edgeDockEnabled = Boolean(await window.codexQuota.setEdgeDockEnabled?.(edgeDockEnabled));
    localStorage.setItem("edgeDockEnabled", String(edgeDockEnabled));
    applyEdgeDockState(await window.codexQuota.getEdgeDockState?.());
    updatePinButton();
    updateEdgeDockButton();
  }

  els.langBtn.addEventListener("click", () => {
    language = language === "zh" ? "en" : "zh";
    localStorage.setItem("language", language);
    window.codexQuota?.setLanguage?.(language);
    applyLabels();
    if (latestQuota) updateQuota(latestQuota);
    else refreshQuota();
  });

  els.paletteBtn.addEventListener("click", toggleThemePanel);
  els.bgColorInput.addEventListener("input", updateBackgroundTheme);
  els.textColorInput.addEventListener("input", updateThemeFromControls);
  els.opacityInput.addEventListener("input", updateThemeFromControls);
  els.fontScaleInput.addEventListener("input", updateThemeFromControls);
  els.themeOverlay.addEventListener("pointerdown", closeThemePanel);
  document.addEventListener("pointerdown", closeThemePanelOnMenuOutsideClick, true);
  els.refreshBtn.addEventListener("click", refreshQuota);
  els.minimizeBtn.addEventListener("click", toggleEdgeDock);
  els.closeBtn.addEventListener("click", () => window.codexQuota?.minimize());
  els.dockStrip.addEventListener("click", restoreEdgeDock);
  els.dockStrip.addEventListener("keydown", restoreEdgeDockFromKeyboard);
  document.querySelector(".content")?.addEventListener("scroll", scheduleExpandedSparkVisibilityReport);
  initResizeHandles();
  els.pinBtn.addEventListener("click", async () => {
    isAlwaysOnTop = await window.codexQuota.setAlwaysOnTop(!isAlwaysOnTop);
    updatePinButton();
  });

  window.codexQuota?.onRefresh(refreshQuota);
  window.codexQuota?.onAlwaysOnTopChanged((value) => {
    isAlwaysOnTop = value;
    updatePinButton();
  });
  window.codexQuota?.onEdgeDockChanged(applyEdgeDockState);
  window.codexQuota?.onEdgeDockEnabledChanged((value) => {
    edgeDockEnabled = Boolean(value);
    localStorage.setItem("edgeDockEnabled", String(edgeDockEnabled));
    updateEdgeDockButton();
  });

  refreshQuota();
}

bootstrap();

async function toggleEdgeDock() {
  if (!window.codexQuota?.setEdgeDockEnabled) return;
  edgeDockEnabled = await window.codexQuota.setEdgeDockEnabled(!edgeDockEnabled);
  localStorage.setItem("edgeDockEnabled", String(edgeDockEnabled));
  updateEdgeDockButton();
}

function applyEdgeDockState(state) {
  if (!state) return;
  edgeDockState = {
    enabled: Boolean(state.enabled),
    docked: Boolean(state.docked),
    compact: Boolean(state.compact),
    edge: state.edge || null
  };
  edgeDockEnabled = edgeDockState.enabled;

  els.body.dataset.edgeDock = edgeDockState.docked ? "docked" : "expanded";
  if (edgeDockState.docked && edgeDockState.edge) {
    els.body.dataset.dockEdge = edgeDockState.edge;
    els.body.dataset.dockContent = edgeDockState.compact ? "codex-only" : "full";
  } else {
    delete els.body.dataset.dockEdge;
    delete els.body.dataset.dockContent;
  }

  localStorage.setItem("edgeDockEnabled", String(edgeDockEnabled));
  updateEdgeDockButton();
  if (!edgeDockState.docked) {
    updateLimitLayout();
  } else {
    scheduleExpandedSparkVisibilityReport();
  }
}

function restoreEdgeDock(event) {
  if (!edgeDockState.docked) return;
  event?.preventDefault();
  window.codexQuota?.restoreEdgeDock?.();
}

function restoreEdgeDockFromKeyboard(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  restoreEdgeDock(event);
}

function initResizeHandles() {
  for (const handle of document.querySelectorAll(".resize-handle")) {
    handle.addEventListener("pointerdown", startWindowResize);
  }
}

async function startWindowResize(event) {
  if (!window.codexQuota?.getWindowBounds || !window.codexQuota?.setWindowBounds) return;
  closeThemePanel();
  event.preventDefault();
  event.stopPropagation();

  const handle = event.currentTarget;
  const edge = handle.dataset.edge || "";
  const startBounds = await window.codexQuota.getWindowBounds();
  const startX = event.screenX;
  const startY = event.screenY;

  handle.setPointerCapture?.(event.pointerId);

  const onPointerMove = (moveEvent) => {
    const dx = moveEvent.screenX - startX;
    const dy = moveEvent.screenY - startY;
    window.codexQuota.setWindowBounds(calculateResizeBounds(startBounds, edge, dx, dy));
  };

  const onPointerUp = () => {
    handle.releasePointerCapture?.(event.pointerId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function calculateResizeBounds(startBounds, edge, dx, dy) {
  const next = { ...startBounds };
  if (!windowLimits) return next;

  if (edge.includes("s")) {
    next.height = clampNumber(startBounds.height + dy, windowLimits.minHeight, windowLimits.maxHeight);
  }

  if (edge.includes("n")) {
    const height = clampNumber(startBounds.height - dy, windowLimits.minHeight, windowLimits.maxHeight);
    next.y = startBounds.y + (startBounds.height - height);
    next.height = height;
  }

  if (edge.includes("e")) {
    next.width = clampNumber(startBounds.width + dx, windowLimits.minWidth, windowLimits.maxWidth);
  }

  if (edge.includes("w")) {
    const width = clampNumber(startBounds.width - dx, windowLimits.minWidth, windowLimits.maxWidth);
    next.x = startBounds.x + (startBounds.width - width);
    next.width = width;
  }

  return next;
}

function updateLimitLayout() {
  if (!windowLimits) {
    delete els.body.dataset.limitLayout;
    scheduleExpandedSparkVisibilityReport();
    return;
  }

  const layoutHeight = lockedWidgetHeight || window.innerHeight;

  if (layoutHeight <= windowLimits.primaryOnlyHeightThreshold) {
    els.body.dataset.limitLayout = "primary-only";
  } else if (canShowSparkInFullLayout()) {
    els.body.dataset.limitLayout = "full";
  } else {
    els.body.dataset.limitLayout = "codex-only";
  }

  scheduleExpandedSparkVisibilityReport();
}

function canShowSparkInFullLayout() {
  const sparkGroup = getSparkGroup();
  if (!sparkGroup) {
    const layoutHeight = lockedWidgetHeight || window.innerHeight;
    return layoutHeight > windowLimits.codexOnlyHeightThreshold;
  }

  const previousLayout = els.body.dataset.limitLayout;
  els.body.dataset.limitLayout = "full";

  const isVisible = isSparkGroupVisibleInExpandedWindow(sparkGroup);

  if (previousLayout) {
    els.body.dataset.limitLayout = previousLayout;
  } else {
    delete els.body.dataset.limitLayout;
  }

  return isVisible;
}

function scheduleExpandedSparkVisibilityReport() {
  if (sparkVisibilityFrame !== null) return;

  sparkVisibilityFrame = requestAnimationFrame(() => {
    sparkVisibilityFrame = null;
    reportExpandedSparkVisibility();
  });
}

function reportExpandedSparkVisibility() {
  if (!window.codexQuota?.setExpandedSparkVisible) return;
  if (!canReportExpandedSparkVisibility()) return;

  const sparkGroup = getSparkGroup();
  if (!sparkGroup) return;

  const isVisible = isSparkGroupVisibleInExpandedWindow(sparkGroup);
  if (reportedExpandedSparkVisible === isVisible) return;

  reportedExpandedSparkVisible = isVisible;
  window.codexQuota.setExpandedSparkVisible(isVisible).catch(() => {});
}

function canReportExpandedSparkVisibility() {
  if (edgeDockState.docked) return false;
  if (!windowLimits) return true;

  return window.innerHeight > windowLimits.dockHeight + 2;
}

function getSparkGroup() {
  return els.quotaList.querySelector(".quota-group.secondary-limit");
}

function isSparkGroupVisibleInExpandedWindow(sparkGroup) {
  const style = getComputedStyle(sparkGroup);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const target = sparkGroup.querySelector(".quota-row.primary") || sparkGroup;
  const targetRect = target.getBoundingClientRect();
  const contentRect = document.querySelector(".content")?.getBoundingClientRect();
  const widgetRect = document.querySelector(".widget")?.getBoundingClientRect();
  if (!contentRect || !widgetRect || targetRect.width <= 0 || targetRect.height <= 0) return false;

  const clipRect = {
    top: Math.max(0, contentRect.top, widgetRect.top),
    right: Math.min(window.innerWidth, contentRect.right, widgetRect.right),
    bottom: Math.min(window.innerHeight, contentRect.bottom, widgetRect.bottom),
    left: Math.max(0, contentRect.left, widgetRect.left)
  };

  const visibleWidth = Math.min(targetRect.right, clipRect.right) - Math.max(targetRect.left, clipRect.left);
  const visibleHeight = Math.min(targetRect.bottom, clipRect.bottom) - Math.max(targetRect.top, clipRect.top);
  return visibleWidth > 1 && visibleHeight > 1;
}

async function toggleThemePanel() {
  const willOpen = els.themePanel.hidden;
  if (willOpen) {
    await openThemePanel();
  } else {
    await closeThemePanel();
  }
}

function closeThemePanelOnMenuOutsideClick(event) {
  if (els.themePanel.hidden) return;
  if (els.themePanel.contains(event.target) || els.paletteBtn.contains(event.target)) return;

  closeThemePanel();
}

async function openThemePanel() {
  lockedWidgetHeight = window.innerHeight;
  document.documentElement.style.setProperty("--widget-height", `${lockedWidgetHeight}px`);
  els.body.dataset.themePanel = "open";
  await window.codexQuota?.setThemePanelOpen?.(true);
  updateThemePanelPosition();
  els.themePanel.hidden = false;
  els.themeOverlay.hidden = false;
  els.paletteBtn.classList.add("active");
  els.paletteBtn.blur();
  updateLimitLayout();
}

function updateThemePanelPosition() {
  const buttonRect = els.paletteBtn.getBoundingClientRect();
  const panelWidth = Math.min(170, Math.max(0, window.innerWidth - 16));
  const panelLeft = clampNumber(buttonRect.left + buttonRect.width / 2 - panelWidth / 2, 8, Math.max(8, window.innerWidth - panelWidth - 8));
  const panelTop = buttonRect.bottom + getScaledLength("--ui-6", 6);

  document.documentElement.style.setProperty("--theme-panel-left", `${Math.round(panelLeft)}px`);
  document.documentElement.style.setProperty("--theme-panel-top", `${Math.round(panelTop)}px`);
}

function getScaledLength(name, fallback) {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

async function closeThemePanel() {
  if (els.themePanel.hidden && !lockedWidgetHeight) return;
  updateThemeFromControls();
  els.themePanel.hidden = true;
  els.themeOverlay.hidden = true;
  els.paletteBtn.classList.remove("active");
  await window.codexQuota?.setThemePanelOpen?.(false);
  lockedWidgetHeight = null;
  delete els.body.dataset.themePanel;
  document.documentElement.style.removeProperty("--widget-height");
  document.documentElement.style.removeProperty("--theme-panel-left");
  document.documentElement.style.removeProperty("--theme-panel-top");
  updateLimitLayout();
}
