const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { getQuota } = require("./quota-service");

let mainWindow;
let tray;
let isAlwaysOnTop = true;
// 保存窗口位置/尺寸的防抖定时器，避免拖动时频繁写 window-state.json。
let saveBoundsTimer;
// 拖动窗口后延迟检测贴边/边界夹紧，避免每一个 move 事件都立即 setBounds。
let edgeDockMoveTimer;
// 贴边缩略态的鼠标悬停轮询定时器，用于 hover 展开、移出收回。
let edgeDockHoverTimer;
let currentLanguage = "zh";
let latestQuota;
let themePanelBaseBounds = null;
// 贴边收起功能总开关，对应标题栏里的“贴边收起”按钮。
let edgeDockEnabled = false;
// 当前贴边状态。null 表示普通窗口；对象表示已吸附到某个边，并保存 restoreBounds。
let edgeDockState = null;
// true 表示当前是“鼠标悬停后展开的完整窗口预览”，鼠标移出后会恢复缩略条。
let edgeDockPreview = false;
// 防止刚吸附到顶部时鼠标仍在缩略条上，导致立即自动展开。
let edgeDockHoverArmed = false;
// 恢复完整窗口后的短暂抑制时间，避免刚恢复又被顶部吸附逻辑立刻收起。
let edgeDockSuppressedUntil = 0;
// 程序主动 setBounds 时置为 true，用于区分用户拖动和代码调整窗口。
let isApplyingWindowBounds = false;
// 最近一次完整窗口的尺寸/位置。保存状态和从缩略态恢复时都会使用它。
let lastNormalBounds;

const windowShape = {
  windowRadius: 9,
  dockRadius: 9,
  windowBottomGap: 1
};

// 窗口尺寸和贴边行为的主要调参入口。
const windowLimits = {
  // 完整窗口默认宽度；首次启动或状态文件无效时使用。
  defaultWidth: 275,
  // 完整窗口手动调整宽度的下限。
  minWidth: 260,
  // 完整窗口手动调整宽度的上限。
  maxWidth: 320,
  // 同时显示 Codex + Spark 的贴边缩略条宽度。需要留够两个 5 小时重置时间。
  dockFullWidth: 350,
  // 只显示 Codex 限额时的贴边缩略条宽度。调小会更省空间，但要留够 HH:mm Codex: 100% 14:44 100%。
  dockCodexOnlyWidth: 175,
  // 完整窗口可手动缩放到的最小高度。
  minHeight: 74,
  // 完整窗口可手动缩放到的最大高度。
  maxHeight: 130,
  // 顶部贴边缩略条高度。只影响缩略态，不影响完整窗口最小高度。
  dockHeight: 15,
  // 完整窗口高度小于等于这个值时，界面只显示 Codex 限额；贴边后也会隐藏 Spark 并使用 dockCodexOnlyWidth。
  codexOnlyHeightThreshold: 100,
  // 完整窗口高度小于等于这个值时，界面只显示 Codex 的主限额。
  primaryOnlyHeightThreshold: 83,
  themePanelExtraHeight: 92,
  // 距离屏幕/工作区上边缘多少像素以内触发顶部贴边收起。
  edgeThreshold: 32,
  // 从顶部缩略条恢复完整窗口时，向屏幕内部偏移的距离。
  restoreInset: 18
};

// 首次启动或状态文件无效时使用的完整窗口默认尺寸。
const defaultBounds = {
  width: windowLimits.defaultWidth,
  height: windowLimits.maxHeight
};

const trayStates = {
  loading: { color: [156, 168, 184], label: "读取中" },
  ready: { color: [85, 230, 165], label: "额度正常" },
  warning: { color: [255, 209, 102], label: "额度偏低" },
  danger: { color: [255, 102, 122], label: "额度用尽" },
  error: { color: [255, 102, 122], label: "读取失败" }
};

