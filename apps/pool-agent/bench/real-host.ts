/**
 * The real-host run: start, pause, resume, save, restore and cold start of real guests through
 * the agent's signed API, with the measurement's state checks and timings (first CDP reply,
 * the original tab, an edited frame; warm and cold cache; 10 samples), plus the clock after a
 * 60-second sleep, HTTPS through the host-side egress proxy after each wake, isolation probes
 * from inside a guest, an agent restart in the middle of each transition, and three guests
 * waking while two save. Runs on the pool host as the relay user, the one local peer allowed to
 * reach a guest's bridge port; the root helper does what needs root (drop caches, arm a crash).
 *
 * The workload and the checks follow experiments/browser-pool/bench.py (browser-pool-gcp,
 * a74266859): three tabs of 24 MiB and 1,200 rows ("ordinary"), a draft in a fixed field, a
 * scroll position, a JavaScript marker, a ticking timer, the time origin (no reload).
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import {
  callBrowserPoolAgent,
  callBrowserPoolAgentAdmin,
  type BrowserPoolAgentCall,
  type BrowserPoolAgentKind,
  type BrowserPoolAgentResult,
  type BrowserPoolAgentSlotSummary,
  type BrowserPoolAgentStatus,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";

const options = parseArguments(process.argv.slice(2));
const provisionerKey = createPrivateKey(readFileSync(options.provisionerKey, "utf8"));
const hostKey = createPublicKey(readFileSync(options.hostKey, "utf8"));
/** A rerun creates its slots above the previous run's tombstones (review G2). */
const term = Math.floor(Date.now() / 1000);
const now = () => performance.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArguments(argv: string[]) {
  const value = (name: string, fallback?: string) => {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1]) return argv[index + 1]!;
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  };
  return {
    agent: value("agent", "http://127.0.0.1:7310"),
    admin: value("admin", "http://127.0.0.1:7311"),
    provisionerKey: value("provisioner-key"),
    hostId: value("host-id", "pool-bench-host"),
    hostKey: value("host-key"),
    helper: value("helper", "/run/opensteer-pool-bench/helper.sock"),
    out: value("out"),
    profiles: value("profiles", "/var/lib/opensteer-pool/profiles"),
    samples: Number(value("samples", "10")),
    saveAfterMs: Number(value("save-after-ms", "4000")),
    upstreamPort: Number(value("upstream-port", "8443")),
    credentials: value("credentials", "/etc/opensteer-pool-bench"),
    phases: value(
      "phases",
      "cold,memory,disk-warm,disk-cold,clock,isolation,restart,concurrent",
    ).split(","),
  };
}

/** Every row, for the run's own assertions at the end (round D, D3). */
const emitted: Record<string, unknown>[] = [];

function emit(row: Record<string, unknown>): void {
  emitted.push(row);
  appendFileSync(options.out, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
  const { after: _after, before: _before, ...short } = row;
  process.stdout.write(`${JSON.stringify(short)}\n`);
}

// ---- The root helper ----------------------------------------------------------------------

function helper(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.helper);
    let text = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => (text += chunk.toString("utf8")));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", reject);
  });
}

// ---- Slots --------------------------------------------------------------------------------

function vethInside(index: number): string {
  const base = (10 << 24) + (200 << 16) + index * 4 + 2;
  return [base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255].join(".");
}

function vethHost(index: number): string {
  const base = (10 << 24) + (200 << 16) + index * 4 + 1;
  return [base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255].join(".");
}

class Slot {
  readonly id: string;
  /** The slot's number on the host (its bridge's address); round H reads it after a create. */
  index: number;
  /** Round H: a slot made again at a higher term has its own. */
  readonly term: number;
  readonly #home: KeyObject;
  #agentKey!: KeyObject;
  readonly #guest: {
    readonly memoryMib: number;
    readonly upstreamPort: number;
    readonly egress: boolean;
  };

  constructor(
    id: string,
    index: number,
    guest: {
      readonly memoryMib?: number;
      readonly upstreamPort?: number;
      /** Round H: false on a host that pulls its slots' egress. */
      readonly egress?: boolean;
      readonly term?: number;
    } = {},
  ) {
    this.id = id;
    this.index = index;
    this.term = guest.term ?? term;
    this.#home = generateKeyPairSync("ed25519").privateKey;
    this.#guest = {
      memoryMib: guest.memoryMib ?? 2048,
      upstreamPort: guest.upstreamPort ?? options.upstreamPort,
      egress: guest.egress ?? true,
    };
  }

  /** Round H: the number the driver gave it, read once it is created. */
  async learnIndex(): Promise<void> {
    this.index = (await helper({ cmd: "slot-number", slotId: this.id })).index as number;
  }

  /** This slot's calls signed by its Home's key, at its term: what a replaced Home still has. */
  get home(): KeyObject {
    return this.#home;
  }

  get agentKey(): KeyObject {
    return this.#agentKey;
  }

  get bridge(): string {
    return `http://${vethInside(this.index)}:4312`;
  }

  async create(): Promise<void> {
    const reply = await admin({
      op: "create",
      slotId: this.id,
      term: this.term,
      homeKey: createPublicKey(this.#home)
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      guest: {
        vcpus: 2,
        memoryMib: this.#guest.memoryMib,
        // Round G: the agent makes the slot's profile under its root.
        profileMib: 1024,
        ...(this.#guest.egress
          ? {
              egress: {
                upstreamUrl: `https://192.0.43.10:${this.#guest.upstreamPort}`,
                usernameFile: `${options.credentials}/upstream-username`,
                passwordFile: `${options.credentials}/upstream-password`,
                caFile: `${options.credentials}/upstream-ca.pem`,
              },
            }
          : {}),
      },
    });
    if (reply.op !== "create") throw new Error("create failed");
    this.#agentKey = createPublicKey({
      key: Buffer.from(reply.slot.controlKey, "base64"),
      format: "der",
      type: "spki",
    });
  }

  #endpoint() {
    return {
      url: options.agent,
      homeKey: this.#home,
      agentKey: this.#agentKey,
      timeoutMs: 120_000,
    };
  }

  async status(): Promise<BrowserPoolAgentStatus> {
    const reply = await callBrowserPoolAgent(this.#endpoint(), this.id, this.term, {
      op: "status",
    });
    if (reply.op !== "status") throw new Error("status failed");
    return reply.status;
  }

  async prepare(kind: BrowserPoolAgentKind): Promise<BrowserPoolAgentCall> {
    const status = await this.status();
    return {
      id: randomUUID(),
      slotId: this.id,
      term: this.term,
      kind,
      expect: {
        instance: status.instance,
        epoch: status.epoch,
        phase: status.phase,
        savedStateId: status.savedState?.id ?? null,
      },
      ...(kind === "resume" ? { intent: { id: randomUUID(), sequence: 1 } } : {}),
    };
  }

  async send(call: BrowserPoolAgentCall): Promise<BrowserPoolAgentResult> {
    const reply = await callBrowserPoolAgent(this.#endpoint(), this.id, this.term, {
      op: "apply",
      call,
    });
    if (reply.op !== "apply") throw new Error("apply failed");
    return reply.result;
  }

  async call(kind: BrowserPoolAgentKind): Promise<{ result: BrowserPoolAgentResult; ms: number }> {
    const call = await this.prepare(kind);
    const started = now();
    const result = await this.send(call);
    if (!result.applied) throw new Error(`${kind} refused: ${result.reason}`);
    return { result, ms: now() - started };
  }

  async summary(): Promise<BrowserPoolAgentSlotSummary | undefined> {
    const reply = await admin({ op: "list" });
    if (reply.op !== "list") throw new Error("list failed");
    return reply.slots.find((slot) => slot.slotId === this.id);
  }

  async waitForDisk(timeoutMs = 120_000): Promise<number | undefined> {
    const until = now() + timeoutMs;
    for (;;) {
      const summary = await this.summary();
      if (summary?.parked?.tier === "disk") return summary.parked.writeMs;
      if (now() > until) throw new Error(`${this.id} was not saved to disk in time`);
      await sleep(50);
    }
  }

  async ensureStopped(): Promise<void> {
    const status = await this.status();
    if (status.phase !== "stopped") await this.call("stop");
  }
}

function admin(request: Parameters<typeof callBrowserPoolAgentAdmin>[1]) {
  return callBrowserPoolAgentAdmin(
    { url: options.admin, provisionerKey, host: options.hostId, hostKey, timeoutMs: 120_000 },
    request,
  );
}

// ---- CDP ----------------------------------------------------------------------------------

