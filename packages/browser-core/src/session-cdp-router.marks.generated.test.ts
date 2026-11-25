/**
 * Generated sequences for the agent mark (M1, M2): every way an agent comes to hold a page (its
 * creation through a session's root, a script or a client; a popup of a page it holds; an attach;
 * the runtime's hold through an agent's first load) against every way that holder ends (a
 * detach, a client's or a script's close, the first load settling). After every step the pages
 * the browser is told are agent-controlled are exactly the pages some live holder holds: no page an
 * agent drives is unmarked, and no page stays marked once nothing holds it. At the end every
 * holder has ended, and no page is marked: the person's own navigation to the Home goes through.
 */
import { describe, expect, it } from "vitest";
import {
  SessionCdpRouter,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpCommand,
  type CdpParameters,
} from "./session-cdp-router.js";

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
  close(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async send(): Promise<unknown> {
    return {};
  }
}

class Backend implements BrowserCdpBackend {
  dedicatedContext = true;
  readonly listeners = new Set<Listener>();
  readonly marked = new Set<string>();
  readonly infos = new Map<string, Record<string, unknown>>();
  /** First loads of created pages, and the release each settles with. */
  readonly loads: { targetId: string; settle: () => void }[] = [];
  next = 1;
  setAgentControlled(targetId: string, controlled: boolean): void {
    if (controlled) this.marked.add(targetId);
    else this.marked.delete(targetId);
  }
  add(targetId: string, openerId?: string): Record<string, unknown> {
    const info = {
      targetId,
      type: "page",
      url: "https://site.test/",
      attached: false,
      ...(openerId ? { openerId } : {}),
    };
    this.infos.set(targetId, info);
    return info;
  }
  async createAgentTarget(
    _parameters: CdpParameters,
    hold: (targetId: string) => () => void,
  ): Promise<{ readonly targetId: string }> {
    const targetId = `created-${this.next++}`;
    this.add(targetId);
    const release = hold(targetId);
    this.loads.push({ targetId, settle: release });
    return { targetId };
  }
  attach(targetId: string): Promise<CdpChannel> {
    if (!this.infos.has(targetId)) return Promise.reject(new Error("No such target."));
    return Promise.resolve(new Channel());
  }
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (method === "Target.getTargets")
      return Promise.resolve({ targetInfos: [...this.infos.values()] });
    if (method === "Target.getTargetInfo")
      return Promise.resolve({ targetInfo: this.infos.get(String(parameters?.targetId)) });
    // A router that does not take the hold at creation creates a page this way.
    if (method === "Target.createTarget") {
      const targetId = `created-${this.next++}`;
      this.add(targetId);
      this.loads.push({ targetId, settle: () => undefined });
      return Promise.resolve({ targetId });
    }
    return Promise.resolve({});
  }
  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

/** A holder: what an agent holds pages with, and the pages it holds now. */
interface Holder {
  readonly name: string;
  readonly kind: "root-channel" | "script" | "client" | "lineage" | "first-load";
  readonly pages: Set<string>;
  /** For a channel: the page it is on (a popup of it, or of what it holds, is its too). */
  readonly target?: string;
  send?: (command: CdpCommand) => Promise<unknown>;
  end: () => Promise<void> | void;
}