function createWindow() {
  const savedBounds = loadWindowBounds();
  mainWindow = new BrowserWindow({
    width: savedBounds.width,
    height: savedBounds.height,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: Math.min(windowLimits.dockCodexOnlyWidth, windowLimits.minWidth),
    maxWidth: Math.max(windowLimits.maxWidth, windowLimits.dockFullWidth),
    minHeight: windowLimits.dockHeight,
    maxHeight: windowLimits.maxHeight + windowLimits.themePanelExtraHeight,
    frame: false,
    transparent: true,
    resizable: false,
    thickFrame: false,
    hasShadow: false,
    alwaysOnTop: isAlwaysOnTop,
    skipTaskbar: true,
    icon: createTrayIcon("loading"),
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lastNormalBounds = normalizeExpandedBounds(savedBounds);

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    if (!savedBounds.hasPosition) {
      placeWindowNearTray();
      saveWindowBounds();
    }
    updateWindowHitTestShape();
    mainWindow.show();
  });
  mainWindow.on("resize", () => {
    updateWindowHitTestShape();
    rememberNormalBounds();
    scheduleSaveWindowBounds();
  });
  mainWindow.on("move", () => {
    rememberNormalBounds();
    scheduleSaveWindowBounds();
    scheduleEdgeDockCheck();
  });
  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    hideWindowToTray();
  });
}

function placeWindowNearTray() {
  if (!mainWindow) return;
  const display = screen.getPrimaryDisplay();
  const { width, height } = mainWindow.getBounds();
  const { workArea } = display;
  mainWindow.setBounds({
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
    width,
    height
  });
  lastNormalBounds = normalizeExpandedBounds(mainWindow.getBounds());
}

function createTray() {
  tray = new Tray(createTrayIcon("loading"));
  updateTrayStatus("loading");
  rebuildTrayMenu();
  tray.on("click", toggleWindow);
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowBounds() {
  try {
    const state = JSON.parse(fs.readFileSync(getWindowStatePath(), "utf8"));
    const bounds = sanitizeWindowBounds(state);
    if (bounds) return bounds;
  } catch {
    // Use defaults on first run or if the state file is invalid.
  }

  return {
    ...defaultBounds,
    hasPosition: false
  };
}

// 校验保存过的窗口状态：
// 参数 state 是 window-state.json 里读出的对象。
// 返回合法宽高和可用坐标；如果保存位置已完全不可见，则丢弃坐标。
function sanitizeWindowBounds(state) {
  if (!state || typeof state !== "object") return null;
  const width = clampNumber(Math.round(Number(state.width) || defaultBounds.width), windowLimits.minWidth, windowLimits.maxWidth);
  const height = clampNumber(Math.round(Number(state.height) || defaultBounds.height), windowLimits.minHeight, windowLimits.maxHeight);
  const x = Number.isFinite(state.x) ? Math.round(state.x) : undefined;
  const y = Number.isFinite(state.y) ? Math.round(state.y) : undefined;
  const hasPosition = Number.isFinite(x) && Number.isFinite(y);

  if (hasPosition && !isRectVisible({ x, y, width, height })) {
    return {
      width,
      height,
      hasPosition: false
    };
  }

  return {
    width,
    height,
    x,
    y,
    hasPosition
  };
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isRectVisible(bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    return right > workArea.x && bounds.x < workArea.x + workArea.width && bottom > workArea.y && bounds.y < workArea.y + workArea.height;
  });
}

function scheduleSaveWindowBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveWindowBounds, 250);
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (themePanelBaseBounds) return;
  const bounds = getPersistableWindowBounds();

  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), `${JSON.stringify(bounds, null, 2)}\n`, "utf8");
  } catch {
    // Failing to persist window state should not affect quota display.
  }
}

function getPersistableWindowBounds() {
  if (themePanelBaseBounds) return themePanelBaseBounds;
  if (edgeDockState?.restoreBounds) return edgeDockState.restoreBounds;
  if (lastNormalBounds && Number.isFinite(lastNormalBounds.x) && Number.isFinite(lastNormalBounds.y)) return lastNormalBounds;
  return normalizeExpandedBounds(mainWindow.getBounds());
}