class Cdp {
  readonly #socket: WebSocket;
  #id = 0;
  readonly #waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.#waiting.get(message.id);
      if (!waiter) return;
      this.#waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.#waiting.values()) waiter.reject(new Error("CDP closed"));
      this.#waiting.clear();
    });
  }

  static async open(base: string): Promise<Cdp> {
    const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(500) });
    const version = (await response.json()) as { webSocketDebuggerUrl: string };
    const path = new URL(version.webSocketDebuggerUrl).pathname;
    const socket = new WebSocket(`${base.replace("http://", "ws://")}${path}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP socket timeout")), 1000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP socket error"));
      });
    });
    return new Cdp(socket);
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 90_000,
  ): Promise<T> {
    const id = ++this.#id;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async attach(targetId: string): Promise<string> {
    return (
      await this.call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
    ).sessionId;
  }

  async evaluate<T = unknown>(
    sessionId: string,
    expression: string,
    awaitPromise = false,
  ): Promise<T> {
    const response = await this.call<{ result: { value?: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise },
      sessionId,
    );
    if (response.exceptionDetails)
      throw new Error(`JavaScript: ${JSON.stringify(response.exceptionDetails)}`);
    return response.result.value as T;
  }

  close(): void {
    this.#socket.close();
  }
}

/** Polls until the browser answers Browser.getVersion; returns the time from `start`. */
async function firstReply(
  slot: Slot,
  start: number,
  deadlineMs = 90_000,
): Promise<{ cdp: Cdp; ms: number }> {
  const until = start + deadlineMs;
  for (;;) {
    let cdp: Cdp | undefined;
    try {
      cdp = await Cdp.open(slot.bridge);
      await cdp.call("Browser.getVersion", {}, undefined, 2_000);
      return { cdp, ms: now() - start };
    } catch (error) {
      cdp?.close();
      if (now() > until) throw error;
      await sleep(5);
    }
  }
}

const readState = `({
  text: document.querySelector('#test')?.value, scroll: scrollY,
  marker: window.testMarker, ticks: window.testTicks, origin: performance.timeOrigin,
  wallMs: Date.now()
})`;

interface PageState {
  text?: string;
  scroll?: number;
  marker?: string;
  ticks?: number;
  origin?: number;
  wallMs?: number;
}

interface Workload {
  readonly targets: string[];
  before: PageState;
}

async function setup(cdp: Cdp): Promise<Workload> {
  const targets: string[] = [];
  for (let tab = 0; tab < 3; tab += 1) {
    const { targetId } = await cdp.call<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    targets.push(targetId);
    const session = await cdp.attach(targetId);
    const navigation = await cdp.call<{ errorText?: string }>(
      "Page.navigate",
      { url: `http://127.0.0.1:8080/?mib=24&rows=1200&tab=${tab}` },
      session,
    );
    if (navigation.errorText) throw new Error(navigation.errorText);
    for (
      let i = 0;
      i < 500 &&
      !(await cdp.evaluate<boolean>(session, "window.fixtureReady === true").catch(() => false));
      i += 1
    )
      await sleep(50);
    await cdp.call("Target.detachFromTarget", { sessionId: session });
  }
  const { targetInfos } = await cdp.call<{ targetInfos: { targetId: string; type: string }[] }>(
    "Target.getTargets",
  );
  for (const target of targetInfos)
    if (target.type === "page" && !targets.includes(target.targetId))
      await cdp.call("Target.closeTarget", { targetId: target.targetId });
  const session = await cdp.attach(targets.at(-1)!);
  await cdp.call("Page.bringToFront", {}, session);
  await cdp.evaluate(
    session,
    `(() => {
      document.body.style.minHeight = "2400px";
      const field = document.querySelector('#test');
      field.style.position = "fixed"; field.style.top = "30px"; field.style.zIndex = "100";
      field.style.width = "480px"; field.style.fontSize = "18px";
      field.focus();
      window.testMarker = 'kept across snapshot';
      window.testTicks = 0;
      setInterval(() => window.testTicks++, 50);
    })()`,
  );
  await cdp.call("Input.insertText", { text: "typed before standby" }, session);
  await cdp.evaluate(session, "scrollTo(0, 700)");
  const before = await cdp.evaluate<PageState>(session, readState);
  await cdp.call("Target.detachFromTarget", { sessionId: session });
  if (before.text !== "typed before standby" || before.scroll !== 700)
    throw new Error("invalid setup state");
  return { targets, before };
}

/** Puts the draft back to its baseline before a park, so every wake checks the same edit. */
async function rebase(cdp: Cdp, workload: Workload): Promise<void> {
  const session = await cdp.attach(workload.targets.at(-1)!);
  await cdp.evaluate(session, "document.querySelector('#test').value = 'typed before standby'");
  workload.before = await cdp.evaluate<PageState>(session, readState);
  await cdp.call("Target.detachFromTarget", { sessionId: session });
}

async function httpsProbe(cdp: Cdp, session: string): Promise<string> {
  return cdp.evaluate<string>(
    session,
    `fetch('https://example.com/?pool=' + Date.now(), { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(8000) })
      .then(r => r.type).catch(e => String(e))`,
    true,
  );
}

/** The measurement's observe_browser: original tab, checks, an edited frame, the timer. */
async function observe(
  slot: Slot,
  start: number,
  workload: Workload,
  extra: Record<string, unknown> = {},
) {
  const row: Record<string, unknown> = { slot: slot.id, ...extra };
  const { cdp, ms } = await firstReply(slot, start);
  row.cdp_ms = ms;
  try {
    const session = await cdp.attach(workload.targets.at(-1)!);
    const after = await cdp.evaluate<PageState>(session, readState);
    row.same_tab_ms = now() - start;
    const checks: Record<string, boolean> = {
      text: after.text === workload.before.text,
      scroll: after.scroll === workload.before.scroll,
      marker: after.marker === workload.before.marker,
      no_reload: after.origin === workload.before.origin,
    };
    const screenshot = await cdp.call<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
      session,
    );
    await cdp.evaluate(
      session,
      `(() => { const f = document.querySelector('#test'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); })()`,
    );
    await cdp.call("Input.insertText", { text: " + after wake" }, session);
    const text = await cdp.evaluate<string>(session, "document.querySelector('#test').value");
    const edited = await cdp.call<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
      session,
    );
    checks.edited = text === "typed before standby + after wake";
    checks.frame_changed = screenshot.data !== edited.data;
    if (checks.edited && checks.frame_changed) row.edited_frame_ms = now() - start;
    row.host_wall_ms = Date.now();
    row.guest_wall_ms = after.wallMs;
    const httpsSince = new Date(Date.now() - 1_000).toISOString().replace("T", " ").slice(0, 19);
    row.https = await httpsProbe(cdp, session);
    checks.https = row.https === "opaque";
    if (!checks.https)
      row.egress_log = (
        (await helper({ cmd: "egress-log", since: httpsSince })).lines as string[]
      ).map((line) => line.slice(0, 300));
    const ticked = await cdp.evaluate<number>(
      session,
      "new Promise(resolve => setTimeout(() => resolve(window.testTicks), 1100))",
      true,
    );
    checks.timer =
      ticked > (after.ticks ?? -1) && (after.ticks ?? -1) >= (workload.before.ticks ?? 0);
    for (const target of workload.targets) {
      const tab = await cdp.attach(target);
      const value = await cdp.evaluate<{ mib: number; rows: number }>(
        tab,
        "({ mib: window.workload?.length ?? 0, rows: document.querySelectorAll('article').length })",
      );
      if (value.mib !== 24 || value.rows !== 1200) checks.workload = false;
      await cdp.call("Target.detachFromTarget", { sessionId: tab });
    }
    checks.workload ??= true;
    await cdp.call("Target.detachFromTarget", { sessionId: session });
    row.checks = checks;
    row.passed = Object.values(checks).every(Boolean);
    return { row, cdp };
  } catch (error) {
    cdp.close();
    throw error;
  }
}

async function guestStatus(slot: Slot) {
  const response = await fetch(`${slot.bridge}/status`, { signal: AbortSignal.timeout(2000) });
  return (await response.json()) as { wallMs: number; clocksource: string };
}

// ---- Phases -------------------------------------------------------------------------------

async function coldStarts(slot: Slot): Promise<{ cdp: Cdp; workload: Workload }> {
  let last: Cdp | undefined;
  for (let sample = 1; sample <= options.samples; sample += 1) {
    last?.close();
    await slot.ensureStopped();
    const start = now();
    const started = await slot.call("start");
    const { cdp, ms } = await firstReply(slot, start);
    const status = await guestStatus(slot);
    emit({
      kind: "cold",
      slot: slot.id,
      sample,
      cdp_ms: ms,
      start_call_ms: started.ms,
      clocksource: status.clocksource,
    });
    last = cdp;
  }
  const workload = await setup(last!);
  return { cdp: last!, workload };
}