async function run(seed: number, steps: number): Promise<string | undefined> {
  const random = prng(seed);
  const pick = <T>(values: readonly T[]): T | undefined =>
    values[Math.floor(random() * values.length)];
  const backend = new Backend();
  const router = new SessionCdpRouter(backend);
  backend.add("root");
  router.registerSession("s", "root", async () => true, "/files/s");
  const trace: string[] = [];
  const holders: Holder[] = [];
  const openerOf = new Map<string, string>();
  /** The lineage that adopted a page first, which it stays with. */
  const creatorOf = new Map<string, string>();
  let serial = 0;
  const live = () => [...backend.infos.keys()];
  const expected = () => new Set(holders.flatMap((holder) => [...holder.pages]));
  const check = (step: string): string | undefined => {
    const want = [...expected()].sort();
    const have = [...backend.marked].sort();
    if (JSON.stringify(want) !== JSON.stringify(have))
      return `${step}: marked ${JSON.stringify(have)}, held ${JSON.stringify(want)}\n${trace.join("\n")}`;
    return undefined;
  };
  const drop = (holder: Holder) => holders.splice(holders.indexOf(holder), 1);
  const actions: (() => Promise<void>)[] = [
    // An agent creates a page through the session's root: held through its first load only.
    async () => {
      const reply = (await router.send("s", {
        method: "Target.createTarget",
        parameters: { url: "https://site.test/new" },
      })) as { targetId: string };
      trace.push(`root creates ${reply.targetId}`);
      const load = backend.loads.find((entry) => entry.targetId === reply.targetId)!;
      const holder: Holder = {
        name: `load:${reply.targetId}`,
        kind: "first-load",
        pages: new Set([reply.targetId]),
        end: () => {
          load.settle();
          drop(holder);
        },
      };
      holders.push(holder);
    },
    // That first load settles.
    async () => {
      const holder = pick(holders.filter((entry) => entry.kind === "first-load"));
      if (!holder) return;
      trace.push(`settle ${holder.name}`);
      await holder.end();
    },
    // An agent's channel on the root: attach, which holds its page until it detaches.
    async () => {
      const target = pick(live());
      if (!target) return;
      const { sessionId } = (await router.send("s", {
        method: "Target.attachToTarget",
        parameters: { targetId: target, flatten: true },
      })) as { sessionId: string };
      trace.push(`root attaches ${target} as ${sessionId}`);
      const holder: Holder = {
        name: `channel:${sessionId}`,
        kind: "root-channel",
        target,
        pages: new Set([target]),
        end: async () => {
          await router.send("s", {
            method: "Target.detachFromTarget",
            parameters: { sessionId },
          });
          drop(holder);
        },
      };
      holders.push(holder);
    },
    // A script on a page, or a client (outside a lineage, or a connection's lineage).
    async () => {
      const kind = pick(["script", "client", "lineage"] as const)!;
      const target = pick(live());
      if (!target) return;
      const name = `${kind}-${++serial}`;
      if (kind === "script") {
        router.openScriptAttachment(
          "s",
          name,
          target,
          { maxBytes: 65_536, maxDepth: 16, maxEntries: 256 },
          () => {},
          { connection: random() < 0.5 },
        );
        const holder: Holder = {
          name,
          kind,
          target,
          pages: new Set([target]),
          send: (command) => router.send("s", { ...command, scriptAttachmentId: name }),
          end: async () => {
            await router.closeScriptAttachment("s", name, Promise.resolve());
            drop(holder);
          },
        };
        holders.push(holder);
      } else {
        const client = router.openStandardClient("s", {
          wholeContext: false,
          ...(kind === "lineage"
            ? {
                connection: true,
                lineage: {
                  attachmentId: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
                  seedTargetId: target,
                },
              }
            : {}),
        });
        const holder: Holder = {
          name,
          kind,
          pages: new Set(kind === "lineage" ? [target] : []),
          send: (command) => client.send(command),
          end: () => {
            client.close();
            drop(holder);
          },
        };
        holders.push(holder);
      }
      trace.push(`${name} opens on ${target}`);
    },
    // A script or a client creates a page: theirs from its creation until they end.
    async () => {
      const holder = pick(holders.filter((entry) => entry.send));
      if (!holder) return;
      const reply = (await holder.send!({
        method: "Target.createTarget",
        parameters: { url: "https://site.test/theirs" },
      }).catch(() => undefined)) as { targetId?: string } | undefined;
      if (!reply?.targetId) return;
      trace.push(`${holder.name} creates ${reply.targetId}`);
      holder.pages.add(reply.targetId);
      if (holder.kind === "lineage") creatorOf.set(reply.targetId, holder.name);
      // A script's new page is claimed under its root page: in a lineage's reach as a popup is.
      if (holder.kind === "script" && holder.target) openerOf.set(reply.targetId, holder.target);
      // Its first load ends without ending this holder's hold.
      backend.loads.find((entry) => entry.targetId === reply.targetId)?.settle();
    },
    // A page opens a popup: whoever holds the opener holds the popup from its creation; a popup of
    // a page nobody holds is the person's.
    async () => {
      const opener = pick(live());
      if (!opener) return;
      const popup = `popup-${++serial}`;
      trace.push(`${opener} opens ${popup}`);
      // A lineage reaches down its pages' popups, those opened before it began included, but not
      // into a page another lineage adopted first (that page's creator is the other lineage).
      const reaches = (holder: Holder, id: string | undefined): boolean => {
        if (id === undefined) return false;
        if (holder.pages.has(id)) return true;
        const creator = creatorOf.get(id);
        if (creator !== undefined && creator !== holder.name) return false;
        return reaches(holder, openerOf.get(id));
      };
      for (const holder of holders) {
        if (holder.kind === "first-load") continue;
        const held = holder.kind === "lineage" ? reaches(holder, opener) : holder.pages.has(opener);
        if (!held) continue;
        holder.pages.add(popup);
        if (holder.kind === "lineage" && !creatorOf.has(popup)) creatorOf.set(popup, holder.name);
      }
      openerOf.set(popup, opener);
      backend.emit("Target.targetCreated", { targetInfo: backend.add(popup, opener) });
    },
    // The runtime holds a page an agent opens through its first load.
    async () => {
      const target = pick(live());
      if (!target) return;
      const release = router.holdAgentPage(target);
      trace.push(`open holds ${target}`);
      const holder: Holder = {
        name: `open:${target}:${++serial}`,
        kind: "first-load",
        pages: new Set([target]),
        end: () => {
          release();
          drop(holder);
        },
      };
      holders.push(holder);
    },
    // A holder ends.
    async () => {
      const holder = pick(holders);
      if (!holder) return;
      trace.push(`end ${holder.name}`);
      await holder.end();
    },
  ];
  try {
    for (let step = 0; step < steps; step += 1) {
      await pick(actions)!();
      await Promise.resolve();
      const failure = check(`step ${step}`);
      if (failure) return failure;
    }
    while (holders.length) {
      const holder = holders[0]!;
      trace.push(`end ${holder.name}`);
      await holder.end();
    }
    if (backend.marked.size)
      return `after every holder ended, still marked: ${JSON.stringify([...backend.marked])}\n${trace.join("\n")}`;
    return undefined;
  } finally {
    await router.close();
  }
}