// 把任意窗口 bounds 归一化成“完整窗口”尺寸：
// 参数 bounds 可以来自 Electron getBounds() 或保存文件。
// 返回 min/max 限制后的宽高；坐标存在时保留。
function normalizeExpandedBounds(bounds) {
  const height = clampNumber(Math.round(Number(bounds?.height) || defaultBounds.height), windowLimits.minHeight, windowLimits.maxHeight);
  const width = clampNumber(Math.round(Number(bounds?.width) || defaultBounds.width), windowLimits.minWidth, windowLimits.maxWidth);
  const normalized = {
    width,
    height
  };

  if (Number.isFinite(bounds?.x)) normalized.x = Math.round(bounds.x);
  if (Number.isFinite(bounds?.y)) normalized.y = Math.round(bounds.y);
  return normalized;
}

// 记录最近一次完整窗口位置。缩略态和程序主动 setBounds 时不会覆盖它。
function rememberNormalBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || edgeDockState || themePanelBaseBounds || isApplyingWindowBounds) return;
  lastNormalBounds = normalizeExpandedBounds(mainWindow.getBounds());
}

// 渲染层手动调整窗口尺寸时调用：
// 参数 bounds 允许影响 x/y/width/height，但宽高会被夹在 windowLimits 范围内。
// 返回 Electron 实际应用后的窗口 bounds。
function setWindowBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed() || !bounds || typeof bounds !== "object") return null;
  closeThemePanelWindowExpansion();
  if (edgeDockState) return mainWindow.getBounds();
  const current = mainWindow.getBounds();
  const requestedHeight = Number.isFinite(bounds.height) ? Math.round(bounds.height) : current.height;
  const nextBounds = {
    x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : current.x,
    y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : current.y,
    width: clampNumber(Math.round(Number(bounds.width) || current.width), windowLimits.minWidth, windowLimits.maxWidth),
    height: clampNumber(requestedHeight, windowLimits.minHeight, windowLimits.maxHeight)
  };

  applyWindowBounds(nextBounds);
  rememberNormalBounds();
  scheduleSaveWindowBounds();
  return mainWindow.getBounds();
}

function setThemePanelOpen(value) {
  if (value) return openThemePanelWindowExpansion();
  return closeThemePanelWindowExpansion();
}

function openThemePanelWindowExpansion() {
  if (!mainWindow || mainWindow.isDestroyed() || edgeDockState) return null;
  if (themePanelBaseBounds) return themePanelBaseBounds;

  const currentBounds = mainWindow.getBounds();
  themePanelBaseBounds = normalizeExpandedBounds(currentBounds);
  const { workArea } = screen.getDisplayMatching(currentBounds);
  const expandedHeight = Math.min(workArea.height, themePanelBaseBounds.height + windowLimits.themePanelExtraHeight);
  const expandedBounds = {
    ...currentBounds,
    height: expandedHeight
  };

  applyWindowBounds(expandedBounds);
  return themePanelBaseBounds;
}

function closeThemePanelWindowExpansion() {
  if (!mainWindow || mainWindow.isDestroyed() || !themePanelBaseBounds) return null;

  const baseBounds = themePanelBaseBounds;
  themePanelBaseBounds = null;
  const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
  const restoredBounds = clampBoundsToWorkArea(baseBounds, workArea);

  applyWindowBounds(restoredBounds);
  lastNormalBounds = restoredBounds;
  scheduleSaveWindowBounds();
  return restoredBounds;
}

// 程序内部统一使用这个函数改窗口位置/尺寸，方便 isApplyingWindowBounds 屏蔽递归 move/resize。
function applyWindowBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isApplyingWindowBounds = true;
  try {
    mainWindow.setBounds(bounds);
    updateWindowHitTestShape(mainWindow.getBounds());
  } finally {
    isApplyingWindowBounds = false;
  }
}