async function wakes(
  slot: Slot,
  live: { cdp: Cdp; workload: Workload },
  tier: "memory" | "disk-warm" | "disk-cold",
  samples: number,
  idleMs = 0,
  extra: Record<string, unknown> = {},
) {
  for (let sample = 1; sample <= samples; sample += 1) {
    await rebase(live.cdp, live.workload);
    live.cdp.close();
    const paused = await slot.call("pause");
    let writeMs: number | undefined;
    if (tier === "memory") await sleep(Math.max(500, idleMs));
    else {
      writeMs = await slot.waitForDisk();
      if (idleMs) await sleep(idleMs);
      if (tier === "disk-cold") await helper({ cmd: "drop" });
    }
    const start = now();
    const resumed = await slot.call("resume");
    const { row, cdp } = await observe(slot, start, live.workload, {
      kind: "wake",
      tier,
      sample,
      pause_call_ms: paused.ms,
      resume_call_ms: resumed.ms,
      ...(writeMs === undefined ? {} : { save_ms: writeMs }),
      ...extra,
    });
    emit(row);
    live.cdp = cdp;
  }
}

/**
 * Round D, D1 on a host: a slot proxy made to crash in a loop stops being restarted (systemd's
 * start limit), PID 1 is not kept busy, the slot's status says its proxy is down, the guest has
 * no network meanwhile, and the slot's next start brings the proxy back.
 */
/** A systemd time span ("2min", "1s", "500ms", "1.500000s") in microseconds. */
function microseconds(span: unknown): number | null {
  const match = /^([\d.]+)(us|ms|s|min)$/u.exec(String(span));
  if (!match) return null;
  return Number(match[1]) * { us: 1, ms: 1e3, s: 1e6, min: 6e7 }[match[2] as "us"];
}

/**
 * Round E, E3: the proxy unit's bounds the results claim, asserted from `systemctl show`: the
 * start-limit window and burst, one proxy's memory and CPU ceilings, its slice, and the
 * slice's own memory ceiling and CPU ceiling (a quarter of the host's cores, at least one).
 */
async function proxyUnit(slot: Slot) {
  const read = await helper({ cmd: "proxy-unit", index: slot.index });
  const unit = read.unit as Record<string, string>;
  const slice = read.slice as Record<string, string>;
  const cores = read.cores as number;
  const expected = {
    start_limit_window_us: 120e6,
    start_limit_burst: "5",
    memory_max: String(128 * 1024 ** 2),
    cpu_quota_us: 1e6,
    slice: "opensteer-pool-egress.slice",
    slice_memory_max: String(1536 * 1024 ** 2),
    slice_cpu_quota_us: Math.max(1, cores / 4) * 1e6,
    // In force: the kernel's cpu.max for the slice, per 100 ms period.
    slice_cpu_max: `${Math.max(1, cores / 4) * 100_000} 100000`,
  };
  const found = {
    start_limit_window_us: microseconds(unit.StartLimitIntervalUSec),
    start_limit_burst: unit.StartLimitBurst,
    memory_max: unit.MemoryMax,
    cpu_quota_us: microseconds(unit.CPUQuotaPerSecUSec),
    slice: unit.Slice,
    slice_memory_max: slice.MemoryMax,
    slice_cpu_quota_us: microseconds(slice.CPUQuotaPerSecUSec),
    slice_cpu_max: read.sliceCpuMax,
  };
  emit({
    kind: "proxy-unit",
    cores,
    expected,
    found,
    ok: JSON.stringify(found) === JSON.stringify(expected),
  });
}

async function crashLoop(slot: Slot) {
  await slot.ensureStopped();
  await slot.call("start");
  await proxyUnit(slot);
  let { cdp } = await firstReply(slot, now());
  let workload = await setup(cdp);
  const https = async () => {
    const session = await cdp.attach(workload.targets.at(-1)!);
    return httpsProbe(cdp, session);
  };
  const before = await https();
  const loop = await helper({ cmd: "proxy-crash-loop", index: slot.index, seconds: 45 });
  let down: string | undefined;
  for (let waited = 0; waited < 30_000 && down !== "down"; waited += 1_000) {
    down = (await slot.status()).proxy;
    if (down !== "down") await sleep(1_000);
  }
  const whileDown = await https();
  cdp.close();
  await slot.call("stop");
  await slot.call("start");
  ({ cdp } = await firstReply(slot, now()));
  workload = await setup(cdp);
  const after = await https();
  const statusAfter = (await slot.status()).proxy ?? null;
  cdp.close();
  emit({
    kind: "crash-loop",
    https_before: before,
    loop,
    status_proxy: down ?? null,
    https_while_down: whileDown,
    https_after_restart: after,
    status_after_restart: statusAfter,
    ok:
      before === "opaque" &&
      // Round E, E3: tripped means failed, not merely "not active".
      loop.service === "failed" &&
      down === "down" &&
      whileDown !== "opaque" &&
      after === "opaque" &&
      statusAfter === null &&
      (loop.pid1_cpu_ms as number) < 5_000,
  });
}

/**
 * Round D, D1 on a host: while one guest floods its own proxy (connections opened and dropped in
 * a tight loop, and refused requests), another slot's wake from disk and its HTTPS check are
 * the same as without the flood.
 */
async function floodNeighbour(victim: Slot, flooder: Slot, samples: number) {
  for (const slot of [victim, flooder]) await slot.ensureStopped();
  await victim.call("start");
  const victimCdp = await firstReply(victim, now());
  const live = { cdp: victimCdp.cdp, workload: await setup(victimCdp.cdp) };
  await flooder.call("start");
  const flooderCdp = (await firstReply(flooder, now())).cdp;
  const flooderWork = await setup(flooderCdp);
  await wakes(victim, live, "disk-warm", samples, 0, { kind: "flood-wake", flood: false });
  const session = await flooderCdp.attach(flooderWork.targets.at(-1)!);
  await flooderCdp.evaluate(
    session,
    `(() => {
      window.floodOn = true;
      window.floodCount = 0;
      const once = () => {
        const stop = new AbortController();
        fetch('https://example.com/?flood=' + Math.random(), { mode: 'no-cors', cache: 'no-store', signal: stop.signal }).catch(() => {});
        fetch('http://10.9.9.9/refused?' + Math.random(), { mode: 'no-cors', signal: stop.signal }).catch(() => {});
        setTimeout(() => stop.abort(), 5);
        window.floodCount += 2;
      };
      (async () => { while (window.floodOn) { for (let i = 0; i < 20; i += 1) once(); await new Promise((r) => setTimeout(r, 5)); } })();
      return true;
    })()`,
  );
  const usage = await helper({ cmd: "proxy-usage", index: flooder.index });
  await wakes(victim, live, "disk-warm", samples, 0, { kind: "flood-wake", flood: true });
  const count = await flooderCdp.evaluate<number>(
    session,
    "window.floodOn = false, window.floodCount",
  );
  flooderCdp.close();
  live.cdp.close();
  await flooder.call("stop");
  const rows = emitted.filter((row) => row.kind === "flood-wake");
  const median = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1]!;
  const of = (flood: boolean) => rows.filter((row) => row.flood === flood);
  const baseline = median(of(false).map((row) => row.cdp_ms as number));
  const flooded = median(of(true).map((row) => row.cdp_ms as number));
  emit({
    kind: "flood",
    samples,
    requests_sent: count,
    flooder_proxy: usage,
    baseline_cdp_median_ms: Math.round(baseline),
    flooded_cdp_median_ms: Math.round(flooded),
    baseline_https_ok: of(false).filter((row) => row.https === "opaque").length,
    flooded_https_ok: of(true).filter((row) => row.https === "opaque").length,
    ok:
      of(false).every((row) => row.https === "opaque") &&
      of(true).every((row) => row.https === "opaque") &&
      flooded <= baseline * 1.5 + 100,
  });
}

/** What one Chromium holds on its proxy while the series run (round D, D1), sampled. */
function proxySampler(slot: Slot) {
  const peak = { connections: 0, memory: 0, samples: 0 };
  let running = true;
  void (async () => {
    while (running) {
      const usage = await helper({ cmd: "proxy-usage", index: slot.index }).catch(() => undefined);
      if (usage) {
        peak.samples += 1;
        peak.connections = Math.max(peak.connections, (usage.connections as number) ?? 0);
        peak.memory = Math.max(peak.memory, (usage.memory as number | null) ?? 0);
      }
      await sleep(250);
    }
  })();
  return () => {
    running = false;
    emit({ kind: "proxy-usage", slot: slot.id, ...peak });
  };
}

// ---- Round F on the host ------------------------------------------------------------------

const mib = 1024 ** 2;
const spkiOf = (key: KeyObject) =>
  (key.type === "public" ? key : createPublicKey(key))
    .export({ format: "der", type: "spki" })
    .toString("base64");
