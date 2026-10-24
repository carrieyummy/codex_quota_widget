const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { app, BrowserWindow, screen, session } = require("electron");

const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "out/codex-only-check");
const profile = path.join(artifacts, "profile");
const restartShort = process.argv.includes("--restart-short");
const restart = process.argv.includes("--restart") || restartShort;
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// Exercise a real BrowserWindow without changing the user's visible windows.
BrowserWindow.prototype.show = function () {};
const reset = Math.floor(new Date("2026-12-31T23:59:00+08:00").getTime() / 1000);
const rawWindow = (usedPercent, windowDurationMins) => ({ usedPercent, windowDurationMins, resetsAt: reset });
const rawCodex = (primary, secondary = null) => ({ limitId: "codex", limitName: "Codex", planType: "plus", primary, secondary });
let fixture;
let quotaError = null;
const errors = [];
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));

async function checkService() {
  const filename = path.join(root, "src/main/quota-service.js");
  const sandbox = { require: Module.createRequire(filename), module: { exports: {} }, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(filename, "utf8") + "\nrequestRateLimits = async () => globalThis.response;", sandbox);
  const service = sandbox.module.exports;
  const query = async response => {
    sandbox.response = response;
    return JSON.parse(JSON.stringify(await service.getQuota()));
  };
  const week = rawCodex(rawWindow(25, 10080));
  let quota = await query({ rateLimitsByLimitId: { codex: week } });
  assert.equal(quota.remainingPercent, 75);
  assert.equal(quota.limits[0].primary.windowDurationMins, 10080);
  assert.equal(quota.limits[0].secondary, null);
  const both = rawCodex(rawWindow(10, 300), rawWindow(35, 10080));
  quota = await query({ rateLimitsByLimitId: { codex: both } });
  assert.equal(quota.remainingPercent, 65);
  const other = { limitId: "codex_other", limitName: "Other", primary: rawWindow(100, 300) };
  quota = await query({ rateLimitsByLimitId: { codex: both, codex_other: other } });
  assert.equal(quota.limits.length, 1);
  assert.equal(quota.remainingPercent, 65);
  assert.equal(quota.planType, "plus");
  for (const response of [
    {}, { rateLimitsByLimitId: {} }, { rateLimitsByLimitId: { codex_other: other } },
    { rateLimits: other }, { rateLimitsByLimitId: {}, rateLimits: both }
  ]) {
    await assert.rejects(query(response), /Codex did not return a rate-limit snapshot/);
  }
  assert.equal((await query({ rateLimits: both })).limits[0].limitId, "codex");
  fixture = await query({ rateLimitsByLimitId: { codex: rawCodex(rawWindow(0, 300), rawWindow(0, 10080)) } });
  console.log("PASS: service selection, weekly-only, dual-window, mixed groups, missing Codex");
}

