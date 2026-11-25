const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

app.whenReady().then(async () => {
  const directory = path.resolve(__dirname, '../out/icon-options');
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 736, height: 410 });
  await win.loadFile(path.join(directory, 'dock-icons.html'));
  let icons = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    icons = await win.webContents.executeJavaScript(`(() => {
      const doc = document.querySelector('iframe').contentDocument;
      return doc ? [...doc.querySelectorAll('#dock-icon-options .icon-row img')].filter(el => el.complete && el.naturalWidth > 0).map(el => el.naturalWidth) : [];
    })()`);
    if (icons.length === 4) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(icons.length, 4, 'all four icons must render');
  const screenshot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(directory, 'dock-icons.png'), screenshot.toPNG());
  console.log('PASS: all four embedded icons render with network requests disabled');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => app.exit(2), 20000).unref();