const agentLines = async (since: string) =>
  ((await helper({ cmd: "agent-events", since })).lines as string[]).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
const sinceNow = () => new Date(Date.now() - 1_000).toISOString().replace("T", " ").slice(0, 19);
const refusalOf = (error: unknown) => ({
  name: error instanceof Error ? error.name : "unknown",
  message: error instanceof Error ? error.message : String(error),
});

/**
 * E1 on a host: the replacement of a Home's keys is held in its stop of the guest's proxy (a
 * slow `systemctl stop`, one shot), and the old Home sends a call at the old term meanwhile. It
 * is refused as unauthenticated, after the replacement, and nothing is stored under its id.
 */
async function oldKeyDuringReplacement() {
  const slot = new Slot("bench-e1", -1);
  await slot.create();
  await slot.call("start");
  const index = (await helper({ cmd: "slot-number", slotId: slot.id })).index as number;
  const pause = await slot.prepare("pause");
  await helper({
    cmd: "slow-tool",
    tool: "systemctl-stop",
    unit: `opensteer-pool-egress-${index}.service`,
    seconds: 3,
  });
  const next = generateKeyPairSync("ed25519");
  const began = now();
  let replacedAt = 0;
  const replacing = admin({
    op: "replace-key",
    slotId: slot.id,
    term: term + 1,
    homeKey: spkiOf(next.publicKey),
  }).then((reply) => ((replacedAt = now()), reply));
  // Inside the held stop: the old Home's call is authenticated under the old key and queued.
  await sleep(1_000);
  let answeredAt = 0;
  const sent = slot.send(pause).then(
    (result) => ((answeredAt = now()), { answered: result }),
    (error: unknown) => ((answeredAt = now()), refusalOf(error)),
  );
  const replaced = await replacing;
  const reply = await sent;
  const held = (await helper({ cmd: "slow-tool", used: "slow-systemctl-stop" })).used;
  await helper({ cmd: "slow-tool", remove: true });
  // The new Home finds nothing of the old Home's call.
  const stored = await callBrowserPoolAgent(
    { url: options.agent, homeKey: next.privateKey, agentKey: slot.agentKey, timeoutMs: 60_000 },
    slot.id,
    term + 1,
    { op: "result", id: pause.id },
  );
  await admin({ op: "delete", slotId: slot.id, term: term + 1 });
  emit({
    kind: "e1-old-key",
    held,
    replace_ms: Math.round(replacedAt - began),
    reply,
    answered_after_replacement: answeredAt >= replacedAt,
    stored_for_new_home: stored.op === "result" ? stored.result : stored,
    ok:
      replaced.op === "replace-key" &&
      Array.isArray(held) &&
      "name" in reply &&
      reply.name === "BrowserPoolAgentUnavailable" &&
      /not signed by this slot's Home/u.test(reply.message) &&
      answeredAt >= replacedAt &&
      stored.op === "result" &&
      stored.result === null,
  });
}

/**
 * E2 on a host: a slot whose proxy must be defined again at its start (its socket taken down),
 * with that `systemd-run` slow (one shot, SIGTERM ignored, as a request PID 1 already took),
 * past the 5 s network step; then the slot is deleted, then a new slot is made. No socket is
 * left for the deleted slot, and the new slot's proxy carries its own upstream.
 */
async function slowRevive() {
  const old = new Slot("bench-e2-old", -1, { upstreamPort: 8443 });
  await old.create();
  await old.call("start");
  await old.call("stop");
  const number = (await helper({ cmd: "slot-number", slotId: old.id })).index as number;
  await helper({ cmd: "egress-socket", index: number, action: "stop" });
  await helper({ cmd: "slow-tool", tool: "systemd-run", seconds: 8 });
  const since = sinceNow();
  const began = now();
  const starting = old.call("start").then(
    () => "started",
    (error: unknown) => refusalOf(error),
  );
  // Past the network step's 5 s deadline: the start has given up on the revive.
  await sleep(5_500);
  const deleting = admin({ op: "delete", slotId: old.id, term });
  const [start, deleted] = await Promise.all([starting, deleting]);
  const deleteMs = now() - began;
  const used = (await helper({ cmd: "slow-tool", used: "slow-systemd-run" })).used;
  await helper({ cmd: "slow-tool", remove: true });
  const afterDelete = await helper({ cmd: "egress-unit", index: number });
  const fresh = new Slot("bench-e2-new", -1, { upstreamPort: 8444 });
  await fresh.create();
  const freshNumber = (await helper({ cmd: "slot-number", slotId: fresh.id })).index as number;
  const freshUnit = await helper({ cmd: "egress-unit", index: freshNumber });
  const drained = (await agentLines(since)).some(
    (line) => line.event === "step.draining" && line.slotId === old.id,
  );
  await admin({ op: "delete", slotId: fresh.id, term });
  emit({
    kind: "e2-slow-revive",
    old_number: number,
    new_number: freshNumber,
    slow_systemd_run: used,
    start,
    drained,
    delete_done_ms: Math.round(deleteMs),
    after_delete: afterDelete,
    new_slot: freshUnit,
    ok:
      Array.isArray(used) &&
      start !== "started" &&
      drained &&
      deleted.op === "delete" &&
      afterDelete.socket !== "active" &&
      (afterDelete.listed as string[]).every((line) => !/ active /u.test(` ${line} `)) &&
      freshUnit.upstream === "https://192.0.43.10:8444",
  });
}

/**
 * E4 on a host: guests sized so the host holds four in memory. Three are parked in memory
 * (oldest first) and one runs; two starts at once save the two oldest to disk; two more at once
 * save the third, and the one that still does not fit is refused "try again later", and is let
 * in when a guest leaves. The kernel kills nothing in the guests' group or the proxies' slice.
 */
async function capacity(others: Slot[]) {
  for (const slot of others) await slot.ensureStopped();
  // Parked guests stay in memory until the run says otherwise. The agent restarts with it and
  // logs the capacity it admits guests by.
  const restarted = sinceNow();
  await helper({ cmd: "configure", saveAfterSeconds: null });
  await waitForAgent(others[0]!);
  const logged = (await agentLines(restarted)).filter((line) => line.event === "capacity").at(-1);
  if (!logged) throw new Error("The agent logged no capacity.");
  const guestBytes = logged.guestBytes as number;
  // The largest guest of which four fit and five do not, in 256 MiB steps.
  const memoryMib = Math.floor((guestBytes / 4 / mib - 512) / 256) * 256;
  const holds = Math.floor(guestBytes / ((memoryMib + 512) * mib));
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const slots = Object.fromEntries(
    names.map((name) => [name, new Slot(`bench-cap-${name}`, -1, { memoryMib })]),
  ) as Record<string, Slot>;
  for (const slot of Object.values(slots)) await slot.create();
  const before = await helper({ cmd: "capacity-events" });
  const marks = sinceNow();
  for (const name of ["a", "b", "c"]) {
    await slots[name]!.call("start");
    await slots[name]!.call("pause");
  }
  await slots.d!.call("start");
  const tier = async (slot: Slot) => {
    const summary = await slot.summary();
    return summary?.parked?.tier ?? summary?.status.phase ?? null;
  };
  const startAll = (batch: Slot[]) =>
    Promise.all(
      batch.map(async (slot) => {
        const call = await slot.prepare("start");
        return slot.send(call).then(
          (result) => ({ slot: slot.id, call, applied: result.applied }),
          (error: unknown) => ({ slot: slot.id, call, ...refusalOf(error) }),
        );
      }),
    );
  const first = await startAll([slots.e!, slots.f!]);
  const afterFirst = { a: await tier(slots.a!), b: await tier(slots.b!), c: await tier(slots.c!) };
  const second = await startAll([slots.g!, slots.h!]);
  const afterSecond = { c: await tier(slots.c!) };
  const refused = second.flatMap((entry) => ("applied" in entry ? [] : [entry]));
  // A guest leaves memory; the refused start, sent again as a Home's journal does, is let in.
  await slots.d!.call("stop");
  const retried = refused[0]
    ? await slots[refused[0].slot.slice("bench-cap-".length)]!.send(refused[0].call).then(
        (result) => result.applied,
        (error: unknown) => refusalOf(error),
      )
    : null;
  const after = await helper({ cmd: "capacity-events" });
  // Each guest the agent chose to save, in the order it first chose it (two starts let in at
  // once may both choose the oldest; the second's save is then skipped).
  const saves = [
    ...new Set(
      (await agentLines(marks))
        .filter((line) => line.event === "capacity.save")
        .map((line) => line.saving as string),
    ),
  ];
  const kills = (events: Record<string, unknown>) =>
    ((events.guests as Record<string, number> | null)?.oom_kill ?? 0) +
    ((events.slice as Record<string, number> | null)?.oom_kill ?? 0);
  for (const slot of Object.values(slots)) await admin({ op: "delete", slotId: slot.id, term });
  await helper({ cmd: "configure", saveAfterSeconds: options.saveAfterMs / 1000 });
  await waitForAgent(others[0]!);
  emit({
    kind: "capacity",
    guest_budget_bytes: guestBytes,
    guest_memory_mib: memoryMib,
    holds,
    first: first.map(({ call: _call, ...entry }) => entry),
    after_first: afterFirst,
    second: second.map(({ call: _call, ...entry }) => entry),
    after_second: afterSecond,
    saved_in_order: saves,
    retried,
    events_before: before,
    events_after: after,
    ok:
      holds === 4 &&
      first.every((entry) => "applied" in entry && entry.applied) &&
      afterFirst.a === "disk" &&
      afterFirst.b === "disk" &&
      afterFirst.c === "memory" &&
      afterSecond.c === "disk" &&
      second.filter((entry) => "applied" in entry && entry.applied).length === 1 &&
      refused.length === 1 &&
      refused[0]!.name === "BrowserPoolAgentUnavailable" &&
      /try again later/u.test(refused[0]!.message) &&
      retried === true &&
      JSON.stringify(saves) === JSON.stringify(["bench-cap-a", "bench-cap-b", "bench-cap-c"]) &&
      kills(after) === kills(before) &&
      after.failedProxies === 0,
  });
}