function updateWindowHitTestShape(bounds = mainWindow?.getBounds()) {
  if (!mainWindow || mainWindow.isDestroyed() || typeof mainWindow.setShape !== "function" || !bounds) return;

  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const isTopDockStrip = Boolean(edgeDockState) && !edgeDockPreview && edgeDockState.edge === "top";
  const shapeHeight = isTopDockStrip ? height : Math.max(1, height - windowShape.windowBottomGap);
  const radius = isTopDockStrip ? windowShape.dockRadius : windowShape.windowRadius;
  const corners = isTopDockStrip
    ? { bottomLeft: true, bottomRight: true }
    : { topLeft: true, topRight: true, bottomLeft: true, bottomRight: true };

  try {
    mainWindow.setShape(createRoundedRectShape(width, shapeHeight, radius, corners));
  } catch {
    // Keep the widget usable if a platform cannot apply custom hit-test shapes.
  }
}

function createRoundedRectShape(width, height, radius, corners) {
  const normalizedRadius = clampNumber(Math.round(radius), 0, Math.floor(Math.min(width, height) / 2));
  if (normalizedRadius <= 0) return [{ x: 0, y: 0, width, height }];

  const rects = [];
  let currentRect = null;

  for (let y = 0; y < height; y += 1) {
    const leftInset = getRoundedCornerInset(y, height, normalizedRadius, corners.topLeft, corners.bottomLeft);
    const rightInset = getRoundedCornerInset(y, height, normalizedRadius, corners.topRight, corners.bottomRight);
    const x = leftInset;
    const rowWidth = Math.max(1, width - leftInset - rightInset);

    if (currentRect && currentRect.x === x && currentRect.width === rowWidth) {
      currentRect.height += 1;
    } else {
      currentRect = { x, y, width: rowWidth, height: 1 };
      rects.push(currentRect);
    }
  }

  return rects;
}

function getRoundedCornerInset(y, height, radius, hasTopCorner, hasBottomCorner) {
  const rowCenter = y + 0.5;

  if (hasTopCorner && rowCenter < radius) {
    return calculateCircleInset(radius - rowCenter, radius);
  }

  if (hasBottomCorner && rowCenter > height - radius) {
    return calculateCircleInset(rowCenter - (height - radius), radius);
  }

  return 0;
}

function calculateCircleInset(distanceFromCenter, radius) {
  const horizontal = Math.sqrt(Math.max(0, radius * radius - distanceFromCenter * distanceFromCenter));
  return Math.ceil(radius - horizontal);
}

// 延迟执行贴边检测和边界夹紧：
// 用户拖动时会连续触发 move，防抖后再处理可以减少窗口抖动。
function scheduleEdgeDockCheck() {
  if (isApplyingWindowBounds || Date.now() < edgeDockSuppressedUntil) return;
  clearTimeout(edgeDockMoveTimer);
  edgeDockMoveTimer = setTimeout(checkEdgeDock, 180);
}

// 拖动后的核心判断：
// 1. 已贴边时，检测是否被用户拖离顶部并恢复完整窗口。
// 2. 普通窗口且开关开启时，只检测上边缘并进入缩略态。
// 3. 非顶部边缘只做工作区边界夹紧。
function checkEdgeDock() {
  if (!mainWindow || mainWindow.isDestroyed() || Date.now() < edgeDockSuppressedUntil) return;
  const bounds = mainWindow.getBounds();
  if (edgeDockState) {
    restoreEdgeDockAfterDrag(bounds);
    return;
  }

  const edgeInfo = edgeDockEnabled ? getTopDockEdgeInfo(bounds) : null;

  if (edgeInfo) {
    dockToTopEdge(edgeInfo.workArea, bounds);
  } else {
    keepWindowInsideWorkAreaBounds(bounds);
  }
}

// 只检测上边缘；左右贴边不再触发缩略显示。
// 参数 bounds 是当前窗口位置；返回 { workArea } 表示可以吸附，否则返回 null。
// 调 windowLimits.edgeThreshold 可以改变“离上边多近才吸附”的距离。
function getTopDockEdgeInfo(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const { bounds: displayBounds, workArea } = display;
  const threshold = windowLimits.edgeThreshold;

  if (isNearStartEdge(bounds.y, displayBounds.y, workArea.y, threshold)) {
    return { workArea };
  }

  return null;
}

function isNearStartEdge(value, screenEdge, workAreaEdge, threshold) {
  return value <= screenEdge + threshold || value <= workAreaEdge + threshold;
}

