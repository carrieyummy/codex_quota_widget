/**
 * 使用项目现有 Electron 验证离线分类页面、切换与扣减演示，并保存预览截图。
 * 窗口几何从展示脚本 UI_SIZES 读取，不复写用户的 UI 尺寸；不访问外部网络。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { UI_SIZES } = require("../research/overview-view.js");
const overview = require("../research/quota-overview.config.json");
const directory = path.resolve(__dirname, "../research", overview.outputDirectory);
app.setPath("userData", path.join(directory, "test-profile"));
app.commandLine.appendSwitch("force-device-scale-factor", "1");

/**
 * 加载真实脱敏快照，验证交互与不同配置宽度下的排版；无参数。
 * @returns {Promise<void>} 断言通过并保存截图，否则抛错退出。
 */
async function verifyPage() {
  const errors = [];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: UI_SIZES.previewWidth, height: UI_SIZES.previewHeight,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(directory, "index.html"));
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('h1')?.textContent"), "额度，按来源和用途分开看");
  const tabIds = await win.webContents.executeJavaScript("[...document.querySelectorAll('[role=tab]')].map(tab=>tab.id)");
  for (const width of [UI_SIZES.previewWidth, UI_SIZES.narrowPreviewWidth]) {
    win.setContentSize(width, UI_SIZES.previewHeight);
    for (const id of tabIds) {
      const state = await win.webContents.executeJavaScript(`(() => {
        const tab = document.getElementById(${JSON.stringify(id)}); tab.click();
        return { selected: tab.getAttribute('aria-selected'), panels: [...document.querySelectorAll('[role=tabpanel]')].filter(p=>!p.hidden).length,
          overflow: document.documentElement.scrollWidth > window.innerWidth };
      })()`);
      assert.equal(state.selected, "true");
      assert.equal(state.panels, 1);
      assert.equal(state.overflow, false, `${id}: body must not overflow`);
    }
  }
  const scenario = await win.webContents.executeJavaScript(`(() => {
    const report = JSON.parse(document.getElementById('report-data').textContent);
    document.getElementById('tab-scenario').click();
    document.getElementById('demo-spend').value='0';
    document.getElementById('demo-spend').dispatchEvent(new Event('input'));
    const before=document.getElementById('scenario-result').textContent;
    document.getElementById('demo-time').value='expired';
    document.getElementById('demo-time').dispatchEvent(new Event('input'));
    const after=document.getElementById('scenario-result').textContent;
    document.getElementById('demo-purchase').value='-1';
    document.getElementById('demo-purchase').dispatchEvent(new Event('input'));
    return { before, after, purchase: report.simulationDefaults.purchaseUsd,
      initial: report.funds.subscriptionEstimateUsd, error: !!document.querySelector('#scenario-result [role=alert]') };
  })()`);
  assert(scenario.before.includes(`US$${(scenario.initial + scenario.purchase).toFixed(2)}`));
  assert(scenario.after.includes(`US$${scenario.purchase.toFixed(2)}`));
  assert(scenario.after.includes("到期"));
  assert(scenario.error);
  assert.deepEqual(errors, []);
  await win.webContents.executeJavaScript("document.getElementById('tab-funding').click()");
  win.setContentSize(UI_SIZES.previewWidth, UI_SIZES.previewHeight);
  fs.writeFileSync(path.join(directory, "preview.png"), (await win.webContents.capturePage()).toPNG());
  console.log("PASS: category tabs, narrow/wide layout, expiry simulation, invalid amount, no external network");
  win.destroy();
}

app.whenReady().then(verifyPage).then(() => app.quit()).catch((error) => {
  console.error(error.message); app.exit(1);
});