// ---- Round H on the host ------------------------------------------------------------------

/**
 * Items (a) to (c): the agent makes the profile (mkfs.ext4 and the link into place on the
 * profiles' own filesystem), the guest boots from it, a delete without eraseProfile keeps it,
 * a create at a higher term finds the person's marker in it, and a delete with eraseProfile
 * answers profileErased only with the file gone.
 */
async function agentMadeProfile() {
  const mount = (await helper({ cmd: "profiles-mount" })).mount;
  const slot = new Slot("bench-prof", -1);
  await slot.create();
  await slot.learnIndex();
  const made = await helper({ cmd: "profile-file", slotId: slot.id });
  let began = now();
  await slot.call("start");
  const first = await firstReply(slot, began);
  first.cdp.close();
  await slot.call("stop");
  await helper({ cmd: "profile-marker", slotId: slot.id, action: "write", text: "round-h-marker" });
  const kept = await admin({ op: "delete", slotId: slot.id, term: slot.term });
  const afterDelete = await helper({ cmd: "profile-file", slotId: slot.id });
  const again = new Slot("bench-prof", -1, { term: slot.term + 1 });
  await again.create();
  await again.learnIndex();
  const marker = (await helper({ cmd: "profile-marker", slotId: slot.id, action: "read" })).text;
  began = now();
  await again.call("start");
  const second = await firstReply(again, began);
  second.cdp.close();
  await again.call("stop");
  const markerAfterBoot = (await helper({ cmd: "profile-marker", slotId: slot.id, action: "read" }))
    .text;
  const erased = await admin({
    op: "delete",
    slotId: slot.id,
    term: again.term,
    eraseProfile: true,
  } as never);
  const afterErase = await helper({ cmd: "profile-file", slotId: slot.id });
  emit({
    kind: "agent-profile",
    mount,
    made,
    first_reply_ms: Math.round(first.ms),
    delete_kept: kept,
    after_delete: afterDelete,
    marker,
    second_reply_ms: Math.round(second.ms),
    marker_after_boot: markerAfterBoot,
    delete_erased: erased,
    after_erase: afterErase,
    ok:
      made.exists === true &&
      made.type === "ext4" &&
      (made.apparentBytes as number) === 1024 * 1024 * 1024 &&
      kept.op === "delete" &&
      !("profileErased" in kept) &&
      afterDelete.exists === true &&
      marker === "round-h-marker" &&
      markerAfterBoot === "round-h-marker" &&
      erased.op === "delete" &&
      (erased as { profileErased?: boolean }).profileErased === true &&
      afterErase.exists === false,
  });
}

/** Item (e): mkfs.ext4 as the agent runs it, for profile sizes a host may be given. */
async function mkfsTimes() {
  const times = [];
  for (const sizeMib of [2048, 10_240, 51_200])
    times.push(await helper({ cmd: "mkfs-time", sizeMib }));
  emit({ kind: "mkfs-time", times, ok: times.every((time) => typeof time.ms === "number") });
}

/**
 * Item (d): no upstream, no start, with a stand-in account service and a stand-in upstream
 * (a root only this instance trusts). None assigned: egress-required, no guest, and the slot's
 * proxy refuses a request. Assigned: the guest's HTTPS leaves through the upstream with the
 * slot's credentials. Those credentials removed: the guest's HTTPS fails and nothing more
 * reaches the upstream.
 */