// 将窗口缩略到屏幕上边缘，并保留完整窗口尺寸用于恢复。
// 参数 workArea 是当前屏幕工作区；bounds 是吸附前完整窗口位置。
// 无返回值，会保存 restoreBounds、切换为缩略条，并启动鼠标悬停监控。
function dockToTopEdge(workArea, bounds) {
  if (!mainWindow || mainWindow.isDestroyed() || edgeDockState) return;

  const restoreBounds = normalizeExpandedBounds(bounds);
  lastNormalBounds = restoreBounds;
  edgeDockState = { edge: "top", restoreBounds };
  edgeDockPreview = false;
  edgeDockHoverArmed = false;
  applyWindowBounds(getDockBounds(restoreBounds, workArea));
  startEdgeDockHoverMonitor();
  sendEdgeDockState();
}

// 计算上边缘缩略条的窗口尺寸。
// 参数 restoreBounds 是完整窗口恢复位置；workArea 是当前屏幕工作区。
// 返回顶部缩略条 bounds；高度由 getDockHeight/windowLimits.dockHeight 控制。
function getDockBounds(restoreBounds, workArea) {
  const width = Math.min(getDockWidth(restoreBounds), workArea.width);
  const height = getDockHeight();

  return {
    x: clampNumber(restoreBounds.x ?? workArea.x, workArea.x, workArea.x + workArea.width - width),
    y: workArea.y,
    width,
    height
  };
}

// 根据收起前的窗口高度决定贴边条宽度。
// 当完整窗口已经低到只显示 Codex 限额时，贴边条也不预留 Spark 的空间。
function getDockWidth(restoreBounds) {
  if (isCodexOnlyHeight(restoreBounds)) {
    return windowLimits.dockCodexOnlyWidth;
  }
  return windowLimits.dockFullWidth;
}

// 高度阈值只在 windowLimits.codexOnlyHeightThreshold 配置；渲染层通过 IPC 读取。
function isCodexOnlyHeight(bounds) {
  const height = Number(bounds?.height);
  return Number.isFinite(height) && height <= windowLimits.codexOnlyHeightThreshold;
}

// 返回缩略条高度。需要调缩略条厚度时改 windowLimits.dockHeight。
function getDockHeight() {
  return windowLimits.dockHeight;
}

// 拖到左、右、下边缘时只夹紧到工作区内，不切换为缩略显示。
// 参数 bounds 是当前窗口位置；无返回值，必要时会把窗口夹回工作区内。
// 只处理左、右、下边界；上边界由贴边收起逻辑处理。
function keepWindowInsideWorkAreaBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { workArea } = screen.getDisplayMatching(bounds);
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - bounds.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - bounds.height);
  const nextX = clampNumber(bounds.x, workArea.x, maxX);
  const nextY = clampNumber(bounds.y, workArea.y, maxY);

  if (nextX === bounds.x && nextY === bounds.y) return;

  applyWindowBounds({ ...bounds, x: nextX, y: nextY });
  rememberNormalBounds();
  scheduleSaveWindowBounds();
}

// 参数 value 为 true/false；返回最终启用状态。
// 关闭时会立即从缩略状态恢复完整窗口。
function setEdgeDockEnabled(value) {
  edgeDockEnabled = Boolean(value);
  if (!edgeDockEnabled) {
    restoreEdgeDock();
  } else {
    scheduleEdgeDockCheck();
  }
  sendEdgeDockEnabled();
  return edgeDockEnabled;
}

// 参数 currentBounds 可选；传入时按当前拖动/预览位置展开，不传则按保存位置展开。
// 返回最新贴边状态对象。
function restoreEdgeDock(currentBounds) {
  if (!mainWindow || mainWindow.isDestroyed() || !edgeDockState) return getEdgeDockState();

  const { edge, restoreBounds } = edgeDockState;
  const displayBounds = currentBounds || mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(displayBounds);
  const nextBounds = getRestoreBounds(edge, restoreBounds, workArea, currentBounds);

  edgeDockState = null;
  edgeDockPreview = false;
  edgeDockHoverArmed = false;
  edgeDockSuppressedUntil = Date.now() + 800;
  stopEdgeDockHoverMonitor();
  applyWindowBounds(nextBounds);
  lastNormalBounds = nextBounds;
  scheduleSaveWindowBounds();
  sendEdgeDockState();
  return getEdgeDockState();
}

