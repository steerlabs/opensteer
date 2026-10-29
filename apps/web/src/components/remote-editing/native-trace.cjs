// Run only through pnpm test:vm. HTTP reads observations; CGEvents supply all input.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");
const { execFile, spawn } = require("node:child_process");
const { qualifyNativeTrace } = require("./native-trace-qualification.cjs");
const run = require("node:util").promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (!process.cwd().endsWith("/opensteer-job/src/apps/desktop"))
  throw new Error("Run native tracing only through pnpm test:vm.");
const out =
  process.env.OPENSTEER_NATIVE_TRACE_EVIDENCE_DIR ||
  path.join(process.env.HOME, "opensteer-job/artifacts/viewer-native-traces");
fs.mkdirSync(out, { recursive: true });
const helper = path.join(out, "native-keys");
const report = {
  native: true,
  sourceSha: process.env.OPENSTEER_NATIVE_TRACE_SHA,
  cases: [],
  blocked: [],
};
const US = "com.apple.keylayout.US";
const korean = "com.apple.inputmethod.Korean.2SetKorean";
const japanese = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";
const nihon = ["45", "34", "4", "31", "45"];
// Intent is authored before observing the reducer or capture. A mismatch is a failure.
const cases = [
  { name: "us", inputSource: US, keys: ["4", "14", "37", "37", "31", "49"], expected: "hello " },
  { name: "option", inputSource: US, keys: ["0:alt"], expected: "å" },
  { name: "dead-key", inputSource: US, keys: ["14:alt", "14"], expected: "é", composition: true },
  { name: "accent-hold", inputSource: US, keys: ["14:hold", "19"], expected: "é" },
  {
    name: "korean-repeat-enter",
    inputSource: korean,
    keys: ["5", "40", "1", "5", "40", "1", "36"],
    expected: "한한",
    composition: true,
  },
  {
    name: "korean-transition-enter",
    inputSource: korean,
    keys: ["5", "40", "1", "15", "46", "3", "36"],
    expected: "한글",
    composition: true,
  },
  {
    name: "korean-click",
    inputSource: korean,
    keys: ["5", "40", "1"],
    click: true,
    expected: "한",
    composition: true,
  },
  {
    name: "japanese-convert",
    inputSource: japanese,
    keys: [...nihon, "49", "36"],
    expected: "日本",
    composition: true,
  },
  {
    name: "japanese-candidate",
    inputSource: japanese,
    keys: [...nihon, "49"],
    candidate: true,
    expected: "日本",
    composition: true,
  },
  {
    name: "japanese-cancel",
    inputSource: japanese,
    keys: ["40", "0", "53", "53"],
    expected: "",
    composition: true,
  },
  {
    name: "japanese-reconvert",
    inputSource: japanese,
    keys: [...nihon, "49", "36"],
    reconvert: true,
    expected: "日本",
    composition: true,
    compositionTransactions: 2,
  },
  {
    name: "pinyin",
    inputSource: "com.apple.inputmethod.SCIM.ITABC",
    keys: ["45", "34", "4", "0", "31", "49"],
    expected: "你好",
    composition: true,
  },
  {
    name: "text-replacement",
    inputSource: US,
    keys: ["31", "46", "13", "49"],
    expected: "On my way! ",
  },
  {
    name: "emoji-picker",
    inputSource: US,
    keys: ["49:control:meta"],
    picker: true,
    expected: "😀",
  },
];
const sourceBlockers = new Map();
app.on("window-all-closed", () => {});
let win,
  server,
  child,
  externalPid,
  pending = null,
  latest = null;