async function run() {
  await checkService();
  await app.whenReady();
  if (!restart) {
    await session.defaultSession.clearStorageData();
    fs.writeFileSync(path.join(profile, "window-state.json"), JSON.stringify({ width: 350, height: 140, x: 100, y: 200 }));
    fs.writeFileSync(path.join(profile, "font-scale.json"), JSON.stringify({ fontScale: 1 }));
  }
  const quotaPath = path.join(root, "src/main/quota-service.js");
  require.cache[quotaPath] = {
    id: quotaPath, filename: quotaPath, loaded: true,
    exports: { getQuota: async () => { if (quotaError) throw quotaError; return fixture; } }
  };
  const filename = path.join(root, "src/main/main.js");
  const main = new Module(filename, module);
  main.filename = filename;
  main.paths = Module._nodeModulePaths(path.dirname(filename));
  main._compile(fs.readFileSync(filename, "utf8") + `
module.exports = {
  getWindow: () => mainWindow, getWindowLimits, getDefaultBounds, sanitizeWindowBounds,
  getEdgeDockState, dockToTopEdge, showEdgeDockPreview, hideEdgeDockPreview, restoreEdgeDock,
  stopEdgeDockHoverMonitor, setWindowBounds, saveWindowBounds, loadWindowBounds, createTrayTooltip,
  getQuotaState, setEdgeDockEnabled, setEdgeDockMinimal, getDockWidth, getDockBounds, getPersistableWindowBounds,
  initialDockWidth: getDockWidth()
};`, filename);
  const api = main.exports;
  await app.whenReady();
  const win = api.getWindow();
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on("render-process-gone", (_event, details) => errors.push(JSON.stringify(details)));
  await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const js = code => win.webContents.executeJavaScript(code, true);
  const capture = async name => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(artifacts, `${name}.png`), img.toPNG());
  };
  const checkDockContent = async minimal => {
    const metrics = await js(`(() => {
      const strip = document.getElementById('dockStrip');
      return [...strip.children].filter(el => getComputedStyle(el).display !== 'none').map(el => {
        const r = el.getBoundingClientRect();
        return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, text: el.textContent.trim() };
      });
    })()`);
    const bounds = win.getBounds();
    assert.ok(metrics.every(el => el.left >= 0 && el.right <= bounds.width && el.top >= 0 && el.bottom <= bounds.height), JSON.stringify(metrics));
    assert.ok(metrics.every((el, i) => i === 0 || el.left >= metrics[i - 1].right), "dock elements must not overlap");
    if (minimal) {
      assert.deepEqual(metrics.map(el => el.id), ["dockTrafficLight", "dockCodexPrimary", ...(metrics.length === 3 ? ["dockCodexSecondary"] : [])]);
    }
  };
  const checkTitlebar = async () => {
    const metrics = await js(`(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      return { width: innerWidth, brand: rect(document.querySelector('.brand')), actions: rect(document.querySelector('.window-actions')),
        buttons: [...document.querySelectorAll('.window-actions button')].map(rect) };
    })()`);
    assert.equal(metrics.buttons.length, 7);
    assert.ok(metrics.brand.right <= metrics.actions.left, "brand and actions must not overlap");
    assert.ok(metrics.buttons.every((b, i) => b.left >= 0 && b.right <= metrics.width && Math.abs(b.top - metrics.buttons[0].top) < 1 && (i === 0 || b.left >= metrics.buttons[i - 1].right)), JSON.stringify(metrics));
    assert.deepEqual(await js("[els.dockMinimalBtn.previousElementSibling.id, els.dockMinimalBtn.nextElementSibling.id]"), ["langBtn", "pinBtn"]);
  };
  const initialScale = restart && !restartShort ? 1.8 : 1;
  assert.equal(api.initialDockWidth, 160, "before loading saved state, no data uses base width at the default font scale");
  for (let i = 0; i < 100; i++) {
    if (await js(`Boolean(latestQuota && windowLimits && measuredFullHeight && appliedFontScale === ${initialScale})`)) break;
    await delay(30);
  }
  if (restart) {
    if (restartShort) {
      await delay();
      const requiredHeight = await js("measuredFullHeight");
      assert.equal(win.getBounds().height, requiredHeight - 1);
      assert.equal(api.getEdgeDockState().limitLayout, "primary-only");
      assert.equal(await js("getComputedStyle(document.querySelector('.quota-row.secondary')).display"), "none");
      const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
      api.dockToTopEdge(workArea, win.getBounds());
      api.stopEdgeDockHoverMonitor();
      await delay();
      assert.equal(win.getBounds().width, 52);
      assert.equal(await js("els.dockCodexSecondary.textContent"), "");
      await checkDockContent(true);
      await js("toggleDockMinimal()");
      await delay();
      assert.equal(win.getBounds().width, 160);
      api.restoreEdgeDock();
      api.setEdgeDockEnabled(false);
      api.setWindowBounds({ height: requiredHeight });
      await delay();
      assert.equal(api.getEdgeDockState().limitLayout, "full");
      assert.equal(errors.length, 0, errors.join("\n"));
      console.log("PASS: process restart preserves short full bounds and single-quota dock layouts");
      app.quit();
      return;
    }
    assert.equal(api.getEdgeDockState().minimal, true);
    assert.equal(await js("els.dockMinimalBtn.getAttribute('aria-pressed')"), "true");
    assert.equal(await js("document.body.dataset.dockMinimal"), "true");
    assert.equal(win.getBounds().height, 180);
    assert.equal(win.getBounds().width, 630);
    assert.equal(api.getWindowLimits().dockWidth, 288);
    assert.equal(api.getWindowLimits().dockSecondaryExtraWidth, 54);
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
    api.dockToTopEdge(workArea, win.getBounds());
    api.stopEdgeDockHoverMonitor();
    await delay();
    assert.equal(win.getBounds().width, Math.round(82 * 1.8));
    assert.equal(win.getBounds().height, 27);
    await checkDockContent(true);
    await js("toggleDockMinimal()");
    await delay();
    assert.equal(win.getBounds().width, 342);
    await checkDockContent(false);
    api.restoreEdgeDock();
    await delay();
    assert.equal(win.getBounds().height, 180);
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS: process restart restores minimal mode, font scale, full bounds, and both dock dimensions");
    // Prepare a second real restart with only the primary quota visible.
    api.setEdgeDockEnabled(false);
    await js("els.fontScaleInput.value = '1'; updateThemeFromControls(); fontScaleSyncPromise");
    api.setWindowBounds({ x: workArea.x + 100, y: workArea.y + 200, width: 350, height: 100 });
    await delay();
    await js("refreshQuota()");
    api.setWindowBounds({ height: await js("measuredFullHeight - 1") });
    await delay();
    assert.equal(api.getEdgeDockState().limitLayout, "primary-only");
    api.setEdgeDockMinimal(true);
    api.saveWindowBounds();
    await session.defaultSession.flushStorageData();
    app.quit();
    return;
  }
  assert.equal(win.getBounds().height, 100, "old saved height is clamped");
  assert.equal(api.getDefaultBounds().height, 100);
  assert.equal(api.getWindowLimits().dockWidth, 160);
  assert.equal(api.getWindowLimits().dockSecondaryExtraWidth, 30);
  assert.equal(api.getWindowLimits().dockMinimalWidth, 52);
  assert.equal(api.getEdgeDockState().minimal, false);
  assert.equal(await js("els.dockMinimalBtn.getAttribute('aria-pressed')"), "false");
  assert.equal("compact" in api.getEdgeDockState(), false);
  assert.equal(await js("'setExpandedSparkVisible' in window.codexQuota"), false);
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
  await js("localStorage.setItem('edgeDockEnabled', 'false')");
  api.setEdgeDockEnabled(false);
  console.log("PASS: new limits, saved-height clamping, removed IPC and compact state");

  const dualFixture = fixture;
  const fiveHourFixture = JSON.parse(JSON.stringify(dualFixture));
  fiveHourFixture.limits[0].secondary = null;
  const weeklyFixture = JSON.parse(JSON.stringify(dualFixture));
  weeklyFixture.limits[0].primary = weeklyFixture.limits[0].secondary;
  weeklyFixture.limits[0].secondary = null;
  const zeroFixture = JSON.parse(JSON.stringify(dualFixture));
  zeroFixture.remainingPercent = 0;
  zeroFixture.usedPercent = 100;
  for (const window of [zeroFixture.limits[0].primary, zeroFixture.limits[0].secondary]) {
    window.remainingPercent = 0;
    window.usedPercent = 100;
  }
  const refreshWith = async (nextFixture) => {
    fixture = nextFixture;
    await js("refreshQuota()");
    await delay();
  };

  const checkHeightSynchronization = async (scale, lang) => {
    const requiredHeight = await js("measuredFullHeight");
    const limits = api.getWindowLimits();
    assert.ok(requiredHeight > limits.minHeight && requiredHeight <= limits.maxHeight,
      `height boundary must be reachable: ${JSON.stringify({ scale, lang, requiredHeight, min: limits.minHeight, max: limits.maxHeight })}`);
    for (const height of [requiredHeight, requiredHeight - 1, requiredHeight + 1]) {
      api.setWindowBounds({ height });
      await delay();
      const full = height >= requiredHeight;
      const expectedLayout = full ? "full" : "primary-only";
      assert.equal(win.getBounds().height, height);
      assert.equal(api.getEdgeDockState().limitLayout, expectedLayout);
      const geometry = await js(`(() => {
        const row = document.querySelector('.quota-row.secondary');
        const content = document.querySelector('.content');
        const widget = document.querySelector('.widget');
        const style = getComputedStyle(widget);
        return { display: getComputedStyle(row).display, bottom: row.getBoundingClientRect().bottom,
          contentBottom: content.getBoundingClientRect().bottom,
          innerBottom: widget.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth) };
      })()`);
      assert.equal(geometry.display === "none", !full,
        JSON.stringify({ height, requiredHeight, geometry, state: await js("document.body.dataset.limitLayout") }));
      if (full) assert.ok(geometry.bottom <= Math.min(geometry.contentBottom, geometry.innerBottom), JSON.stringify(geometry));
      await js("document.querySelector('.content').scrollTop = 100; updateLimitLayout()");
      assert.equal(await js("measuredFullHeight"), requiredHeight, "scrolling/hidden rows must not change measurement");
      await capture(`height-${height}-${scale}-${lang}`);
      const bounds = win.getBounds();
      for (const minimal of [false, true]) {
        api.setEdgeDockMinimal(minimal);
        api.dockToTopEdge(workArea, bounds);
        api.stopEdgeDockHoverMonitor();
        await delay();
        const expectedWidth = Math.round(((minimal ? 52 : 160) + (full ? 30 : 0)) * scale);
        assert.equal(win.getBounds().width, expectedWidth);
        assert.equal(await js("els.dockCodexSecondary.textContent"), full ? "100%" : "");
        assert.equal(await js("measuredFullHeight"), requiredHeight, "collapsed height must not affect measurement");
        await checkDockContent(minimal);
        await capture(`height-dock-${height}-${minimal}-${scale}-${lang}`);
        if (!full) {
          api.showEdgeDockPreview(win.getBounds());
          await delay();
          await js("openThemePanel()");
          await delay();
          assert.equal(api.getEdgeDockState().limitLayout, "primary-only");
          await js("closeThemePanel()");
          api.hideEdgeDockPreview();
          await delay();
          assert.equal(win.getBounds().width, expectedWidth);
          for (const nextFixture of [fiveHourFixture, weeklyFixture, zeroFixture, dualFixture]) {
            await refreshWith(nextFixture);
            assert.equal(win.getBounds().width, Math.round((minimal ? 52 : 160) * scale));
            assert.equal(await js("els.dockCodexSecondary.textContent"), "");
            assert.match(await js("els.dockCodexPrimary.textContent"), /^(100|0)%$/);
            assert.equal(api.getPersistableWindowBounds().height, height);
          }
          quotaError = new Error("Simulated short-layout quota failure");
          await js("refreshQuota()");
          quotaError = null;
          await delay();
          assert.equal(await js("measuredFullHeight"), requiredHeight);
          assert.equal(api.getEdgeDockState().limitLayout, "primary-only");
          assert.equal(win.getBounds().width, expectedWidth);
          await refreshWith(dualFixture);
        }
        api.restoreEdgeDock();
        api.setEdgeDockEnabled(false);
        await delay();
        assert.equal(win.getBounds().height, height);
      }
    }
    api.setEdgeDockMinimal(false);
    api.setWindowBounds({ height: Math.round(100 * scale) });
    await delay();
    console.log(`PASS: ${scale}x ${lang} actual-height boundary, short/full dock, scroll, theme, refresh and restore`);
  };

  for (const scale of [1, 1.15, 1.8]) {
    await js(`els.fontScaleInput.value = '${scale}'; updateThemeFromControls()`);
    await delay(150);
    api.setWindowBounds({ x: workArea.x + 100, y: workArea.y + 200, width: Math.round(350 * scale), height: Math.round(100 * scale) });
    await delay();
    assert.ok(Math.abs(win.getBounds().height - Math.round(100 * scale)) <= 1);
    for (const lang of ["zh", "en"]) {
      await js(`language = '${lang}'; applyLabels()`);
      await refreshWith(dualFixture);
      assert.equal(await js("document.querySelectorAll('.quota-group').length"), 1);
      assert.equal(await js("document.querySelectorAll('.quota-row').length"), 2);
      assert.equal(await js("/spark/i.test(document.body.textContent)"), false);
      await checkHeightSynchronization(scale, lang);
      for (const width of [320, 350]) {
        api.setWindowBounds({ width: Math.round(width * scale) });
        await delay();
        await checkTitlebar();
        await capture(`title-${width}-${scale}-${lang}`);
      }
      await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(artifacts, `full-${scale}-${lang}.png`), img.toPNG()));
      const base = win.getBounds();
      api.setEdgeDockEnabled(true);
      api.dockToTopEdge(workArea, base);
      api.stopEdgeDockHoverMonitor();
      await delay();
      assert.ok(Math.abs(win.getBounds().width - Math.round(190 * scale)) <= 1, JSON.stringify(win.getBounds()));
      assert.ok(Math.abs(win.getBounds().height - Math.round(15 * scale)) <= 1, JSON.stringify(win.getBounds()));
      const metrics = await js(`(() => {
        const strip = document.getElementById('dockStrip');
        return { width: innerWidth, children: [...strip.children].map(el => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }) };
      })()`);
      assert.ok(metrics.children.every(el => el.left >= 0 && el.right <= metrics.width), "docked content must fit the window");
      await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(artifacts, `dock-${scale}-${lang}.png`), img.toPNG()));

      const restoreBounds = api.getPersistableWindowBounds();
      for (const [nextFixture, expectedWidth, expectedSecondary] of [
        [fiveHourFixture, 160, ""], [weeklyFixture, 160, ""],
        [zeroFixture, 190, "0%"], [dualFixture, 190, "100%"]
      ]) {
        await refreshWith(nextFixture);
        assert.equal(win.getBounds().width, Math.round(expectedWidth * scale));
        assert.equal(win.getBounds().height, Math.round(15 * scale));
        assert.equal(await js("els.dockCodexSecondary.textContent"), expectedSecondary);
        assert.deepEqual(api.getPersistableWindowBounds(), restoreBounds, "refresh must preserve full bounds");
      }
      const rightEdge = workArea.x + workArea.width;
      const clampedDock = api.getDockBounds({ ...base, x: rightEdge - 1 }, workArea);
      assert.equal(clampedDock.x + clampedDock.width, rightEdge);
      assert.equal(api.getDockBounds(base, { ...workArea, width: 100 }).width, 100);

      if (lang === "zh") {
        for (const [nextFixture, expectedWidth] of [[fiveHourFixture, 160], [dualFixture, 190]]) {
          await refreshWith(nextFixture);
          quotaError = new Error("Simulated quota failure");
          await js("refreshQuota()");
          quotaError = null;
          await delay();
          assert.equal(win.getBounds().width, Math.round(expectedWidth * scale));
          assert.equal(await js("document.body.dataset.state"), "error");
          assert.deepEqual(api.getPersistableWindowBounds(), restoreBounds);
        }
        // Font changes while collapsed must update width immediately and round after adding 30.
        await js("els.fontScaleInput.value = '1.15'; updateThemeFromControls()");
        await delay();
        assert.equal(win.getBounds().width, Math.round(190 * 1.15));
        assert.equal(api.getDockWidth(), Math.round(190 * 1.15));
        await js(`els.fontScaleInput.value = '${scale}'; updateThemeFromControls()`);
        await delay();
        assert.equal(win.getBounds().width, Math.round(190 * scale));
        await refreshWith(dualFixture);
      }

      api.showEdgeDockPreview(win.getBounds());
      await delay();
      assert.ok(Math.abs(win.getBounds().height - Math.round(100 * scale)) <= 1);
      assert.equal(api.getEdgeDockState().preview, true);
      assert.equal(await js("document.body.dataset.edgeDock"), "expanded");
      await refreshWith(weeklyFixture);
      assert.equal(win.getBounds().width, base.width, "preview stays expanded when quota changes");
      api.hideEdgeDockPreview();
      await delay();
      assert.equal(win.getBounds().width, Math.round(160 * scale));
      api.showEdgeDockPreview(win.getBounds());
      await refreshWith(dualFixture);
      await js("openThemePanel()");
      await delay();
      assert.ok(Math.abs(win.getBounds().height - Math.round(220 * scale)) <= 1);
      await js("closeThemePanel()");
      await delay();
      assert.ok(Math.abs(win.getBounds().height - Math.round(100 * scale)) <= 1);
      api.hideEdgeDockPreview();
      await delay();
      assert.ok(Math.abs(win.getBounds().width - Math.round(190 * scale)) <= 1);
      assert.equal(api.getEdgeDockState().docked, true);
      await checkDockContent(false);
      const minimalRestoreBounds = api.getPersistableWindowBounds();

      // Toggle in the expanded hover preview: only the next collapse may shrink the window.
      api.showEdgeDockPreview(win.getBounds());
      await delay();
      const previewBounds = win.getBounds();
      await js("els.dockMinimalBtn.click()");
      await delay();
      assert.equal(api.getEdgeDockState().minimal, true);
      assert.deepEqual(win.getBounds(), previewBounds);
      assert.equal(await js("els.dockMinimalBtn.classList.contains('active')"), true);
      assert.equal(await js("els.dockMinimalBtn.getAttribute('aria-pressed')"), "true");
      assert.equal(await js("localStorage.getItem('edgeDockMinimal')"), "true");
      assert.equal(api.getEdgeDockState().enabled, true);
      await checkTitlebar();
      await js("openThemePanel()");
      await delay();
      assert.ok(Math.abs(win.getBounds().height - Math.round(220 * scale)) <= 1);
      await js("closeThemePanel()");
      await delay();
      assert.deepEqual(win.getBounds(), previewBounds);
      api.hideEdgeDockPreview();
      await delay();

      for (const [nextFixture, expectedWidth, expectedPercents] of [
        [dualFixture, 82, ["100%", "100%"]], [fiveHourFixture, 52, ["100%", ""]],
        [weeklyFixture, 52, ["100%", ""]], [zeroFixture, 82, ["0%", "0%"]],
        [dualFixture, 82, ["100%", "100%"]]
      ]) {
        await refreshWith(nextFixture);
        assert.equal(win.getBounds().width, Math.round(expectedWidth * scale));
        assert.equal(win.getBounds().height, Math.round(15 * scale));
        assert.deepEqual(await js("[els.dockCodexPrimary.textContent, els.dockCodexSecondary.textContent]"), expectedPercents);
        await checkDockContent(true);
        assert.deepEqual(api.getPersistableWindowBounds(), minimalRestoreBounds);
        await capture(`minimal-${expectedWidth}-${expectedPercents[0]}-${scale}-${lang}`);
        quotaError = new Error("Simulated minimal quota failure");
        await js("refreshQuota()");
        quotaError = null;
        await delay();
        assert.equal(win.getBounds().width, Math.round(expectedWidth * scale));
        assert.equal(await js("document.body.dataset.state"), "error");
        await checkDockContent(true);
      }
      // Main-process changes must synchronize the button, CSS and persisted preference too.
      api.setEdgeDockMinimal(false);
      await delay();
      assert.equal(win.getBounds().width, Math.round(190 * scale));
      assert.equal(await js("els.dockMinimalBtn.getAttribute('aria-pressed')"), "false");
      assert.equal(await js("localStorage.getItem('edgeDockMinimal')"), "false");
      await checkDockContent(false);
      await js("toggleDockMinimal()");
      await delay();
      assert.equal(win.getBounds().width, Math.round(82 * scale));
      api.saveWindowBounds();
      assert.ok(Math.abs(api.loadWindowBounds().height - Math.round(100 * scale)) <= 1);
      api.restoreEdgeDock();
      api.setEdgeDockEnabled(false);
      await delay();
      assert.ok(Math.abs(win.getBounds().width - base.width) <= 1);
      assert.ok(Math.abs(win.getBounds().height - base.height) <= 1);
      const undockedBounds = win.getBounds();
      await js("toggleDockMinimal()");
      await delay();
      assert.deepEqual(win.getBounds(), undockedBounds);
      assert.equal(api.getEdgeDockState().enabled, false);
      console.log(`PASS: ${scale}x ${lang} title layout, full/minimal single/dual/zero/error, preview/theme/restore/persist`);
    }
  }
  await refreshWith(weeklyFixture);
  assert.equal(await js("document.querySelectorAll('.quota-row').length"), 1);
  assert.equal(await js("document.querySelector('.quota-label').textContent"), "7d:");
  assert.match(api.createTrayTooltip("ready", weeklyFixture), /7天额度/);
  assert.equal(api.getQuotaState(dualFixture), "ready");
  assert.equal(errors.length, 0, errors.join("\n"));
  await js("toggleDockMinimal()");
  api.saveWindowBounds();
  await session.defaultSession.flushStorageData();
  console.log("PASS: weekly-only renderer and tray, no renderer errors");
  app.quit();
}

run().catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error("Verification timed out"); app.exit(2); }, 180000).unref();