// 缩略条被用户向下拖动时调用：离开顶部阈值后恢复完整窗口。
// 参数 bounds 是缩略条当前拖动后的位置。
function restoreEdgeDockAfterDrag(bounds) {
  if (!edgeDockState || edgeDockState.edge !== "top") return;
  const { workArea } = screen.getDisplayMatching(bounds);
  if (bounds.y <= workArea.y + windowLimits.edgeThreshold) {
    rememberTopDockDragPosition(bounds, workArea);
    return;
  }

  restoreEdgeDock(bounds);
}

function rememberTopDockDragPosition(bounds, workArea) {
  if (!edgeDockState || edgeDockState.edge !== "top") return;

  const restoreBounds = normalizeExpandedBounds(edgeDockState.restoreBounds);
  const nextRestoreBounds = clampBoundsToWorkArea(
    {
      ...restoreBounds,
      x: bounds.x
    },
    workArea
  );

  if (nextRestoreBounds.x === restoreBounds.x && nextRestoreBounds.y === restoreBounds.y) return;

  edgeDockState = {
    ...edgeDockState,
    restoreBounds: nextRestoreBounds
  };
  lastNormalBounds = nextRestoreBounds;
  scheduleSaveWindowBounds();
}

// 启动贴边缩略态的鼠标悬停轮询。
// 轮询间隔在 setInterval 第二个参数里，目前是 120ms；越小越灵敏但越频繁。
function startEdgeDockHoverMonitor() {
  if (edgeDockHoverTimer) return;
  edgeDockHoverTimer = setInterval(updateEdgeDockHoverPreview, 120);
}

// 停止鼠标悬停轮询。退出贴边状态和程序退出时都会调用。
function stopEdgeDockHoverMonitor() {
  clearInterval(edgeDockHoverTimer);
  edgeDockHoverTimer = null;
}

// 根据鼠标是否在窗口 bounds 内，控制“悬停展开完整窗口”和“移出恢复缩略条”。
// 无参数；通过 screen.getCursorScreenPoint() 读取当前鼠标屏幕坐标。
function updateEdgeDockHoverPreview() {
  if (!mainWindow || mainWindow.isDestroyed() || !edgeDockState) {
    stopEdgeDockHoverMonitor();
    return;
  }

  const bounds = mainWindow.getBounds();
  const cursor = screen.getCursorScreenPoint();
  const isInsideWindow = isPointInBounds(cursor, bounds);

  if (!edgeDockPreview && !edgeDockHoverArmed) {
    if (!isInsideWindow) edgeDockHoverArmed = true;
    return;
  }

  if (!edgeDockPreview && isInsideWindow) {
    showEdgeDockPreview(bounds);
  } else if (edgeDockPreview && !isInsideWindow) {
    hideEdgeDockPreview();
  }
}