describe("SessionCdpRouter: a mark lives exactly as long as a hold that ends with its agent", () => {
  it("holds for a fixed set of seeds", async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300 && failures.length < 3; seed += 1) {
      const failure = await run(seed, 40);
      if (failure) failures.push(`seed ${seed}: ${failure}`);
    }
    expect(failures).toEqual([]);
  });

  it("releases what a Run's relayed channel held when it detaches, and a popup the person opens later is theirs (M1)", async () => {
    const backend = new Backend();
    backend.add("root");
    backend.add("t1");
    const router = new SessionCdpRouter(backend);
    router.registerSession("s", "root", async () => true, "/files/s");
    router.claimTarget("s", "t1");
    const created = (await router.send("s", {
      method: "Target.createTarget",
      parameters: { url: "https://site.test/run-created" },
    })) as { targetId: string };
    expect(backend.marked.has(created.targetId)).toBe(true);
    backend.loads.find((load) => load.targetId === created.targetId)!.settle();
    expect(backend.marked.has(created.targetId)).toBe(false);
    const { sessionId } = (await router.send("s", {
      method: "Target.attachToTarget",
      parameters: { targetId: "t1", flatten: true },
    })) as { sessionId: string };
    backend.emit("Target.targetCreated", { targetInfo: backend.add("pop-run-relayed", "t1") });
    expect([...backend.marked].sort()).toEqual(["pop-run-relayed", "t1"]);
    await router.send("s", { method: "Target.detachFromTarget", parameters: { sessionId } });
    expect([...backend.marked]).toEqual([]);
    backend.emit("Target.targetCreated", {
      targetInfo: backend.add("pop-person-later", "pop-run-relayed"),
    });
    expect([...backend.marked]).toEqual([]);
    await router.close();
  });
});