async function pulledEgress(others: Slot[]) {
  for (const slot of others) await slot.ensureStopped();
  const standins = await helper({ cmd: "standins", assigned: ["bench-eg-yes"] });
  await helper({ cmd: "pull-mode", origin: standins.origin });
  await waitForAgent(others[0]!);
  const none = new Slot("bench-eg-none", -1, { egress: false });
  await none.create();
  await none.learnIndex();
  const noneStart = await none.call("start").then(
    () => "started",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const noneVmms = (await helper({ cmd: "vmm-pids", slotId: none.id })).pids as string[];
  const noneUnit = await helper({ cmd: "egress-unit", index: none.index });
  const noneRequest = await helper({ cmd: "proxy-request", index: none.index });
  const yes = new Slot("bench-eg-yes", -1, { egress: false });
  await yes.create();
  await yes.learnIndex();
  const began = now();
  await yes.call("start");
  const reply = await firstReply(yes, began);
  const work = await setup(reply.cdp);
  const session = await reply.cdp.attach(work.targets.at(-1)!);
  const https = await httpsProbe(reply.cdp, session);
  const yesUnit = await helper({ cmd: "egress-unit", index: yes.index });
  const credentials = await helper({ cmd: "credentials-info", slotId: yes.id });
  const upstreamBefore = (await helper({ cmd: "standin-log", which: "upstream" })).lines as {
    line?: string;
    authOk?: boolean;
  }[];
  await helper({ cmd: "credentials-remove", slotId: yes.id, index: yes.index });
  const httpsAfter = await httpsProbe(reply.cdp, session);
  const upstreamAfter = (await helper({ cmd: "standin-log", which: "upstream" }))
    .lines as unknown[];
  const unitAfter = await helper({ cmd: "egress-unit", index: yes.index });
  reply.cdp.close();
  const account = (await helper({ cmd: "standin-log", which: "account" })).lines as {
    slotId?: string;
    signatureOk?: boolean;
    assigned?: boolean;
  }[];
  await yes.call("stop");
  const deleted = [];
  for (const slot of [none, yes])
    deleted.push(
      await admin({ op: "delete", slotId: slot.id, term: slot.term, eraseProfile: true } as never),
    );
  const files = credentials.files as Record<string, { mode: string; uid: number } | null>;
  emit({
    kind: "egress-pull",
    none: { start: noneStart, vmms: noneVmms.length, unit: noneUnit, request: noneRequest },
    yes: {
      https,
      unit: yesUnit,
      credentials,
      https_after_removal: httpsAfter,
      unit_after: unitAfter,
    },
    upstream: upstreamBefore,
    upstream_after_removal: upstreamAfter.length - upstreamBefore.length,
    account,
    deleted,
    ok:
      /egress-required/u.test(noneStart) &&
      noneVmms.length === 0 &&
      noneUnit.required === true &&
      noneUnit.upstream === null &&
      !String(noneRequest.result).startsWith("200") &&
      account.some((row) => row.slotId === none.id && row.signatureOk && !row.assigned) &&
      account.some((row) => row.slotId === yes.id && row.signatureOk && row.assigned) &&
      https === "opaque" &&
      yesUnit.required === true &&
      yesUnit.upstream === "https://192.0.43.10:8443" &&
      credentials.dir === "700" &&
      ["url", "username", "password"].every(
        (kind) => files[kind]?.mode === "600" && files[kind]?.uid === 0,
      ) &&
      upstreamBefore.some(
        (row) => /^CONNECT example\.com:443 /u.test(row.line ?? "") && row.authOk,
      ) &&
      upstreamBefore.every((row) => row.line === undefined || row.authOk) &&
      httpsAfter !== "opaque" &&
      upstreamAfter.length === upstreamBefore.length &&
      deleted.every(
        (entry) =>
          entry.op === "delete" &&
          (entry as { credentialsErased?: boolean }).credentialsErased === true,
      ),
  });
}

/** Round D, D3: the run's own verdict, from every row it wrote. */
function assertAll() {
  const failed = emitted.filter(
    (row) =>
      row.passed === false ||
      row.ok === false ||
      ("https" in row && row.https !== "opaque" && row.kind !== "crash-loop"),
  );
  emit({
    kind: "assertions",
    rows: emitted.length,
    failed: failed.map((row) => `${String(row.kind)}${row.tier ? ` ${String(row.tier)}` : ""}`),
    ok: failed.length === 0,
  });
  if (failed.length) process.exitCode = 1;
}

async function clock(slot: Slot, live: { cdp: Cdp; workload: Workload }) {
  // In memory: the agent keeps a guest paused in memory only as long as its idle threshold.
  await helper({ cmd: "configure", saveAfterSeconds: null });
  await waitForAgent(slot);
  for (const tier of ["memory", "disk-warm"] as const) {
    if (tier === "disk-warm") {
      await helper({ cmd: "configure", saveAfterSeconds: options.saveAfterMs / 1000 });
      await waitForAgent(slot);
    }
    await rebase(live.cdp, live.workload);
    live.cdp.close();
    const pausedAt = Date.now();
    await slot.call("pause");
    if (tier === "disk-warm") await slot.waitForDisk();
    await sleep(Math.max(0, 60_000 - (Date.now() - pausedAt)));
    const start = now();
    await slot.call("resume");
    const status = await guestStatus(slot);
    const hostWall = Date.now();
    const { row, cdp } = await observe(slot, start, live.workload, {
      kind: "clock",
      tier,
      slept_ms: hostWall - pausedAt,
      guest_behind_ms: hostWall - status.wallMs,
      clocksource: status.clocksource,
    });
    emit(row);
    live.cdp = cdp;
  }
}

async function isolation(slots: Slot[]) {
  const [own, other] = slots;
  const facts = await helper({ cmd: "facts" });
  const targets: [string, string, number, "connected" | "blocked"][] = [
    ["own egress proxy (positive control)", "172.16.0.1", 3128, "connected"],
    ["GCE metadata IPv4", "169.254.169.254", 80, "blocked"],
    ["GCE metadata IPv6", "fd20:ce::254", 80, "blocked"],
    ["AWS-style metadata IPv6", "fd00:ec2::254", 80, "blocked"],
    ["agent Home port via own veth", vethHost(own!.index), 7310, "blocked"],
    ["agent admin port via own veth", vethHost(own!.index), 7311, "blocked"],
    ["agent Home port on host address", String(facts.hostAddress), 7310, "blocked"],
    ["host sshd", String(facts.hostAddress), 22, "blocked"],
    ["another guest's bridge", vethInside(other!.index), 4312, "blocked"],
    ["another slot's proxy (its host veth)", vethHost(other!.index), 3128, "blocked"],
    ["internet direct (TCP 443)", "1.1.1.1", 443, "blocked"],
    ["public DNS direct (TCP 53)", "8.8.8.8", 53, "blocked"],
    ["proxy namespace's other ports", "172.16.0.1", 22, "blocked"],
  ];
  for (const [what, host, port, want] of targets) {
    const response = await fetch(
      `${own!.bridge}/probe?host=${encodeURIComponent(host)}&port=${port}`,
      { signal: AbortSignal.timeout(5000) },
    );
    const probe = (await response.json()) as { result: string; ms: number };
    const ok = want === "connected" ? probe.result === "connected" : probe.result !== "connected";
    emit({
      kind: "isolation",
      from: "guest",
      what,
      host,
      port,
      result: probe.result,
      ms: probe.ms,
      want,
      ok,
    });
  }
  // The bridge seam admits only the relay user: root on the host is refused, the bench is not.
  const asRoot = await helper({ cmd: "probe", host: vethInside(own!.index), port: 4312 });
  emit({
    kind: "isolation",
    from: "host root",
    what: "a guest's bridge port",
    result: asRoot.result,
    want: "blocked",
    ok: asRoot.result !== "connected",
  });
  const asRelay = await fetch(`${own!.bridge}/status`, { signal: AbortSignal.timeout(2000) }).then(
    () => "connected",
    (error: unknown) => String(error),
  );
  emit({
    kind: "isolation",
    from: "host relay user",
    what: "a guest's bridge port",
    result: asRelay,
    want: "connected",
    ok: asRelay === "connected",
  });
}

async function waitForAgent(slot: Slot, timeoutMs = 60_000): Promise<void> {
  const until = now() + timeoutMs;
  for (;;) {
    try {
      await slot.status();
      return;
    } catch (error) {
      if (now() > until) throw error;
      await sleep(100);
    }
  }
}

/** Arms a SIGKILL at `point`, runs `trigger`, waits for the agent to come back. */
async function crashAt(slot: Slot, point: string, trigger: () => Promise<unknown>) {
  await helper({ cmd: "arm", point });
  await waitForAgent(slot);
  const outcome = await trigger().then(
    () => "answered",
    (error: unknown) => `lost: ${error instanceof Error ? error.message : String(error)}`,
  );
  await sleep(1500);
  await waitForAgent(slot);
  return outcome;
}

async function restarts(slot: Slot, live: { cdp?: Cdp; workload?: Workload }) {
  live.cdp?.close();
  const record = async (point: string, call: BrowserPoolAgentCall | undefined, outcome: string) => {
    const repeated = call ? await slot.send(call) : undefined;
    const again = call ? await slot.send(call) : undefined;
    const writers = (await helper({ cmd: "writers", slotId: slot.id })).count as number;
    const status = await slot.status();
    // A cold start must always work afterwards.
    if (status.phase === "paused") await slot.call("resume");
    await slot.ensureStopped();
    const start = now();
    await slot.call("start");
    const cold = await firstReply(slot, start);
    cold.cdp.close();
    emit({
      kind: "restart",
      point,
      first_outcome: outcome,
      repeated: repeated
        ? { applied: repeated.applied, reason: repeated.reason, phase: repeated.status.phase }
        : null,
      same_answer: JSON.stringify(repeated) === JSON.stringify(again),
      status_after: status.phase,
      writers_after_restart: writers,
      cold_start_after_ms: cold.ms,
      ok: writers <= 1 && JSON.stringify(repeated) === JSON.stringify(again),
    });
  };
  const running = async () => {
    const status = await slot.status();
    if (status.phase === "paused") await slot.call("resume");
    if ((await slot.status()).phase !== "running") await slot.call("start");
    const reply = await firstReply(slot, now());
    reply.cdp.close();
  };
  // Calls interrupted in the middle: the Home repeats the same call after the restart.
  const cases: { point: string; arrange: () => Promise<void>; kind: BrowserPoolAgentKind }[] = [
    { point: "start:journaled", arrange: () => slot.ensureStopped(), kind: "start" },
    { point: "start:booted", arrange: () => slot.ensureStopped(), kind: "start" },
    { point: "pause:paused", arrange: running, kind: "pause" },
    {
      point: "resume:consumed",
      arrange: async () => {
        await running();
        await slot.call("pause");
      },
      kind: "resume",
    },
    {
      point: "resume:resumed",
      arrange: async () => {
        await running();
        await slot.call("pause");
      },
      kind: "resume",
    },
    {
      point: "resume:restored",
      arrange: async () => {
        await running();
        await slot.call("pause");
        await slot.waitForDisk();
      },
      kind: "resume",
    },
    { point: "stop:killed", arrange: running, kind: "stop" },
  ];
  for (const { point, arrange, kind } of cases) {
    await arrange();
    const call = await slot.prepare(kind);
    const outcome = await crashAt(slot, point, () => slot.send(call));
    await record(point, call, outcome);
  }
  // The idle save, interrupted in the background at each of its steps.
  for (const point of ["save:written", "save:image-recorded", "save:vmm-ended"]) {
    await running();
    const outcome = await crashAt(slot, point, async () => {
      await slot.call("pause");
      await sleep(options.saveAfterMs + 10_000);
    });
    const status = await slot.status();
    const summary = await slot.summary();
    emit({
      kind: "restart-save",
      point,
      outcome,
      phase: status.phase,
      tier: summary?.parked?.tier ?? null,
    });
    await record(point, undefined, outcome);
  }
}

/** The host's pressure stall totals in microseconds (PSI), "some" for CPU, both for I/O. */
function pressure(): { cpu: number; io: number; ioFull: number } {
  const total = (file: string, line: "some" | "full") =>
    Number(
      /total=(\d+)/u.exec(
        readFileSync(file, "utf8")
          .split("\n")
          .find((entry) => entry.startsWith(line)) ?? "",
      )?.[1] ?? 0,
    );
  return {
    cpu: total("/proc/pressure/cpu", "some"),
    io: total("/proc/pressure/io", "some"),
    ioFull: total("/proc/pressure/io", "full"),
  };
}

async function concurrent(slots: Slot[], rounds: number) {
  const live: { cdp: Cdp; workload: Workload }[] = [];
  for (const slot of slots) {
    await slot.ensureStopped();
    await slot.call("start");
    const { cdp } = await firstReply(slot, now());
    live.push({ cdp, workload: await setup(cdp) });
  }
  for (let round = 1; round <= rounds; round += 1) {
    const wakers = slots.slice(0, 3);
    const savers = slots.slice(3, 5);
    for (const [index, slot] of wakers.entries()) {
      await rebase(live[index]!.cdp, live[index]!.workload);
      live[index]!.cdp.close();
      await slot.call("pause");
    }
    for (const slot of wakers) await slot.waitForDisk();
    for (const [offset, slot] of savers.entries()) {
      await rebase(live[3 + offset]!.cdp, live[3 + offset]!.workload);
      live[3 + offset]!.cdp.close();
      await slot.call("pause");
    }
    // Re-check finding 9: the savers' memory events are counted from here, not since their
    // cgroups were made.
    const memoryBefore = await Promise.all(
      savers.map((slot) => helper({ cmd: "memory-events", slotId: slot.id })),
    );
    // The two saves begin at the idle threshold; the three wakes start while they write.
    await sleep(options.saveAfterMs + 300);
    // Item 3 of round 4: where a concurrent wake's time goes. The host's CPU and I/O pressure
    // across the wakes, and the agent's own breakdown of each wake (lane, journal, steps).
    const since = new Date().toISOString().replace("T", " ").slice(0, 19);
    const pressureBefore = pressure();
    const start = now();
    const results = await Promise.all(
      wakers.map(async (slot, index) => {
        const resumed = await slot.call("resume");
        return observe(slot, start, live[index]!.workload, {
          kind: "concurrent-wake",
          round,
          resume_call_ms: resumed.ms,
        });
      }),
    );
    const pressureAfter = pressure();
    const saving = await Promise.all(savers.map((slot) => slot.summary()));
    const agentLines = ((await helper({ cmd: "agent-events", since })).lines as string[])
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.event === "resumed" || event.event === "resume.call");
    emit({
      kind: "concurrent-breakdown",
      round,
      wall_ms: Math.round(now() - start),
      cpu_some_stall_ms: Math.round((pressureAfter.cpu - pressureBefore.cpu) / 1000),
      io_some_stall_ms: Math.round((pressureAfter.io - pressureBefore.io) / 1000),
      io_full_stall_ms: Math.round((pressureAfter.ioFull - pressureBefore.ioFull) / 1000),
      wakers: wakers.map((slot) => ({
        slot: slot.id,
        agent: agentLines.filter((event) => event.slotId === slot.id),
      })),
    });
    for (const [index, { row, cdp }] of results.entries()) {
      emit({ ...row, savers_during: saving.map((summary) => summary?.parked?.tier ?? null) });
      live[index]!.cdp = cdp;
    }
    for (const [offset, slot] of savers.entries()) {
      const writeMs = await slot.waitForDisk();
      const memory = await helper({ cmd: "memory-events", slotId: slot.id });
      const before = memoryBefore[offset] as Record<string, number>;
      emit({
        kind: "concurrent-save",
        round,
        slot: slot.id,
        save_ms: writeMs,
        memory_events_during_save: Object.fromEntries(
          Object.entries(memory as Record<string, number>).map(([key, value]) => [
            key,
            value - (before[key] ?? 0),
          ]),
        ),
      });
      const start2 = now();
      await slot.call("resume");
      const { row, cdp } = await observe(slot, start2, live[3 + offset]!.workload, {
        kind: "after-concurrent-save",
        round,
      });
      emit(row);
      live[3 + offset]!.cdp = cdp;
    }
  }
  for (const entry of live) entry.cdp.close();
}