// 判断屏幕坐标 point 是否落在窗口 bounds 内。
// 参数 point 是 {x,y}；bounds 是 Electron BrowserWindow bounds；返回 boolean。
function isPointInBounds(point, bounds) {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

// 鼠标悬停缩略条时显示完整窗口预览。
// 参数 bounds 是缩略条当前 bounds；无返回值，会把窗口高度恢复到完整高度。
function showEdgeDockPreview(bounds) {
  if (!edgeDockState || edgeDockPreview) return;
  const { workArea } = screen.getDisplayMatching(bounds);
  edgeDockPreview = true;
  applyWindowBounds(getEdgeDockPreviewBounds(bounds, edgeDockState.restoreBounds, workArea));
  sendEdgeDockState();
}

// 鼠标移出完整窗口预览时恢复顶部缩略条。
// 无参数；使用当前窗口所在屏幕的 workArea 重新计算缩略条位置。
function hideEdgeDockPreview() {
  if (!edgeDockState || !edgeDockPreview) return;
  const currentBounds = mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(currentBounds);
  rememberTopDockDragPosition(currentBounds, workArea);
  edgeDockPreview = false;
  edgeDockHoverArmed = true;
  applyWindowBounds(getDockBounds(edgeDockState.restoreBounds, workArea));
  sendEdgeDockState();
}

// 计算悬停预览的完整窗口 bounds。
// currentBounds 是当前缩略条位置；restoreBounds 是保存的完整窗口尺寸；workArea 是屏幕工作区。
// 返回值会保持当前 x 位置，y 固定在工作区顶部。
function getEdgeDockPreviewBounds(currentBounds, restoreBounds, workArea) {
  const previewBounds = normalizeExpandedBounds(restoreBounds);
  previewBounds.x = clampNumber(currentBounds.x, workArea.x, workArea.x + workArea.width - previewBounds.width);
  previewBounds.y = workArea.y;
  return previewBounds;
}

// 计算退出贴边状态时的完整窗口 bounds。
// currentBounds 存在时优先使用当前拖动位置；否则从顶部向内偏移 restoreInset。
function getRestoreBounds(edge, restoreBounds, workArea, currentBounds) {
  const nextBounds = normalizeExpandedBounds(restoreBounds);

  if (currentBounds) {
    nextBounds.x = currentBounds.x;
    nextBounds.y = currentBounds.y;
  } else if (edge === "top") {
    nextBounds.y = workArea.y + windowLimits.restoreInset;
  }

  return clampBoundsToWorkArea(nextBounds, workArea);
}

// 把窗口 bounds 限制在 workArea 内。
// 返回新的 bounds 对象，防止窗口超出当前屏幕左右或下边界。
function clampBoundsToWorkArea(bounds, workArea) {
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - bounds.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - bounds.height);

  return {
    ...bounds,
    x: clampNumber(bounds.x ?? workArea.x, workArea.x, maxX),
    y: clampNumber(bounds.y ?? workArea.y, workArea.y, maxY)
  };
}

// 返回给渲染层使用的贴边状态。
// docked=true 表示显示缩略条；preview=true 表示鼠标悬停展开中的完整窗口。
function getEdgeDockState() {
  return {
    enabled: edgeDockEnabled,
    docked: Boolean(edgeDockState) && !edgeDockPreview,
    preview: edgeDockPreview,
    compact: Boolean(edgeDockState && isCodexOnlyHeight(edgeDockState.restoreBounds)),
    edge: edgeDockState?.edge || null
  };
}

function getWindowLimits() {
  return { ...windowLimits };
}

function sendEdgeDockState() {
  mainWindow?.webContents.send("window:edgeDockChanged", getEdgeDockState());
}

function sendEdgeDockEnabled() {
  mainWindow?.webContents.send("window:edgeDockEnabledChanged", edgeDockEnabled);
}

function updateTrayStatus(state, quota = latestQuota) {
  const nextState = trayStates[state] ? state : "loading";
  const icon = createTrayIcon(nextState);

  if (tray) {
    tray.setImage(icon);
    tray.setToolTip(createTrayTooltip(nextState, quota));
  }

  if (mainWindow && typeof mainWindow.setIcon === "function") {
    mainWindow.setIcon(icon);
  }
}

function createTrayTooltip(state, quota) {
  if (!quota?.limits?.length) {
    return `Codex Quota Widget - ${trayStates[state].label}`;
  }

  return [
    "Codex Quota Widget",
    ...quota.limits.map((limit) => `${formatTrayLimitName(limit)}: ${formatTrayWindow("5h", limit.primary)} / ${formatTrayWindow("7d", limit.secondary)}`)
  ].join("\n");
}

function formatTrayLimitName(limit) {
  if (limit.limitId === "codex") return "Codex";
  return limit.limitName || limit.limitId || "Unknown";
}

function formatTrayWindow(label, window) {
  if (currentLanguage === "zh") {
    const zhLabel = label === "5h" ? "5小时额度" : "7天额度";
    return `${zhLabel} ${formatTrayRemaining(window)}`;
  }

  return `${label} limit ${formatTrayRemaining(window)}`;
}

