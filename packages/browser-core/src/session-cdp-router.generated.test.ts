/**
 * Generated sequences against the real router and a fake browser: after every step, for every
 * connection state, (1) nothing foreign reaches it and (2) nothing of its own is lost or doubled;
 * and a state that is not a connection's still hears every event about its session's targets.
 *
 * The world: two Browser Sessions, each with a root tab; a person's tab in the first; popups and
 * iframes opened from web and from extension pages; extension service workers and offscreen
 * documents; navigations web -> extension -> web; attaches by a connected standard client, a
 * connected script (opened before or after targets exist) and one of your own agents; auto-attached
 * iframes; crashes, destroys and detaches in either order relative to replies and to each other;
 * browser-level events naming a target by frame. Only leaf targets are destroyed during a run
 * (a browser closes an iframe with its page); everything is destroyed, leaves first, at the end.
 *
 * Exceptions by design (each counted below, never silently):
 * - E1: a target an extension page is shown in at its end is hidden from a connection, so its own
 *   terminal events are dropped (the router's hidden-target rule, kept as at fe6fc0d73).
 * - E2: a script attachment ends with its root's `Target.targetDestroyed`; its channels' detaches
 *   after that are not sent (the attachment itself has ended).
 * - E3: a child session whose parent session the client detached itself ends with that parent.
 */
import { describe, expect, it } from "vitest";
import {
  SessionCdpRouter,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpCommand,
  type CdpEvent,
  type CdpParameters,
} from "./session-cdp-router.js";

const extensionUrl = (n: number) => `chrome-extension://${"e".repeat(32)}/page-${n}.html`;
const webUrl = (n: number) => `https://site-${n}.test/`;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Listener = (method: string, parameters: CdpParameters) => void;

