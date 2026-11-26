// The person's front app while an agent works in Safari: an Electron app whose process is
// "Electron", as the Opensteer app from a development launch is. A Stop button and a field
// log what the person does to them, with wall-clock times.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.json");
const out = config.output;
const log = (row) =>
  fs.appendFileSync(path.join(out, "front-events.jsonl"), JSON.stringify({ ...row, at: Date.now() }) + "\n");
const html = `<!doctype html><meta charset="utf-8"><title>Opensteer stand-in</title><style>
body { background: #1d2430; color: #fff; font: 18px system-ui; margin: 24px; }
#stop { font: 22px system-ui; width: 160px; height: 64px; }
#field { font: 18px system-ui; width: 420px; height: 36px; margin-top: 24px; }
</style><h1>Watching the agent</h1><button id="stop">Stop</button><br>
<input id="field" aria-label="Opensteer stand-in field" autocomplete="off" spellcheck="false">
<script>
const { ipcRenderer } = require('electron');
const send = (row) => ipcRenderer.send('front', row);
document.querySelector('#stop').addEventListener('click', (e) => send({ kind: 'stop', trusted: e.isTrusted }));
document.querySelector('#field').addEventListener('input', (e) => send({ kind: 'input', data: e.data, value: e.target.value }));
addEventListener('mousedown', (e) => send({ kind: 'mousedown', x: e.clientX, y: e.clientY }));
window.rects = () => {
  const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  return { stop: r('#stop'), field: r('#field') };
};
</script>`;
app.setPath("userData", config.userData);
app.commandLine.appendSwitch("force-renderer-accessibility");
void app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "front-events.jsonl"), "");
  ipcMain.on("front", (_event, row) => log(row));
  const window = new BrowserWindow({
    x: 10, y: 40, width: 700, height: 560, title: "Opensteer stand-in", show: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  window.setTitle("Opensteer stand-in");
  const content = window.getContentBounds();
  const rects = await window.webContents.executeJavaScript("window.rects()");
  const center = (r) => ({ x: content.x + r.x + r.width / 2, y: content.y + r.y + r.height / 2 });
  fs.writeFileSync(
    path.join(out, "front-ready.json"),
    JSON.stringify({ pid: process.pid, content, stop: center(rects.stop), field: center(rects.field) }),
  );
});
app.on("window-all-closed", () => app.quit());
