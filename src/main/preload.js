const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexQuota", {
  getQuota: () => ipcRenderer.invoke("quota:get"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  getWindowLimits: () => ipcRenderer.invoke("window:limits:get"),
  getWindowBounds: () => ipcRenderer.invoke("window:bounds:get"),
  setWindowBounds: (bounds) => ipcRenderer.invoke("window:bounds:set", bounds),
  getAlwaysOnTop: () => ipcRenderer.invoke("window:alwaysOnTop:get"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("window:alwaysOnTop:set", value),
  getEdgeDockState: () => ipcRenderer.invoke("window:edgeDock:get"),
  setEdgeDockEnabled: (value) => ipcRenderer.invoke("window:edgeDock:set", value),
  restoreEdgeDock: () => ipcRenderer.invoke("window:edgeDock:restore"),
  setLanguage: (language) => ipcRenderer.invoke("app:language:set", language),
  openCodex: () => ipcRenderer.invoke("external:openCodex"),
  onRefresh: (callback) => {
    ipcRenderer.on("quota:refresh", callback);
  },
  onAlwaysOnTopChanged: (callback) => {
    ipcRenderer.on("window:alwaysOnTopChanged", (_event, value) => callback(value));
  },
  onEdgeDockChanged: (callback) => {
    ipcRenderer.on("window:edgeDockChanged", (_event, value) => callback(value));
  },
  onEdgeDockEnabledChanged: (callback) => {
    ipcRenderer.on("window:edgeDockEnabledChanged", (_event, value) => callback(value));
  }
});
