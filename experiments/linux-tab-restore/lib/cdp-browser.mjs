import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export function findPinnedChromium() {
  if (process.env.OPENSTEER_CHROMIUM_EXECUTABLE) {
    return process.env.OPENSTEER_CHROMIUM_EXECUTABLE;
  }
  const candidates = [
    path.join(
      homedir(),
      "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ),
    path.join(
      homedir(),
      "Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ),
    "/ms-playwright/chromium-1234/chrome-linux/chrome",
    "/ms-playwright/chromium-1234/chrome-linux64/chrome",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Pinned Chromium (revision 1234 / 151.0.7922.34) not found. Set OPENSTEER_CHROMIUM_EXECUTABLE.",
  );
}

/**
 * Minimal NUL-delimited CDP client over Chromium's --remote-debugging-pipe (fd 3 write, fd 4 read).
 * Mirrors Playwright's native persistent launch transport without external dependencies.
 */
export class CdpBrowser {
  #proc;
  #nextId = 1;
  #pending = new Map();
  #eventListeners = new Set();
  #buf = Buffer.alloc(0);
  #closed = false;
  #exited;
  #stderr = [];

  constructor(proc, userDataDir, executablePath) {
    this.#proc = proc;
    this.userDataDir = userDataDir;
    this.executablePath = executablePath;
    this.pid = proc.pid;

    this.#exited = new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve({ code: proc.exitCode, signal: proc.signalCode });
      } else {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
      }
    });

    proc.stderr?.on("data", (chunk) => {
      if (this.#stderr.length < 200) this.#stderr.push(chunk.toString("utf8"));
    });

    const pipeOut = proc.stdio[4];
    pipeOut.on("data", (chunk) => {
      this.#buf = Buffer.concat([this.#buf, chunk]);
      let idx;
      while ((idx = this.#buf.indexOf(0)) !== -1) {
        const raw = this.#buf.subarray(0, idx).toString("utf8");
        this.#buf = this.#buf.subarray(idx + 1);
        if (!raw) continue;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (msg.id !== undefined) {
          const entry = this.#pending.get(msg.id);
          if (entry) {
            this.#pending.delete(msg.id);
            if (msg.error) {
              const err = new Error(
                `CDP ${entry.method} (params=${JSON.stringify(entry.params).slice(0, 120)}): ${msg.error.message} (${msg.error.code})`,
              );
              err.cdpError = msg.error;
              entry.reject(err);
            } else {
              entry.resolve(msg.result ?? {});
            }
          }
        } else if (msg.method) {
          for (const listener of this.#eventListeners) {
            try {
              listener(msg.method, msg.params ?? {}, msg.sessionId ?? null);
            } catch {
              // Ignore listener errors.
            }
          }
        }
      }
    });

    proc.once("exit", () => {
      this.#closed = true;
      for (const [, entry] of this.#pending) {
        entry.reject(new Error(`Browser exited while awaiting ${entry.method}`));
      }
      this.#pending.clear();
    });
  }

  get stderrText() {
    return this.#stderr.join("");
  }

  onEvent(listener) {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  waitForEvent(predicate, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event after ${timeoutMs}ms`));
      }, timeoutMs);
      const off = this.onEvent((method, params, sessionId) => {
        if (predicate(method, params, sessionId)) {
          clearTimeout(timer);
          off();
          resolve({ method, params, sessionId });
        }
      });
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15_000) {
    if (this.#closed) return Promise.reject(new Error(`Browser is closed (${method})`));
    const id = this.#nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`CDP timeout (${timeoutMs}ms): ${method}`));
        }
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        params,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const pipeIn = this.#proc.stdio[3];
      pipeIn.write(JSON.stringify(payload) + "\0");
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return sessionId;
  }

  async detach(sessionId) {
    await this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }

  async evalInSession(sessionId, expression, { awaitPromise = false, contextId = undefined } = {}) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
        ...(contextId !== undefined ? { contextId } : {}),
      },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(
        `Runtime.evaluate error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result?.value;
  }

  async navigateAndWait(sessionId, url, timeoutMs = 15_000) {
    await this.send("Page.enable", {}, sessionId);
    const loaded = this.waitForEvent(
      (method, _params, sid) => sid === sessionId && method === "Page.loadEventFired",
      timeoutMs,
    );
    const nav = await this.send("Page.navigate", { url }, sessionId);
    if (nav.errorText) throw new Error(`Page.navigate failed: ${nav.errorText}`);
    await loaded;
    return nav;
  }

  /** Measures exact process-tree RSS (bytes) strictly for this browser PID and its descendants. */
  measureProcessTreeMemory() {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const rows = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        rssBytes: Number(m[3]) * 1024,
        command: m[4],
      });
    }
    const tree = new Set([this.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!tree.has(row.pid) && tree.has(row.ppid)) {
          tree.add(row.pid);
          changed = true;
        }
      }
    }
    const members = rows.filter((r) => tree.has(r.pid));
    let totalRssBytes = 0;
    let rendererRssBytes = 0;
    let rendererCount = 0;
    let browserRssBytes = 0;
    for (const m of members) {
      totalRssBytes += m.rssBytes;
      if (m.pid === this.pid) {
        browserRssBytes = m.rssBytes;
      } else if (m.command.includes("--type=renderer")) {
        rendererRssBytes += m.rssBytes;
        rendererCount += 1;
      }
    }
    return {
      processCount: members.length,
      rendererCount,
      browserRssBytes,
      rendererRssBytes,
      totalRssBytes,
    };
  }

  async gracefulClose(timeoutMs = 5_000) {
    if (this.#proc.exitCode !== null || this.#proc.signalCode !== null) {
      return await this.#exited;
    }
    await this.send("Browser.close").catch(() => {});
    const timer = setTimeout(() => {
      if (this.#proc.exitCode === null && this.#proc.signalCode === null) {
        try {
          process.kill(this.pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }, timeoutMs);
    try {
      return await this.#exited;
    } finally {
      clearTimeout(timer);
    }
  }

  async forceKill() {
    if (this.#proc.exitCode === null && this.#proc.signalCode === null) {
      try {
        process.kill(this.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
    return await this.#exited;
  }
}

export async function createTempProfileDir(prefix = "opensteer-exp-profile-") {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTempProfileDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Launches Chromium matching apps/browser-runtime/src/browser/playwright-launcher.ts flags
 * (headless=new, remote-debugging-pipe, disable-extensions, etc.), with optional overrides.
 */
export async function launchChromium({
  userDataDir,
  executablePath = findPinnedChromium(),
  noStartupWindow = false,
  restoreLastSession = true,
  disableFieldTrialConfig = true,
  extraArgs = [],
  disableExtensions = true,
  startUrl = undefined,
} = {}) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-pipe",
    ...(disableFieldTrialConfig ? ["--disable-field-trial-config"] : []),
    ...(disableExtensions ? ["--disable-extensions"] : []),
    "--disable-component-extensions-with-background-pages",
    "--disable-component-update",
    "--disable-background-networking",
    ...(noStartupWindow ? ["--no-startup-window"] : []),
    ...(restoreLastSession ? ["--restore-last-session"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "--window-size=1280,800",
    ...extraArgs,
    ...(startUrl ? [startUrl] : []),
  ];

  const proc = spawn(executablePath, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    env: {
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
  });

  const browser = new CdpBrowser(proc, userDataDir, executablePath);
  // Wait for CDP pipe to answer Browser.getVersion.
  const version = await browser.send("Browser.getVersion", {}, undefined, 15_000);
  browser.version = version;
  return browser;
}
