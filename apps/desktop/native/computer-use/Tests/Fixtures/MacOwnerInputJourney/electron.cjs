const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.json");
const out = config.output;
let saves = 0;
const windows = new Map();
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value));
const note = (expression) => windows.get("A").webContents.executeJavaScript(expression);
const html = `<!doctype html><meta charset="utf-8"><style>
body { background: #b93435; font: 18px system-ui; margin: 24px; }
textarea { width: 330px; height: 120px; font: 18px system-ui; }
#latency { position: fixed; right: 12px; bottom: 12px; width: 64px; height: 32px; background: #f00; }
</style><h1>Owner input fixture</h1><textarea id="note" aria-label="Owner input note"></textarea>
<input type="password" id="secure" aria-label="Fixture password">
<div id="latency" aria-hidden="true"></div>
<script>
const { ipcRenderer } = require('electron');
window.latencyEnabled = false;
window.latencyChanges = 0;
document.querySelector('#note').addEventListener('input', () => {
  if (window.latencyEnabled) {
    window.latencyChanges += 1;
    document.querySelector('#latency').style.background = window.latencyChanges % 2 ? '#0f0' : '#f00';
  }
});
for (const [name, type] of [['keydown', 10], ['keyup', 11]]) {
  addEventListener(name, event => ipcRenderer.send('native-input', {type, code: event.code,
    key: event.key, trusted: event.isTrusted, shift: event.shiftKey}));
}
</script>`;
app.commandLine.appendSwitch("force-renderer-accessibility");
void app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "events.jsonl"), "");
  fs.writeFileSync(path.join(out, "dispatch.jsonl"), "");
  ipcMain.on("native-input", (event, row) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    fs.appendFileSync(
      path.join(out, "dispatch.jsonl"),
      JSON.stringify({
        ...row,
        title: window?.getTitle(),
        uptimeUs: Number(process.hrtime.bigint() / 1000n),
      }) + "\n",
    );
  });
  for (const [title, x, y] of [
    ["A", 120, 150],
    ["B", 380, 250],
    ["C", 900, 90],
  ]) {
    const window = new BrowserWindow({
      title,
      x,
      y,
      width: 480,
      height: 400,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    window.on("page-title-updated", (event) => event.preventDefault());
    windows.set(title, window);
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  }
  const save = async () => {
    const text = await note('document.querySelector("#note").value');
    saves += 1;
    fs.writeFileSync(path.join(out, "owner-saved.txt"), text);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Owner Electron Fixture", submenu: [{ role: "quit" }] },
      {
        label: "File",
        submenu: [{ label: "Save", accelerator: "Command+S", click: () => void save() }],
      },
      { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "selectAll" }] },
    ]),
  );
  let busy = false;
  const poll = async () => {
    const command = path.join(out, "command.json");
    if (busy || !fs.existsSync(command)) return;
    busy = true;
    try {
      const { op, window: title = "A" } = JSON.parse(fs.readFileSync(command, "utf8"));
      const window = windows.get(title);
      fs.appendFileSync(
        path.join(out, "commands.jsonl"),
        JSON.stringify({ op, window: title }) + "\n",
      );
      switch (op) {
        case "owner-note":
          window.show();
          app.focus({ steal: true });
          window.focus();
          await note(
            'document.querySelector("#note").value=""; document.querySelector("#note").focus()',
          );
          break;
        case "owner-clear":
          await note(
            'document.querySelector("#note").value=""; document.querySelector("#note").focus()',
          );
          break;
        case "owner-select-all":
          await note(
            'document.querySelector("#note").focus(); document.querySelector("#note").select()',
          );
          break;
        case "owner-resume":
          await note('document.querySelector("#note").focus()');
          break;
        case "owner-end":
          await note(
            'const n=document.querySelector("#note"); n.setSelectionRange(n.value.length,n.value.length)',
          );
          break;
        case "owner-middle":
          await note('document.querySelector("#note").setSelectionRange(2,2)');
          break;
        case "owner-secure":
          await note(
            'document.querySelector("#secure").value="owner-fixture-secret"; document.querySelector("#secure").focus()',
          );
          break;
        case "owner-state":
          write("owner-state.json", {
            text: await note('document.querySelector("#note").value'),
            saves,
            latencyChanges: await note("window.latencyChanges"),
          });
          break;
        case "owner-latency": {
          const point = await note(`(() => {
            window.latencyChanges=0; window.latencyEnabled=true;
            document.querySelector('#latency').style.background='#f00';
            const n=document.querySelector('#note'); n.focus(); n.setSelectionRange(n.value.length,n.value.length);
            const r=document.querySelector('#latency').getBoundingClientRect();
            return {x:r.x+r.width/2,y:r.y+r.height/2};
          })()`);
          const bounds = windows.get("A").getContentBounds();
          write("owner-latency-point.json", { x: bounds.x + point.x, y: bounds.y + point.y });
          break;
        }
        case "owner-latency-end":
          await note("window.latencyEnabled=false");
          break;
        case "child": {
          const [x, y] = window.getPosition();
          const [width] = window.getSize();
          const child = new BrowserWindow({
            title: "Child",
            parent: window,
            x: x + width - 70,
            y: y + 30,
            width: 240,
            height: 180,
            backgroundColor: "#27a543",
            focusable: false,
            show: false,
          });
          child.on("page-title-updated", (event) => event.preventDefault());
          windows.set("Child", child);
          await child.loadURL("data:text/html,<h1>Associated child</h1>");
          child.showInactive();
          break;
        }
        case "small-child": {
          const [x, y] = window.getPosition();
          const child = new BrowserWindow({
            title: "Child",
            parent: window,
            x: x + 80,
            y: y + 50,
            width: 66,
            height: 20,
            frame: false,
            focusable: false,
            backgroundColor: "#27a543",
            show: false,
          });
          child.on("page-title-updated", (event) => event.preventDefault());
          windows.set("Child", child);
          await child.loadURL("data:text/html,<body style='margin:0;background:%2327a543'></body>");
          child.showInactive();
          break;
        }
        case "owner-close-child":
          windows.get("Child")?.close();
          windows.delete("Child");
          await note('document.querySelector("#note").focus()');
          break;
        case "resize":
          window.setContentSize(520, 450);
          break;
        case "move":
          window.setPosition(650, 200);
          break;
        case "focus":
          app.focus({ steal: true });
          window.focus();
          break;
        case "raise":
          window.moveTop();
          break;
        default:
          throw new Error("Unknown owner fixture command: " + op);
      }
      fs.unlinkSync(command);
    } catch (error) {
      write("electron-fixture-error.json", { error: String(error) });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void poll(), 20);
  app.on("before-quit", () => clearInterval(timer));
  write("electron-ready.json", {
    pid: process.pid,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    app: app.getAppPath(),
  });
});
app.on("window-all-closed", () => app.quit());