function formatTrayRemaining(window) {
  if (!window || !Number.isFinite(window.remainingPercent)) return "--";
  return `${Math.round(window.remainingPercent)}%`;
}

function getQuotaState(quota) {
  const percent = Number.isFinite(quota?.remainingPercent) ? quota.remainingPercent : 0;
  if (percent <= 0) return "danger";
  if (percent < 10) return "warning";
  return "ready";
}

function createTrayIcon(state) {
  const image = nativeImage.createFromBuffer(createCirclePng(trayStates[state].color));
  image.setTemplateImage(false);
  return image;
}

function createCirclePng(color) {
  const size = 32;
  const center = (size - 1) / 2;
  const radius = 10.8;
  const glowRadius = 15.2;
  const data = Buffer.alloc((size * 4 + 1) * size);

  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    data[rowOffset] = 0;

    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const pixelOffset = rowOffset + 1 + x * 4;

      let alpha = 0;
      if (distance <= radius) {
        alpha = 255;
      } else if (distance <= glowRadius) {
        alpha = Math.round(90 * (1 - (distance - radius) / (glowRadius - radius)));
      }

      const highlight = Math.max(0, 1 - Math.sqrt((x - 12) ** 2 + (y - 10) ** 2) / 14) * 42;
      data[pixelOffset] = Math.min(255, color[0] + highlight);
      data[pixelOffset + 1] = Math.min(255, color[1] + highlight);
      data[pixelOffset + 2] = Math.min(255, color[2] + highlight);
      data[pixelOffset + 3] = alpha;
    }
  }

  return encodePng(size, size, data);
}

function encodePng(width, height, data) {
  const header = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(data)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示/隐藏", click: toggleWindow },
      { label: "刷新额度", click: () => mainWindow?.webContents.send("quota:refresh") },
      {
        label: isAlwaysOnTop ? "取消置顶" : "置顶",
        click: () => setAlwaysOnTop(!isAlwaysOnTop)
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() }
    ])
  );
}

function setAlwaysOnTop(value) {
  isAlwaysOnTop = Boolean(value);
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(isAlwaysOnTop);
    mainWindow.webContents.send("window:alwaysOnTopChanged", isAlwaysOnTop);
  }
  rebuildTrayMenu();
  return isAlwaysOnTop;
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    hideWindowToTray();
  } else {
    showWindowFromTray();
  }
}

function hideWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
}

function showWindowFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSkipTaskbar(true);
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  ipcMain.handle("quota:get", async () => {
    updateTrayStatus("loading");
    try {
      const quota = await getQuota();
      latestQuota = quota;
      updateTrayStatus(getQuotaState(quota), quota);
      return quota;
    } catch (error) {
      updateTrayStatus("error");
      throw error;
    }
  });
  ipcMain.handle("window:minimize", () => hideWindowToTray());
  ipcMain.handle("window:limits:get", () => getWindowLimits());
  ipcMain.handle("window:bounds:get", () => mainWindow?.getBounds());
  ipcMain.handle("window:bounds:set", (_event, bounds) => setWindowBounds(bounds));
  ipcMain.handle("window:themePanel:setOpen", (_event, value) => setThemePanelOpen(value));
  ipcMain.handle("window:alwaysOnTop:get", () => isAlwaysOnTop);
  ipcMain.handle("window:alwaysOnTop:set", (_event, value) => setAlwaysOnTop(value));
  ipcMain.handle("window:edgeDock:get", () => getEdgeDockState());
  ipcMain.handle("window:edgeDock:set", (_event, value) => setEdgeDockEnabled(value));
  ipcMain.handle("window:edgeDock:restore", () => restoreEdgeDock());
  ipcMain.handle("app:language:set", (_event, language) => {
    currentLanguage = language === "en" ? "en" : "zh";
    updateTrayStatus(getQuotaState(latestQuota), latestQuota);
  });
  ipcMain.handle("external:openCodex", () => {
    shell.openPath(path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin", "codex.exe"));
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  clearTimeout(saveBoundsTimer);
  clearTimeout(edgeDockMoveTimer);
  stopEdgeDockHoverMonitor();
  saveWindowBounds();
});