class Channel implements CdpChannel {
  readonly listeners = new Set<Listener>();
  readonly targetId: string;
  constructor(targetId: string) {
    this.targetId = targetId;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async send(method: string): Promise<unknown> {
    if (method === "Runtime.enable")
      this.emit("Runtime.executionContextCreated", {
        context: {
          auxData: { frameId: "main", isDefault: true, type: "default" },
          id: 1,
          name: "",
          origin: "https://web.test",
          uniqueId: `world-${this.targetId}`,
        },
      });
    return {};
  }
  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

interface Target {
  readonly id: string;
  readonly type: "page" | "iframe" | "service_worker" | "other";
  url: string;
  readonly opener?: string;
  readonly parent?: string;
  /** The Browser Session it belongs to, or none (an extension's own targets). */
  readonly home: "A" | "B" | null;
  /** The Browser Session the router claims it for now, or none. */
  session: "A" | "B" | null;
  /** The session root it descends from (the reach of that root's lineage and script), if any. */
  readonly root: string | null;
  alive: boolean;
}

class Backend implements BrowserCdpBackend {
  readonly listeners = new Set<Listener>();
  readonly targets = new Map<string, Target>();
  info(target: Target): CdpParameters {
    return {
      targetId: target.id,
      type: target.type,
      url: target.url,
      title: "",
      attached: false,
      ...(target.opener ? { openerId: target.opener, canAccessOpener: true } : {}),
      ...(target.parent ? { parentId: target.parent, parentFrameId: target.parent } : {}),
    };
  }
  attach(targetId: string): Promise<CdpChannel> {
    const target = this.targets.get(targetId);
    if (!target?.alive) return Promise.reject(new Error("No such target."));
    return Promise.resolve(new Channel(targetId));
  }
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (method === "Target.getTargets")
      return Promise.resolve({
        targetInfos: [...this.targets.values()].filter((t) => t.alive).map((t) => this.info(t)),
      });
    if (method === "Target.getTargetInfo") {
      const target = this.targets.get(String(parameters?.targetId));
      return Promise.resolve(target?.alive ? { targetInfo: this.info(target) } : {});
    }
    return Promise.resolve({});
  }
  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

interface OwnSession {
  readonly id: string;
  readonly target: string;
  readonly parent?: string;
  /** Set when the session's end is expected to be told: why it ended, and whether by E1-E3. */
  ended?: { readonly exempt: string | false };
  channel?: Channel;
  /** A child's session id at the page, which the fake uses when it detaches it. */
  physical?: string;
  autoAttach?: boolean;
}

interface Client {
  readonly name: string;
  readonly session: "A" | "B";
  readonly kind: "standard" | "script" | "own";
  /** The root its reach starts from. */
  readonly root: string;
  readonly connection: boolean;
  readonly events: CdpEvent[];
  readonly replies: unknown[];
  /** Everything it received, events and replies, in order. */
  readonly log: unknown[];
  readonly sessions: Map<string, OwnSession>;
  open: boolean;
  /** The step the script's root was destroyed at: later channel ends are E2. */
  rootDestroyed?: boolean;
  /** Terminal events of its own it must hear: key -> count. */
  readonly expected: Map<string, number>;
  /** Terminal events an exception (E1-E3) allows it to hear at most once. */
  readonly optional: Set<string>;
  checked: number;
  send(command: CdpCommand): Promise<unknown>;
}

interface Failure {
  readonly step: number;
  readonly message: string;
}

const budget = { maxBytes: 256_000, maxDepth: 32, maxEntries: 4_096 };

async function run(seed: number, maxSteps: number): Promise<Failure | undefined> {
  const random = prng(seed);
  const trace: string[] = [];
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const backend = new Backend();
  const router = new SessionCdpRouter(backend);
  let serial = 0;
  const add = (target: Omit<Target, "alive" | "home">) => {
    const created: Target = { ...target, home: target.session, alive: true };
    backend.targets.set(created.id, created);
    return created;
  };
  add({ id: "tgt-a-root", type: "page", url: webUrl(0), session: "A", root: "tgt-a-root" });
  add({ id: "tgt-b-root", type: "page", url: webUrl(1), session: "B", root: "tgt-b-root" });
  add({ id: "tgt-a-person", type: "page", url: webUrl(2), session: "A", root: null });
  router.registerSession("A", "tgt-a-root", async () => true, "/files/a");
  router.registerSession("B", "tgt-b-root", async () => true, "/files/b");
  router.claimTarget("A", "tgt-a-person");

  const clients: Client[] = [];
  const client = (
    name: string,
    session: "A" | "B",
    root: string,
    kind: Client["kind"],
    connection: boolean,
    send: (command: CdpCommand) => Promise<unknown>,
  ): Client => {
    const created: Client = {
      name,
      session,
      root,
      kind,
      connection,
      events: [],
      replies: [],
      log: [],
      sessions: new Map(),
      open: true,
      expected: new Map(),
      optional: new Set(),
      checked: 0,
      send: (command) => {
        trace.push(`${name} ${command.method} ${JSON.stringify(command.parameters ?? {})}`);
        return send(command).then(
          (value) => {
            trace.push(`${name} <- ${JSON.stringify(value)}`);
            return value;
          },
          (error: unknown) => {
            trace.push(`${name} <- error ${String((error as Error).message)}`);
            throw error;
          },
        );
      },
    };
    clients.push(created);
    return created;
  };
  const reply = (c: Client, value: unknown) => {
    c.replies.push(value);
    c.log.push(value);
  };
  const standard = (session: "A" | "B", seedTarget: string) => {
    const attachment = router.openStandardClient(session, {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: `lineage-${session}`, seedTargetId: seedTarget },
    });
    const created = client(
      `standard-${session}`,
      session,
      seedTarget,
      "standard",
      true,
      (command) => attachment.send(command),
    );
    attachment.onEvent((event) => {
      created.events.push(event);
      created.log.push(event);
    });
    return created;
  };
  const standardA = standard("A", "tgt-a-root");
  const standardB = standard("B", "tgt-b-root");
  const own = client("own-A", "A", "tgt-a-root", "own", false, (command) =>
    router.send("A", command),
  );
  router.onEvent("A", (event) => {
    own.events.push(event);
    own.log.push(event);
  });
  let script: Client | undefined;
  const openScript = () => {
    const created = client("script-A", "A", "tgt-a-root", "script", true, (command) =>
      router.send("A", { ...command, scriptAttachmentId: "script" }),
    );
    router.openScriptAttachment(
      "A",
      "script",
      "tgt-a-root",
      budget,
      (e) => {
        created.events.push(e);
        created.log.push(e);
      },
      {
        connection: true,
      },
    );
    script = created;
  };
  for (const discovering of [standardA, standardB])
    reply(
      discovering,
      await discovering.send({
        method: "Target.setDiscoverTargets",
        parameters: { discover: true },
      }),
    );
  if (random() < 0.5) openScript();

  // What the non-connection state must hear: every event about a target its session claimed.
  const ownExpected: string[] = [];
  const claimedByA = (target: Target | undefined) => target?.session === "A";
  const isExtension = (target: Target) => target.url.startsWith("chrome-extension:");
  const emit = (method: string, parameters: CdpParameters, subject?: Target) => {
    trace.push(`browser ${method} ${JSON.stringify(parameters)}`);
    if (claimedByA(subject)) ownExpected.push(JSON.stringify({ method, parameters }));
    backend.emit(method, parameters);
  };
  const descendants = (id: string) =>
    [...backend.targets.values()].filter((t) => t.alive && (t.opener === id || t.parent === id));
  const owners = (target: string) =>
    clients.flatMap((c) =>
      [...c.sessions.values()]
        .filter((s) => s.target === target && !s.ended)
        .map((s) => ({ client: c, session: s })),
    );
  const bump = (c: Client, key: string, exempt: string | false = false) => {
    if (exempt) c.optional.add(key);
    else c.expected.set(key, (c.expected.get(key) ?? 0) + 1);
  };

  // The router releases an auto-attached child's claim when its last channel ends (as at
  // fe6fc0d73): from then on no session hears of that target or what it opened.
  const releaseIfUnattached = (s: OwnSession) => {
    if (!s.parent || owners(s.target).some(({ session }) => session.parent)) return;
    const release = (id: string) => {
      const target = backend.targets.get(id)!;
      if (!target.session) return;
      target.session = null;
      // Every other session on a released target ends with it, and is told so.
      for (const { client: c, session } of owners(id)) {
        if (!c.connection || !c.open) continue;
        const exempt = (isExtension(target) && "E1") || (c.rootDestroyed && "E2") || false;
        bump(c, `detach:${session.id}`, exempt);
        endSession(c, session, exempt);
      }
      for (const child of descendants(id)) release(child.id);
    };
    release(s.target);
  };
  const endSession = (c: Client, s: OwnSession, exempt: string | false) => {
    if (s.ended) return;
    s.ended = { exempt };
    releaseIfUnattached(s);
    for (const child of c.sessions.values())
      if (child.parent === s.id && !child.ended) {
        child.ended = { exempt: exempt || "E3" };
        c.optional.add(`detach:${child.id}`);
        releaseIfUnattached(child);
      }
  };
  const crashes = new Map<string, number>();
  const crash = (target: Target) => {
    crashes.set(target.id, (crashes.get(target.id) ?? 0) + 1);
    for (const c of clients) {
      if (!c.connection || !c.open) continue;
      const ownTarget =
        (c.kind === "script" && target.id === "tgt-a-root" && !c.rootDestroyed) ||
        owners(target.id).some(({ client: o }) => o === c);
      if (ownTarget) bump(c, `crash:${target.id}`, isExtension(target) && "E1");
    }
    emit("Target.targetCrashed", { targetId: target.id, status: "crashed", errorCode: 1 }, target);
  };
  const destroy = (target: Target) => {
    const childSessions = owners(target.id).filter(({ session }) => session.parent);
    const pageDetachFirst = random() < 0.5;
    const pageDetach = () => {
      for (const { session } of childSessions) {
        const parent = clients
          .flatMap((c) => [...c.sessions.values()])
          .find((p) => p.id === session.parent);
        trace.push(`page ${String(session.parent)} detachedFromTarget ${String(session.physical)}`);
        parent?.channel?.emit("Target.detachedFromTarget", {
          sessionId: session.physical,
          targetId: target.id,
        });
      }
    };
    for (const c of clients) {
      if (!c.connection || !c.open) continue;
      const hidden = isExtension(target) && "E1";
      if (c.kind === "script" && target.id === "tgt-a-root" && !c.rootDestroyed) {
        bump(c, `destroy:${target.id}`, hidden);
        c.rootDestroyed = true;
      }
      let told = false;
      for (const { client: o, session } of owners(target.id)) {
        if (o !== c) continue;
        const exempt = hidden || (c.rootDestroyed && "E2") || false;
        bump(c, `detach:${session.id}`, exempt);
        if (!told && target.id !== "tgt-a-root") bump(c, `destroy:${target.id}`, exempt);
        told = true;
        endSession(c, session, exempt);
      }
    }
    if (pageDetachFirst) pageDetach();
    target.alive = false;
    emit("Target.targetDestroyed", { targetId: target.id }, target);
    if (!pageDetachFirst) pageDetach();
  };
  const leaves = () =>
    [...backend.targets.values()].filter(
      (t) =>
        t.alive && !t.id.endsWith("-root") && t.id !== "tgt-a-person" && !descendants(t.id).length,
    );
  const pages = () =>
    [...backend.targets.values()].filter((t) => t.alive && t.type === "page" && t.session);

  const recordOwn = (c: Client, reply: unknown, target: string) => {
    const sessionId = (reply as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId === "string") {
      const channel = lastChannel(target);
      c.sessions.set(sessionId, { id: sessionId, target, ...(channel ? { channel } : {}) });
    }
  };
  // The newest channel the backend opened on a target (attaches run one at a time).
  const channels = new Map<string, Channel>();
  const attach = backend.attach.bind(backend);
  backend.attach = async (targetId: string) => {
    const channel = (await attach(targetId)) as Channel;
    channels.set(targetId, channel);
    return channel;
  };
  const lastChannel = (target: string) => channels.get(target);

  const steps: (() => Promise<void> | void)[] = [
    // A popup or an iframe, opened from a web or an extension page, at a web or extension address.
    () => {
      const from = pick(pages());
      if (!from) return;
      const type = random() < 0.6 ? "page" : "iframe";
      const url = random() < 0.35 ? extensionUrl(++serial) : webUrl(++serial);
      const target = add({
        id: `tgt-${serial}`,
        type,
        url,
        ...(type === "page" ? { opener: from.id } : { parent: from.id }),
        session: from.session,
        root: from.root,
      });
      emit("Target.targetCreated", { targetInfo: backend.info(target) }, target);
    },
    // An extension's own service worker or offscreen document: no session claims it.
    () => {
      const target = add({
        id: `tgt-${++serial}`,
        type: random() < 0.5 ? "service_worker" : "other",
        url: extensionUrl(serial),
        session: null,
        root: null,
      });
      emit("Target.targetCreated", { targetInfo: backend.info(target) }, target);
    },
    // A navigation, web -> extension -> web.
    () => {
      const target = pick(pages());
      if (!target) return;
      target.url =
        isExtension(target) || random() < 0.5 ? webUrl(++serial) : extensionUrl(++serial);
      emit("Target.targetInfoChanged", { targetInfo: backend.info(target) }, target);
    },
    () => {
      const target = pick([...backend.targets.values()].filter((t) => t.alive && t.session));
      if (target) crash(target);
    },
    () => {
      const target = pick(leaves());
      if (target) destroy(target);
    },
    // A browser-level event naming a target by frame, with its address.
    () => {
      const target = pick([...backend.targets.values()].filter((t) => t.alive && t.session));
      if (!target) return;
      emit(
        "Browser.downloadWillBegin",
        { frameId: target.id, guid: `g-${++serial}`, url: target.url, suggestedFilename: "f.txt" },
        target,
      );
    },
    // An attach by any client, sometimes raced by its target's end before the reply.
    async () => {
      const c = pick(clients.filter((x) => x.open));
      const target = pick([...backend.targets.values()].filter((t) => t.session === c?.session));
      if (!c || !target) return;
      const sending = c
        .send({
          method: "Target.attachToTarget",
          parameters: { targetId: target.id, flatten: true },
        })
        .then(
          (reply) => ({ reply }),
          (error: unknown) => ({ error: String((error as Error).message) }),
        );
      const race = random() < 0.25 && target.alive && leaves().includes(target);
      if (race) {
        if (random() < 0.5) crash(target);
        else destroy(target);
      }
      const settled = await sending;
      reply(c, settled);
      if ("reply" in settled) {
        recordOwn(c, settled.reply, target.id);
        const own_ = c.sessions.get(String((settled.reply as { sessionId?: string }).sessionId));
        // Attached to a target that had already ended: its end must still be told once.
        if (own_ && !target.alive && c.connection && !own_.ended) {
          const exempt = (isExtension(target) && "E1") || (c.rootDestroyed && "E2") || false;
          bump(c, `detach:${own_.id}`, exempt);
          endSession(c, own_, exempt);
        }
      }
    },
    async () => {
      const c = pick(clients.filter((x) => x.open));
      if (!c) return;
      reply(
        c,
        await c.send({ method: "Target.getTargets" }).catch((error: unknown) => ({
          error: String((error as Error).message),
        })),
      );
    },
    // An auto-attached iframe on a standard client's page session.
    async () => {
      const c = pick([standardA, standardB]);
      const parent = pick([...c.sessions.values()].filter((s) => !s.ended && !s.parent));
      const child = parent && pick(descendants(parent.target).filter((t) => t.type === "iframe"));
      if (!parent || !child || !parent.channel) return;
      if (!parent.autoAttach) {
        parent.autoAttach = true;
        reply(
          c,
          await c
            .send({
              method: "Target.setAutoAttach",
              sessionId: parent.id,
              parameters: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            })
            .catch((error: unknown) => ({ error: String((error as Error).message) })),
        );
      }
      const before = c.events.length;
      const physical = `phys-pending-${++serial}`;
      trace.push(`page ${parent.id} attachedToTarget ${child.id} as ${physical}`);
      parent.channel.emit("Target.attachedToTarget", {
        sessionId: physical,
        targetInfo: backend.info(child),
        waitingForDebugger: false,
      });
      const announced = c.events
        .slice(before)
        .find(
          (event) =>
            event.method === "Target.attachedToTarget" &&
            event.sessionId === parent.id &&
            (event.parameters.targetInfo as { targetId?: unknown } | undefined)?.targetId ===
              child.id,
        );
      const sessionId = announced?.parameters.sessionId;
      if (typeof sessionId === "string")
        c.sessions.set(sessionId, {
          id: sessionId,
          target: child.id,
          parent: parent.id,
          physical,
        });
    },
    // A client detaches one of its own page sessions itself.
    async () => {
      const c = pick(clients.filter((x) => x.open && x.connection));
      const s = c && pick([...c.sessions.values()].filter((x) => !x.ended && !x.parent));
      if (!c || !s) return;
      const target = backend.targets.get(s.target)!;
      const exempt = (isExtension(target) && "E1") || (c.rootDestroyed && "E2") || false;
      bump(c, `detach:${s.id}`, exempt);
      endSession(c, s, exempt);
      reply(
        c,
        await c
          .send({ method: "Target.detachFromTarget", parameters: { sessionId: s.id } })
          .catch((error: unknown) => ({ error: String((error as Error).message) })),
      );
    },
    () => {
      if (!script) openScript();
    },
  ];

  const check = (step: number): Failure | undefined => {
    const allSessions = new Map<string, Client>();
    for (const c of clients) for (const id of c.sessions.keys()) allSessions.set(id, c);
    for (const c of clients) {
      if (!c.connection) continue;
      const fresh = JSON.stringify(c.log.slice(c.checked));
      c.checked = c.log.length;
      if (fresh.includes("chrome-extension:"))
        return { step, message: `${c.name} was given an extension's address: ${fresh}` };
      const known = new Set<string>([
        ...(c.kind === "script" ? ["tgt-a-root"] : []),
        ...[...c.sessions.values()].map((s) => s.target),
      ]);
      for (const target of backend.targets.values()) {
        const foreign =
          target.home !== c.session ||
          (c.kind !== "own" && target.root !== c.root) ||
          (isExtension(target) && !known.has(target.id));
        if (foreign && fresh.includes(`"${target.id}"`))
          return { step, message: `${c.name} was told of ${target.id}: ${fresh}` };
      }
      for (const [id, holder] of allSessions)
        if (holder !== c && fresh.includes(`"${id}"`))
          return { step, message: `${c.name} was told of ${holder.name}'s session ${id}` };
    }
    return undefined;
  };

  try {
    const setup = check(-1);
    if (setup) return setup;
    for (let step = 0; step < maxSteps; step += 1) {
      await pick(steps)();
      await Promise.resolve();
      const failure = check(step);
      if (failure) return { ...failure, message: `${failure.message}\n${trace.join("\n")}` };
    }
    // The end: everything is destroyed, leaves first, then the person's tab and the roots.
    for (let left = leaves(); left.length; left = leaves()) destroy(left[0]!);
    for (const id of ["tgt-a-person", "tgt-a-root", "tgt-b-root"])
      destroy(backend.targets.get(id)!);
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    const failure = check(maxSteps);
    if (failure) return { ...failure, message: `${failure.message}\n${trace.join("\n")}` };
    const fail = (message: string): Failure => ({
      step: maxSteps,
      message: `${message}\n${trace.join("\n")}`,
    });
    for (const c of clients) {
      if (!c.connection) continue;
      const counted = new Map<string, number>();
      for (const event of c.events) {
        const p = event.parameters as { targetId?: unknown; sessionId?: unknown };
        const key =
          event.method === "Target.targetCrashed"
            ? `crash:${String(p.targetId)}`
            : event.method === "Target.targetDestroyed"
              ? `destroy:${String(p.targetId)}`
              : event.method === "Target.detachedFromTarget"
                ? `detach:${String(p.sessionId)}`
                : undefined;
        if (key) counted.set(key, (counted.get(key) ?? 0) + 1);
      }
      // Its own: a session's detach exactly once; a destroy or crash of its own target at least
      // as often as it happened while its own. None doubled: a target's destroy at most once, its
      // crashes at most as often as they happened.
      for (const [key, count] of c.expected) {
        const received = counted.get(key) ?? 0;
        const exact = key.startsWith("detach:");
        if (
          exact
            ? received !== count && !(c.optional.has(key) && received === count + 1)
            : received < count
        )
          return fail(`${c.name} expected ${count} of ${key}, received ${received}`);
      }
      for (const [key, count] of counted) {
        const limit = key.startsWith("crash:")
          ? (crashes.get(key.slice("crash:".length)) ?? 0)
          : key.startsWith("detach:") && !c.expected.has(key)
            ? Number(c.optional.has(key))
            : 1;
        if (count > limit) return fail(`${c.name} received ${key} ${count} times`);
      }
    }
    // Nothing was taken from the non-connection state: every event about its session's targets.
    const heard = own.events.map(({ method, parameters }) =>
      JSON.stringify({ method, parameters }),
    );
    for (const expected of ownExpected) {
      const at = heard.indexOf(expected);
      if (at < 0) return fail(`own-A did not hear ${expected}`);
      heard.splice(at, 1);
    }
    return undefined;
  } finally {
    await router.close();
  }
}

/** The shortest prefix of a failing seed's steps that still fails. */
async function shortest(seed: number, steps: number): Promise<string> {
  for (let prefix = 1; prefix <= steps; prefix += 1) {
    const failure = await run(seed, prefix);
    if (failure) return `seed ${seed}, first ${prefix} steps: ${failure.message}`;
  }
  return `seed ${seed}: ${steps} steps`;
}

describe("SessionCdpRouter: generated sequences keep a connection's two invariants", () => {
  it("holds for a fixed set of seeds", async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 500; seed += 1) {
      const failure = await run(seed, 60);
      if (failure) failures.push(await shortest(seed, 60));
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });
});