const children = new Set();
async function command(file, args, options = {}) {
  return run(file, args, { timeout: 30000, encoding: "utf8", ...options });
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function screenshot(name) {
  await command("/usr/sbin/screencapture", ["-x", path.join(out, name + ".png")]);
}
async function closeBrowser() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  if (externalPid) {
    await command("/bin/kill", ["-TERM", String(externalPid)]).catch(() => {});
    externalPid = null;
  }
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    child = null;
  }
}
void app.whenReady().then(async () => {
  const timeout = setTimeout(() => {
    report.blocked.push({ name: "harness", reason: "Capture exceeded 12 minutes" });
    void finish(1);
  }, 12 * 60000);
  async function finish(code) {
    clearTimeout(timeout);
    await closeBrowser();
    for (const process of children) process.kill("SIGKILL");
    if (server)
      await new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      });
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    app.exit(code);
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.once(signal, () => {
      void finish(1);
    });
  try {
    await command(
      "xcrun",
      [
        "swiftc",
        "-module-cache-path",
        path.join(out, "swift-cache"),
        path.join(__dirname, "native-keys.swift"),
        "-o",
        helper,
      ],
      { timeout: 120000 },
    );
    const sources = JSON.parse((await command(helper, ["sources"])).stdout);
    fs.writeFileSync(path.join(out, "input-sources.json"), JSON.stringify(sources, null, 2));
    const bundle = fs.readFileSync(process.env.OPENSTEER_PROXY_TRACE_BUNDLE, "utf8");
    const serve = async (req, res) => {
      if (req.url === "/control") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(pending));
        pending = null;
        return;
      }
      if (req.url === "/snapshot" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8 * 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
        }
        try {
          latest = JSON.parse(body);
          res.end("ok");
        } catch {
          res.writeHead(400).end();
        }
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script>' +
          bundle.replaceAll("</script", "<\\/script") +
          "</script>",
      );
    };
    server = createServer((req, res) => {
      void serve(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const engine of (
      process.env.OPENSTEER_NATIVE_TRACE_ENGINES || "electron,chrome,safari,firefox"
    ).split(",")) {
      latest = null;
      try {
        const scope =
          process.env[`OPENSTEER_NATIVE_TRACE_CASES_${engine.toUpperCase()}`] ??
          process.env.OPENSTEER_NATIVE_TRACE_CASES;
        const requested = scope?.split(",");
        if (requested?.some((name) => !cases.some((scenario) => scenario.name === name)))
          throw new Error(`Unknown native capture cases for ${engine}: ${scope}`);
        const selected = cases.filter(
          (scenario) => !requested || requested.includes(scenario.name),
        );
        report.requested ??= [];
        report.requested.push(
          ...selected.map((scenario) => ({ engine, name: engine + "-" + scenario.name })),
        );
        let bundleId, pid;
        if (engine === "electron") {
          win = new BrowserWindow({
            show: true,
            width: 900,
            height: 650,
            webPreferences: { contextIsolation: true, nodeIntegration: false },
          });
          await win.loadURL(url);
          win.show();
          win.focus();
          pid = process.pid;
        } else {
          if (engine === "safari") {
            bundleId = "com.apple.Safari";
            await command("open", ["-a", "Safari", url]);
          } else {
            const binary =
              engine === "chrome"
                ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                : "/Applications/Firefox.app/Contents/MacOS/firefox";
            bundleId = engine === "chrome" ? "com.google.Chrome" : "org.mozilla.firefox";
            if (!fs.existsSync(binary)) throw new Error(`Native browser unavailable: ${binary}`);
            const profile = path.join(out, engine + "-profile");
            fs.mkdirSync(profile, { recursive: true });
            child = spawn(
              binary,
              engine === "chrome"
                ? [
                    `--user-data-dir=${profile}`,
                    "--no-first-run",
                    "--no-default-browser-check",
                    url,
                  ]
                : ["-no-remote", "-profile", profile, url],
              { stdio: "ignore" },
            );
            children.add(child);
            const owned = child;
            child.once("close", () => children.delete(owned));
            child.once("error", (error) => {
              report.blocked.push({ engine, name: "launch", reason: String(error) });
            });
          }
          await delay(1500);
          const apps = JSON.parse((await command(helper, ["apps"])).stdout);
          pid = apps.find((item) => item.bundleId === bundleId)?.pid;
          if (!pid) throw new Error(`Browser is not running: ${bundleId}`);
          externalPid = pid;
        }
        await waitFor(() => latest?.events && latest.userAgent, `${engine} recorder loaded`);
        if (engine === "firefox") {
          await screenshot("firefox-startup");
          report.firefoxWelcome = JSON.parse(
            (await command(helper, ["button", String(pid), "Continue"])).stdout,
          );
          await screenshot("firefox-after-welcome");
          if (!report.firefoxWelcome.found || report.firefoxWelcome.pressStatus !== 0)
            throw new Error(
              "Firefox native Welcome Continue button could not be pressed; inspect native button diagnostics.",
            );
        }
        for (const scenario of selected) {
          const name = engine + "-" + scenario.name;
          const trace = {
            native: true,
            engine: latest.userAgent,
            scenario: scenario.name,
            inputSource: scenario.inputSource,
            intent: {
              keys: scenario.keys,
              click: !!scenario.click,
              picker: !!scenario.picker,
              phases: [],
            },
            expected: { value: scenario.expected },
            sourceSha: report.sourceSha,
          };
          try {
            if (!sources.some((item) => item.id === scenario.inputSource))
              throw new Error(`Input source unavailable: ${scenario.inputSource}`);
            if (sourceBlockers.has(scenario.inputSource))
              throw new Error(sourceBlockers.get(scenario.inputSource));
            try {
              trace.sourceSelection = JSON.parse(
                (await command(helper, ["source", scenario.inputSource])).stdout,
              );
            } catch (error) {
              sourceBlockers.set(
                scenario.inputSource,
                `Source activation failed earlier in this batch: ${scenario.inputSource}; inspect its first enable/select diagnostic.`,
              );
              throw error;
            }
            latest = null;
            pending = "reset";
            await waitFor(
              () => latest?.focused && latest.value === "" && latest.events.length < 3,
              "proxy reset and focus",
            );
            const keys = async (phase, sequence) => {
              trace.sourceAfterKeys = JSON.parse(
                (await command(helper, ["keys", String(pid), ...sequence])).stdout,
              );
              await delay(300);
              trace.intent.phases.push({
                phase,
                keys: sequence,
                value: latest.value,
                composing: latest.composing,
                eventCount: latest.events.length,
              });
            };
            const accept = async (phase) => {
              if (latest.composing) await keys(phase, ["36"]);
            };
            await keys("initial", scenario.keys);
            if (scenario.candidate) {
              await keys("candidate-list", ["125"]);
              await screenshot(name + "-candidates");
              await keys("candidate-selection", ["126", "36"]);
            }
            if (scenario.name.startsWith("japanese-") && scenario.name !== "japanese-cancel")
              await accept("accept-selected-conversion");
            if (scenario.reconvert) {
              await keys("reconvert", ["15:control:shift", "36"]);
              await accept("accept-reconversion");
            }
            if (trace.sourceAfterKeys.current.id !== scenario.inputSource)
              throw new Error(
                `Input source changed during native keys: ${trace.sourceAfterKeys.current.id}`,
              );
            if (scenario.click) {
              const { viewport: v, commit: r } = latest;
              await command(helper, [
                "click",
                String(pid),
                String(v.screenX + r.x + r.width / 2),
                String(v.screenY + v.topInset + r.y + r.height / 2),
              ]);
            }
            if (scenario.picker) {
              await delay(800);
              await screenshot(name + "-picker");
              // Search the native Character Viewer, then choose its first grinning-face result.
              await command(helper, [
                "keys",
                "0",
                "5",
                "15",
                "34",
                "45",
                "45",
                "34",
                "45",
                "5",
                "36",
              ]);
              await screenshot(name + "-picker-results");
              trace.pickerApps = JSON.parse((await command(helper, ["apps"])).stdout);
              const palette = trace.pickerApps.find((item) =>
                /CharacterPalette/.test(item.bundleId),
              );
              trace.pickerSelection = palette
                ? JSON.parse(
                    (await command(helper, ["button", String(palette.pid), "grinning face", "😀"]))
                      .stdout,
                  )
                : { found: false, reason: "Character Viewer native application unavailable" };
            }
            await delay(800);
            trace.events = latest.events;
            trace.final = {
              value: latest.value,
              selectionStart: latest.selectionStart,
              selectionEnd: latest.selectionEnd,
              composing: latest.composing,
            };
            fs.writeFileSync(path.join(out, name + ".json"), JSON.stringify(trace, null, 2));
            await screenshot(name);
            const hasComposition = trace.events.some((event) => event.type === "compositionstart");
            const passed = qualifyNativeTrace({
              scenario,
              events: trace.events,
              final: trace.final,
            });
            report.cases.push({
              engine,
              name,
              eventCount: trace.events.length,
              composition: hasComposition,
              status: passed ? "captured" : "failed",
              expected: scenario.expected,
              actual: trace.final.value,
            });
            if (
              !trace.events.some((event) => /^(key|input|beforeinput|composition)/.test(event.type))
            ) {
              report.blocked.push({
                engine,
                name: "shared-setup",
                reason:
                  "Native input did not reach the proxy; stop this browser before the IME sweep.",
              });
              break;
            }
          } catch (error) {
            report.blocked.push({
              engine,
              name,
              reason: String(error),
              stdout: error.stdout,
              stderr: error.stderr,
            });
          }
        }
      } catch (error) {
        report.blocked.push({ engine, name: "browser", reason: String(error) });
      } finally {
        await closeBrowser();
      }
    }
  } catch (error) {
    report.blocked.push({
      name: "harness",
      reason: String(error),
      stdout: error.stdout,
      stderr: error.stderr,
    });
  }
  await finish(
    report.blocked.length ||
      !report.cases.length ||
      report.cases.some((item) => item.status !== "captured")
      ? 1
      : 0,
  );
});