/** Rule S2 on a host: a journal write fails, the agent ends and is restarted, guests stay alive. */
async function journalFailure(slot: Slot) {
  await slot.ensureStopped();
  await slot.call("start");
  (await firstReply(slot, now())).cdp.close();
  const before = (await helper({ cmd: "vmm-pids", slotId: slot.id })).pids as string[];
  const since = new Date().toISOString().replace("T", " ").slice(0, 19);
  await helper({ cmd: "record-immutable", slotId: slot.id, on: true });
  const failed = await slot.call("pause").then(
    () => "applied",
    (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
  );
  await sleep(2_500);
  await helper({ cmd: "record-immutable", slotId: slot.id, on: false });
  await waitForAgent(slot);
  const after = (await helper({ cmd: "vmm-pids", slotId: slot.id })).pids as string[];
  const events = ((await helper({ cmd: "agent-events", since })).lines as string[]).map(
    (line) => (JSON.parse(line) as { event?: string }).event,
  );
  const { cdp, ms } = await firstReply(slot, now());
  cdp.close();
  const status = await slot.status();
  const paused = await slot.call("pause");
  const resumed = await slot.call("resume");
  emit({
    kind: "journal-failure",
    first_call: failed,
    agent_events: events.filter((event) => event && /journal|fatal|ready|recover/u.test(event)),
    vmm_pids_before: before,
    vmm_pids_after: after,
    guest_kept: before.length > 0 && before.join() === after.join(),
    status_after: status.phase,
    cdp_after_ms: ms,
    pause_then_resume: [paused.result.applied, resumed.result.applied],
    ok:
      failed.startsWith("refused") && before.join() === after.join() && status.phase === "running",
  });
}

/** G4(a) on a host: the host ruleset flushed while guests run opens no path; the agent repairs it. */
async function flush(slots: Slot[]) {
  const [own, other] = slots;
  for (const slot of [own!, other!]) {
    await slot.ensureStopped();
    await slot.call("start");
    (await firstReply(slot, now())).cdp.close();
  }
  const facts = await helper({ cmd: "facts" });
  await helper({ cmd: "nft-flush" });
  const flushedAt = now();
  const tablesAfterFlush = (await helper({ cmd: "nft-tables" })).tables;
  const guestProbes: [string, string, number][] = [
    ["GCE metadata IPv4", "169.254.169.254", 80],
    ["agent Home port via own veth", vethHost(own!.index), 7310],
    ["agent Home port on host address", String(facts.hostAddress), 7310],
    ["another guest's bridge", vethInside(other!.index), 4312],
    ["internet direct", "1.1.1.1", 443],
    // Re-check finding 9: positive controls; each probe method must be able to connect.
    ["control: the slot's proxy", "172.16.0.1", 3128],
  ];
  const proxyProbes: [string, string, number][] = [
    ["control: the egress upstream", "192.0.43.10", 8443],
    ["GCE metadata IPv4", "169.254.169.254", 80],
    ["agent Home port via veth", vethHost(own!.index), 7310],
    ["agent Home port on host address", String(facts.hostAddress), 7310],
    ["host sshd", String(facts.hostAddress), 22],
    ["another slot's bridge", vethInside(other!.index), 4312],
  ];
  const results = await Promise.all([
    ...guestProbes.map(async ([what, host, port]) => {
      const response = await fetch(
        `${own!.bridge}/probe?host=${encodeURIComponent(host)}&port=${port}`,
        {
          signal: AbortSignal.timeout(5000),
        },
      ).then(
        (answer) => answer.json() as Promise<{ result: string }>,
        (error: unknown) => ({ result: `bridge unreachable: ${String(error)}` }),
      );
      return { from: "guest", what, host, port, result: response.result };
    }),
    ...proxyProbes.map(async ([what, host, port]) => {
      const response = await helper({ cmd: "proxy-probe", index: own!.index, host, port });
      return { from: "proxy namespace", what, host, port, result: String(response.result) };
    }),
  ]);
  const probeMs = now() - flushedAt;
  for (const row of results) {
    const expected = row.what.startsWith("control:") ? "connected" : "blocked";
    emit({
      kind: "flush-isolation",
      ...row,
      expected,
      within_ms: Math.round(probeMs),
      ok: expected === "connected" ? row.result === "connected" : row.result !== "connected",
    });
  }
  let repairedMs: number | null = null;
  for (let waited = 0; waited < 20_000; waited += 250) {
    const tables = (await helper({ cmd: "nft-tables" })).tables as string[];
    if (
      tables.includes("table inet opensteer_pool") &&
      tables.includes("table inet opensteer_pool_host")
    ) {
      repairedMs = Math.round(now() - flushedAt);
      break;
    }
    await sleep(250);
  }
  const reload = (await helper({ cmd: "nft-reload" })).tables;
  emit({
    kind: "flush-repair",
    tables_after_flush: tablesAfterFlush,
    repaired_ms: repairedMs,
    tables_after_nftables_restart: reload,
  });
  for (const slot of [own!, other!]) await slot.call("stop");
}

/** G3 on a host: with the saved-state array unmounted the agent refuses to start. */
async function arrayUnmounted(slots: Slot[]) {
  for (const slot of slots) await slot.ensureStopped();
  const since = new Date().toISOString().replace("T", " ").slice(0, 19);
  await helper({ cmd: "agent", actions: ["stop"] });
  await helper({ cmd: "array", mount: false });
  await helper({ cmd: "agent", actions: ["reset-failed", "start"] }).catch(() => undefined);
  await sleep(6_000);
  const state = (await helper({ cmd: "agent-state" }).catch(() => ({ state: "unknown" }))).state;
  const lines = ((await helper({ cmd: "agent-events", since })).lines as string[]).filter((line) =>
    line.includes("agent.failed"),
  );
  await helper({ cmd: "agent", actions: ["stop"] });
  await helper({ cmd: "array", mount: true });
  await helper({ cmd: "agent", actions: ["reset-failed", "start"] });
  await waitForAgent(slots[0]!);
  emit({
    kind: "array-unmounted",
    agent_state_while_unmounted: state,
    refusal: lines.slice(-1)[0] ?? null,
    ok: lines.some((line) => /saved-state array/u.test(line)),
  });
}

/** G6(c) on a host: 400 slots, and how long the agent takes to be ready with them. */
async function scale(existing: Slot[]) {
  await helper({ cmd: "make-profiles", from: existing.length, to: 400 });
  const extra = Array.from(
    { length: 400 - existing.length },
    (_, offset) => new Slot(`bench-${existing.length + offset}`, existing.length + offset),
  );
  const created = now();
  for (const slot of extra) await slot.create();
  const createMs = now() - created;
  const restarts: (number | null)[] = [];
  for (let sample = 0; sample < 3; sample += 1)
    restarts.push((await helper({ cmd: "agent-restart-timed" })).ms as number | null);
  await waitForAgent(existing[0]!);
  // One guest still wakes normally among 400 slots.
  const slot = existing[0]!;
  await slot.ensureStopped();
  // Re-check finding 9: timed from before the start call, as the cold series is.
  const began = now();
  await slot.call("start");
  const reply = await firstReply(slot, began);
  reply.cdp.close();
  await slot.call("stop");
  emit({
    kind: "scale",
    slots: 400,
    create_ms: Math.round(createMs),
    agent_ready_ms: restarts,
    cold_start_among_400_ms: Math.round(reply.ms),
  });
  // Kept for a real host reboot (re-check finding 3) when the run asks for it.
  if (options.phases.includes("keep-400")) return;
  const deleted = now();
  for (const extraSlot of extra) await admin({ op: "delete", slotId: extraSlot.id, term });
  emit({ kind: "scale-cleanup", delete_ms: Math.round(now() - deleted) });
}

/**
 * Re-check finding 7 on a host: a journal that keeps failing. Every call in the window ends the
 * agent (rule S2); systemd keeps starting it, with a growing delay and no start limit, and it is
 * back by itself once the journal takes writes again. The guest runs throughout.
 */
async function journalRepeated(slot: Slot) {
  await slot.ensureStopped();
  await slot.call("start");
  (await firstReply(slot, now())).cdp.close();
  const before = (await helper({ cmd: "vmm-pids", slotId: slot.id })).pids as string[];
  const restartsBefore = (await helper({ cmd: "agent-restarts" })) as { restarts: number };
  await helper({ cmd: "record-immutable", slotId: slot.id, on: true });
  const outcomes: string[] = [];
  const until = now() + 45_000;
  while (now() < until) {
    outcomes.push(
      await slot.call("pause").then(
        () => "applied",
        (error: unknown) => (error instanceof Error ? error.message.slice(0, 60) : "failed"),
      ),
    );
    await sleep(1_500);
  }
  const during = (await helper({ cmd: "agent-restarts" })) as { restarts: number; state: string };
  await helper({ cmd: "record-immutable", slotId: slot.id, on: false });
  const backAt = now();
  await waitForAgent(slot);
  const backMs = now() - backAt;
  const after = (await helper({ cmd: "vmm-pids", slotId: slot.id })).pids as string[];
  const paused = await slot.call("pause");
  const resumed = await slot.call("resume");
  emit({
    kind: "journal-repeated",
    calls: outcomes.length,
    applied: outcomes.filter((outcome) => outcome === "applied").length,
    restarts_in_window: during.restarts - restartsBefore.restarts,
    unit_state_in_window: during.state,
    back_after_ms: Math.round(backMs),
    guest_kept: before.length > 0 && before.join() === after.join(),
    pause_then_resume: [paused.result.applied, resumed.result.applied],
    ok:
      during.state !== "failed" &&
      before.join() === after.join() &&
      paused.result.applied &&
      resumed.result.applied,
  });
}

/** Re-check finding 6 on a host: what the kernel answered when kvm-pit was moved. */
async function kvmPit() {
  const answer = (await helper({ cmd: "kvm-pit" })) as Record<string, unknown>;
  emit({ kind: "kvm-pit", ...answer });
}

/** Re-check finding 3 on a host: after a real reboot, with 400 slots, the agent's start. */
async function afterReboot(slots: Slot[]) {
  const boot = (await helper({ cmd: "boot-agent-ready" })) as Record<string, unknown>;
  const slot = slots[0]!;
  await slot.ensureStopped();
  const began = now();
  await slot.call("start");
  const reply = await firstReply(slot, began);
  reply.cdp.close();
  await slot.call("stop");
  emit({ kind: "after-reboot", ...boot, first_cold_start_ms: Math.round(reply.ms) });
}

async function main() {
  // A rerun starts clean: the previous run's slots are deleted (their guests ended, state erased).
  const listed = await admin({ op: "list" });
  if (listed.op === "list")
    for (const slot of listed.slots)
      if (slot.slotId.startsWith("bench-"))
        await admin({ op: "delete", slotId: slot.slotId, term: slot.term });
  const slots = [0, 1, 2, 3, 4].map((index) => new Slot(`bench-${index}`, index));
  for (const slot of slots) await slot.create();
  const [first] = slots;
  let live: { cdp: Cdp; workload: Workload } | undefined;
  if (options.phases.includes("cold")) live = await coldStarts(first!);
  if (!live) {
    await first!.ensureStopped();
    await first!.call("start");
    const { cdp } = await firstReply(first!, now());
    live = { cdp, workload: await setup(cdp) };
  }
  const stopSampling = proxySampler(first!);
  if (options.phases.includes("memory")) await wakes(first!, live, "memory", options.samples);
  if (options.phases.includes("disk-warm")) await wakes(first!, live, "disk-warm", options.samples);
  if (options.phases.includes("disk-cold")) await wakes(first!, live, "disk-cold", options.samples);
  if (options.phases.includes("clock")) await clock(first!, live);
  if (options.phases.includes("isolation")) {
    await slots[1]!.ensureStopped();
    await slots[1]!.call("start");
    (await firstReply(slots[1]!, now())).cdp.close();
    await isolation(slots);
    await slots[1]!.call("stop");
  }
  if (options.phases.includes("restart")) await restarts(first!, live);
  if (options.phases.includes("concurrent")) await concurrent(slots, 3);
  if (options.phases.includes("journal")) await journalFailure(slots[0]!);
  if (options.phases.includes("flush")) await flush(slots);
  if (options.phases.includes("array")) await arrayUnmounted(slots);
  if (options.phases.includes("scale")) await scale(slots);
  if (options.phases.includes("journal-repeat")) await journalRepeated(slots[0]!);
  if (options.phases.includes("kvm-pit")) await kvmPit();
  if (options.phases.includes("after-reboot")) await afterReboot(slots);
  stopSampling();
  if (options.phases.includes("crash-loop")) await crashLoop(slots[2]!);
  if (options.phases.includes("flood")) await floodNeighbour(slots[0]!, slots[1]!, 5);
  // Round F: E1, E2 and E4 on the host, after every series (their wrappers stay off the series).
  if (options.phases.includes("e1")) await oldKeyDuringReplacement();
  if (options.phases.includes("e2")) await slowRevive();
  if (options.phases.includes("capacity")) await capacity(slots);
  // Round H: the agent-made profile, mkfs.ext4's time, and egress pulled (last: it switches
  // the agent to requireEgressUpstream).
  if (options.phases.includes("profile")) await agentMadeProfile();
  if (options.phases.includes("mkfs-time")) await mkfsTimes();
  if (options.phases.includes("egress-pull")) await pulledEgress(slots);
  assertAll();
  emit({ kind: "done" });
}

main().catch((error: unknown) => {
  emit({ kind: "failed", message: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
