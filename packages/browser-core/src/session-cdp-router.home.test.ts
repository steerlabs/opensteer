import { describe, expect, it } from "vitest";
import {
  SessionCdpRouter,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpEvent,
  type CdpParameters,
  type StandardCdpAttachment,
} from "./session-cdp-router.js";

/** A page channel that answers every command. */
class Channel implements CdpChannel {
  readonly listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  readonly results = new Map<string, unknown>();
  closed = false;
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async send(method: string): Promise<unknown> {
    return this.results.get(method) ?? {};
  }
  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

class Backend implements BrowserCdpBackend {
  dedicatedContext = true;
  allowsProfileCookieReads = false;
  readonly channels = new Map<string, Channel>();
  readonly listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  readonly agentControlled: [string, boolean][] = [];
  targetInfos: Record<string, unknown>[] = [];
  history: { id: number; url: string }[] = [];
  next = 1;
  setAgentControlled(targetId: string, controlled: boolean): void {
    this.agentControlled.push([targetId, controlled]);
  }
  attach(targetId: string): Promise<CdpChannel> {
    const channel = new Channel();
    channel.results.set("Page.getNavigationHistory", { currentIndex: 0, entries: this.history });
    this.channels.set(targetId, channel);
    return Promise.resolve(channel);
  }
  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(method: string, parameters?: CdpParameters): Promise<unknown> {
    if (method === "Target.getTargets") return Promise.resolve({ targetInfos: this.targetInfos });
    if (method === "Target.getTargetInfo")
      return Promise.resolve({
        targetInfo: this.targetInfos.find((info) => info.targetId === parameters?.targetId),
      });
    if (method === "Target.createTarget") {
      const targetId = `created-${this.next++}`;
      this.targetInfos.push({ targetId, type: "page", url: "about:blank" });
      return Promise.resolve({ targetId });
    }
    return Promise.resolve({});
  }
  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

const home = { origins: ["https://home.example.com"], loopbackPorts: [4310] };
const homeAddresses = [
  "http://127.0.0.1:4310/",
  "http://localhost:4310/tasks",
  "http://[::1]:4310/",
  "http://0x7f000001:4310/",
  "https://home.example.com/settings",
  "https://HOME.example.com/",
];
const otherAddresses = ["http://localhost:5173/", "http://127.0.0.1:3000/", "https://web.test/"];

/** A connected agent's channel, or one of the person's own agents' (a Run's standard CDP). */
const agents = [
  ["a connected agent", true],
  ["the person's own agent", false],
] as const;

async function setup(connection: boolean, url = "https://web.test/") {
  const backend = new Backend();
  backend.targetInfos = [
    { targetId: "seed", type: "page", url },
    { targetId: "other", type: "page", url: "https://web.test/other" },
  ];
  const router = new SessionCdpRouter(backend);
  router.registerSession("s", "seed", async () => true, "/files/s");
  router.claimTarget("s", "other");
  router.setHomeAddresses(home);
  const client = router.openStandardClient("s", {
    wholeContext: false,
    connection,
    lineage: { attachmentId: "00000000-0000-4000-8000-000000000001", seedTargetId: "seed" },
  });
  const events: CdpEvent[] = [];
  client.onEvent((event) => events.push(event));
  await Promise.resolve();
  return { backend, router, client, events };
}

async function attach(client: StandardCdpAttachment, targetId = "seed"): Promise<string> {
  const reply = (await client.send({
    method: "Target.attachToTarget",
    parameters: { targetId, flatten: true },
  })) as { sessionId: string };
  return reply.sessionId;
}

async function refusal(work: Promise<unknown>): Promise<{ code: unknown; message: unknown }> {
  try {
    await work;
  } catch (error) {
    const { code, message } = error as { code: unknown; message: unknown };
    return { code, message };
  }
  throw new Error("Not refused.");
}

describe("SessionCdpRouter: a tab an agent drives may not be on an address of this Home", () => {
  for (const [who, connection] of agents) {
    describe(who, () => {
      for (const url of homeAddresses) {
        it(`refuses Page.navigate to ${url} as any refused address`, async () => {
          const { client } = await setup(connection);
          const sessionId = await attach(client);
          const refused = await refusal(
            client.send({ method: "Page.navigate", parameters: { url }, sessionId }),
          );
          const unsafe = await refusal(
            client.send({
              method: "Page.navigate",
              parameters: { url: "ftp://x.test/" },
              sessionId,
            }),
          );
          expect(refused).toEqual(unsafe);
          expect(String(refused.message)).not.toMatch(/home|opensteer|4310/iu);
        });

        it(`refuses Target.createTarget at ${url}`, async () => {
          const { client } = await setup(connection);
          const refused = await refusal(
            client.send({ method: "Target.createTarget", parameters: { url } }),
          );
          const unsafe = await refusal(
            client.send({ method: "Target.createTarget", parameters: { url: "ftp://x.test/" } }),
          );
          expect(refused).toEqual(unsafe);
        });

        it(`refuses a history entry at ${url}`, async () => {
          const { backend, client } = await setup(connection);
          backend.history = [
            { id: 1, url: "https://web.test/" },
            { id: 2, url },
            { id: 3, url: "ftp://x.test/" },
          ];
          const sessionId = await attach(client);
          const go = (entryId: number) =>
            client.send({
              method: "Page.navigateToHistoryEntry",
              parameters: { entryId },
              sessionId,
            });
          expect(await refusal(go(2))).toEqual(await refusal(go(3)));
        });
      }

      for (const url of otherAddresses)
        it(`lets the agent go to ${url}`, async () => {
          const { client } = await setup(connection);
          const sessionId = await attach(client);
          await expect(
            client.send({ method: "Page.navigate", parameters: { url }, sessionId }),
          ).resolves.toBeDefined();
          await expect(
            client.send({ method: "Target.createTarget", parameters: { url } }),
          ).resolves.toBeDefined();
        });

      it("neither lists nor attaches a page that is on the Home, as a page that is not there", async () => {
        const { client, backend } = await setup(connection, "http://localhost:4310/");
        const listed = (await client.send({ method: "Target.getTargets" })) as {
          targetInfos: { targetId: string }[];
        };
        expect(listed.targetInfos.map((info) => info.targetId)).not.toContain("seed");
        const onHome = await refusal(attach(client));
        backend.targetInfos = backend.targetInfos.filter((info) => info.targetId !== "seed");
        expect(onHome.code).toBe("not_found");
      });

      for (const [route, frame] of [
        ["its main frame", { id: "seed", url: "http://127.0.0.1:4310/" }],
        ["a subframe", { id: "child", parentId: "seed", url: "https://home.example.com/" }],
      ] as const)
        it(`ends the agent's channel when ${route} commits a Home address`, async () => {
          const { backend, client, events } = await setup(connection);
          const sessionId = await attach(client);
          backend.channels.get("seed")!.emit("Page.frameNavigated", { frame });
          await Promise.resolve();
          expect(events.some((event) => event.method === "Page.frameNavigated")).toBe(false);
          expect(events.map((event) => event.method)).toContain("Target.detachedFromTarget");
          const ended = await refusal(
            client.send({ method: "Runtime.evaluate", parameters: { expression: "1" }, sessionId }),
          );
          expect(ended).toEqual({
            code: "not_found",
            message: "CDP session is not attached here.",
          });
          if (route === "its main frame")
            expect((await refusal(attach(client))).code).toBe("not_found");
        });

      it("keeps the channel when the page goes to a dev server on another loopback port", async () => {
        const { backend, client, events } = await setup(connection);
        const sessionId = await attach(client);
        backend.channels.get("seed")!.emit("Page.frameNavigated", {
          frame: {
            id: "seed",
            url: "http://localhost:5173/",
            securityOrigin: "http://localhost:5173",
          },
        });
        await Promise.resolve();
        expect(events.some((event) => event.method === "Page.frameNavigated")).toBe(true);
        await expect(
          client.send({ method: "Runtime.evaluate", parameters: { expression: "1" }, sessionId }),
        ).resolves.toBeDefined();
      });

      it("ends the channel and stops telling of the page when the browser reports it on the Home", async () => {
        const { backend, client, events } = await setup(connection);
        await client.send({ method: "Target.setDiscoverTargets", parameters: { discover: true } });
        const sessionId = await attach(client);
        events.length = 0;
        backend.emit("Target.targetInfoChanged", {
          targetInfo: {
            targetId: "seed",
            type: "page",
            url: "http://localhost:4310/",
            attached: true,
          },
        });
        await Promise.resolve();
        expect(JSON.stringify(events)).not.toContain("4310");
        expect(events.map((event) => event.method)).toContain("Target.detachedFromTarget");
        expect((await refusal(client.send({ method: "DOM.enable", sessionId }))).code).toBe(
          "not_found",
        );
        const listed = (await client.send({ method: "Target.getTargets" })) as {
          targetInfos: { targetId: string }[];
        };
        expect(listed.targetInfos.map((info) => info.targetId)).not.toContain("seed");
      });

      it("marks the tab agent-controlled while the agent holds it, and lets it go", async () => {
        const { backend, client } = await setup(connection);
        expect(backend.agentControlled).toContainEqual(["seed", true]);
        await attach(client, "seed");
        client.close();
        expect(backend.agentControlled.at(-1)).toEqual(["seed", false]);
      });
    });
  }

  for (const [who, connection] of agents)
    it(`${who}: reads no cookie of the Home's, on loopback or its own address (M4)`, async () => {
      const { backend, client } = await setup(connection);
      // A shared Chrome tab: the one browser whose page cookies an agent reads.
      backend.allowsProfileCookieReads = true;
      const sessionId = await attach(client);
      backend.channels.get("seed")!.results.set("Network.getCookies", {
        cookies: [
          { name: "opensteer.session", value: "home", domain: "127.0.0.1" },
          { name: "__Host-opensteer.session", value: "remote", domain: "home.example.com" },
          { name: "opensteer.admission", value: "a", domain: "localhost" },
          { name: "theirs", value: "1", domain: "127.0.0.1" },
          { name: "opensteer.session", value: "a site's own", domain: "web.test" },
        ],
      });
      const read = (await client.send({ method: "Network.getCookies", sessionId })) as {
        cookies: { name: string; domain: string }[];
      };
      expect(read.cookies.map((cookie) => `${cookie.name}@${cookie.domain}`)).toEqual([
        "theirs@127.0.0.1",
        "opensteer.session@web.test",
      ]);
    });

  describe("the same call sites ask both rules (C)", () => {
    for (const [who, connection] of agents) {
      it(`${who}: hears no browser-level event naming this Home (C1)`, async () => {
        const { backend, client, events } = await setup(connection);
        await attach(client);
        events.length = 0;
        backend.emit("Browser.downloadWillBegin", {
          frameId: "seed",
          guid: "g-1",
          url: "http://127.0.0.1:4310/v1/secret",
          suggestedFilename: "f.txt",
        });
        backend.emit("Browser.downloadWillBegin", {
          frameId: "seed",
          guid: "g-2",
          url: "https://web.test/file",
          suggestedFilename: "f.txt",
        });
        await Promise.resolve();
        expect(JSON.stringify(events)).not.toContain("4310");
        expect(JSON.stringify(events)).toContain("g-2");
      });

      it(`${who}: is not told the end of a page it was never shown on the Home, and is told it once it leaves (C2)`, async () => {
        const { backend, client, events } = await setup(connection);
        await client.send({ method: "Target.setDiscoverTargets", parameters: { discover: true } });
        const onHome = (targetId: string) => ({
          targetInfo: {
            targetId,
            type: "page",
            url: "http://localhost:4310/",
            openerId: "seed",
            attached: false,
          },
        });
        events.length = 0;
        backend.emit("Target.targetCreated", onHome("pop-1"));
        backend.emit("Target.targetDestroyed", { targetId: "pop-1" });
        backend.emit("Target.targetCreated", onHome("pop-2"));
        backend.emit("Target.targetInfoChanged", {
          targetInfo: {
            targetId: "pop-2",
            type: "page",
            url: "https://web.test/",
            attached: false,
          },
        });
        await Promise.resolve();
        expect(JSON.stringify(events)).not.toContain("pop-1");
        expect(JSON.stringify(events)).not.toContain("4310");
        expect(
          events.filter((event) => JSON.stringify(event).includes("pop-2")).map((e) => e.method),
        ).toEqual(["Target.targetCreated"]);
      });

      it(`${who}: cannot attach again to a page that holds a frame on the Home until it holds none (C3)`, async () => {
        const { backend, client } = await setup(connection);
        await attach(client);
        backend.channels.get("seed")!.emit("Page.frameNavigated", {
          frame: { id: "child", parentId: "seed", url: "http://127.0.0.1:4310/" },
        });
        await Promise.resolve();
        const tree = (url: string) => ({
          frameTree: {
            frame: { id: "seed", url: "https://web.test/" },
            childFrames: [{ frame: { id: "child", parentId: "seed", url } }],
          },
        });
        const prepare = backend.attach.bind(backend);
        let frameUrl = "http://127.0.0.1:4310/";
        backend.attach = async (targetId: string) => {
          const channel = (await prepare(targetId)) as Channel;
          channel.results.set("Page.getFrameTree", tree(frameUrl));
          return channel;
        };
        expect((await refusal(attach(client))).code).toBe("not_found");
        frameUrl = "https://web.test/frame";
        await expect(attach(client)).resolves.toBeTruthy();
      });
    }

    it("refuses a Run's own attach to a page on the Home before the browser's list arrives (C4)", async () => {
      const backend = new Backend();
      backend.targetInfos = [
        { targetId: "seed", type: "page", url: "https://web.test/" },
        { targetId: "other", type: "page", url: "http://localhost:4310/" },
      ];
      const router = new SessionCdpRouter(backend);
      router.registerSession("s", "seed", async () => true, "/files/s");
      router.claimTarget("s", "other");
      router.setHomeAddresses(home);
      // No turn has passed: the background list has not arrived.
      const refused = await refusal(
        router.send("s", {
          method: "Target.attachToTarget",
          parameters: { targetId: "other", flatten: true },
        }),
      );
      expect(refused.code).toBe("not_found");
      await expect(
        router.send("s", {
          method: "Target.attachToTarget",
          parameters: { targetId: "seed", flatten: true },
        }),
      ).resolves.toBeTruthy();
    });
  });

  describe("a page is agent-controlled from its first instant to the end of the hold (A)", () => {
    const budget = { maxBytes: 65_536, maxDepth: 16, maxEntries: 256 };
    const popup = (targetId: string, openerId: string) => ({
      targetInfo: { targetId, type: "page", url: "about:blank", openerId, attached: false },
    });
    const marks = (backend: Backend, targetId: string) =>
      backend.agentControlled.filter(([id]) => id === targetId).map(([, held]) => held);

    it("holds a popup of a browser_use script's page until the script ends", async () => {
      const backend = new Backend();
      backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://web.test/" }];
      const router = new SessionCdpRouter(backend);
      router.registerSession("s", "seed", async () => true, "/files/s");
      router.setHomeAddresses(home);
      router.openScriptAttachment("s", "script", "seed", budget, () => {}, { connection: true });
      backend.emit("Target.targetCreated", popup("pop", "seed"));
      // Long past any setImmediate: nothing but the script's end lets it go.
      for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setImmediate(done));
      expect(marks(backend, "pop")).toEqual([true]);
      await router.closeScriptAttachment("s", "script", Promise.resolve());
      expect(marks(backend, "pop")).toEqual([true, false]);
    });

    it("holds a page a Run's client outside a lineage creates, and its popups", async () => {
      const backend = new Backend();
      backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://web.test/" }];
      const router = new SessionCdpRouter(backend);
      router.registerSession("s", "seed", async () => true, "/files/s");
      const client = router.openStandardClient("s", { wholeContext: false });
      const { targetId } = (await client.send({
        method: "Target.createTarget",
        parameters: { url: "https://web.test/new" },
      })) as { targetId: string };
      expect(marks(backend, targetId)).toEqual([true]);
      backend.emit("Target.targetCreated", popup("pop", targetId));
      for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setImmediate(done));
      expect(marks(backend, "pop")).toEqual([true]);
      client.close();
      expect(marks(backend, targetId)).toEqual([true, false]);
      expect(marks(backend, "pop")).toEqual([true, false]);
    });

    it("releases a popup whose opener no agent holds, by its decision and not a timer", async () => {
      const backend = new Backend();
      backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://web.test/" }];
      const router = new SessionCdpRouter(backend);
      router.registerSession("s", "seed", async () => true, "/files/s");
      backend.emit("Target.targetCreated", popup("pop", "seed"));
      expect(marks(backend, "pop")).toEqual([false]);
    });

    it("holds a page an agent opens through its first load, then lets it go", () => {
      const backend = new Backend();
      const router = new SessionCdpRouter(backend);
      const release = router.holdAgentPage("opened");
      expect(marks(backend, "opened")).toEqual([true]);
      release();
      release();
      expect(marks(backend, "opened")).toEqual([true, false]);
    });

    it("hands over no page that commits the Home while its attach awaits the browser (item 4)", async () => {
      for (const [who, connection] of agents) {
        const { backend, client } = await setup(connection);
        let answer!: () => void;
        const slow = new Promise<void>((resolve) => (answer = resolve));
        const attach = backend.attach.bind(backend);
        backend.attach = async (targetId: string) => {
          await slow;
          return attach(targetId);
        };
        const attaching = client.send({
          method: "Target.attachToTarget",
          parameters: { targetId: "seed", flatten: true },
        });
        void attaching.catch(() => undefined);
        await Promise.resolve();
        backend.emit("Target.targetInfoChanged", {
          targetInfo: { targetId: "seed", type: "page", url: "http://127.0.0.1:4310/settings" },
        });
        answer();
        await expect(attaching, who).rejects.toMatchObject({ code: "not_found" });
        expect(backend.channels.get("seed")?.closed ?? true, who).toBe(true);
      }
    });

    it("ends everything a relay owns when it ends, and lets no other relay name it anywhere (item 5)", async () => {
      const backend = new Backend();
      backend.targetInfos = [
        { targetId: "seed", type: "page", url: "https://web.test/" },
        { targetId: "t2", type: "page", url: "https://web.test/2" },
        { targetId: "t3", type: "page", url: "https://web.test/3" },
      ];
      const router = new SessionCdpRouter(backend);
      router.registerSession("s", "seed", async () => true, "/files/s");
      router.claimTarget("s", "t2");
      router.claimTarget("s", "t3");
      router.setHomeAddresses(home);
      const relayA = "00000000-0000-4000-8000-00000000000a";
      const relayB = "00000000-0000-4000-8000-00000000000b";
      const open = (router as { openRelay?: (session: string, relay: string) => void }).openRelay;
      open?.call(router, "s", relayA);
      open?.call(router, "s", relayB);
      const send = (relayId: string, command: Record<string, unknown>) =>
        router.send("s", { ...command, relayId } as never);
      const { sessionId: s1 } = (await send(relayA, {
        method: "Target.attachToTarget",
        parameters: { targetId: "seed", flatten: true },
      })) as { sessionId: string };
      // Relay A attaches t2 through its own page session (a nested attach, as Probe C did).
      const { sessionId: s2 } = (await send(relayA, {
        method: "Target.attachToTarget",
        parameters: { targetId: "t2", flatten: true },
        sessionId: s1,
      })) as { sessionId: string };
      expect(marks(backend, "t2")).toEqual([true]);
      // Relay B names A's sessions inside its commands: refused before the browser, every way.
      await expect(
        send(relayB, {
          method: "Target.sendMessageToTarget",
          parameters: {
            sessionId: s2,
            message: JSON.stringify({
              id: 1,
              method: "Page.navigate",
              params: { url: "https://web.test/x" },
            }),
          },
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await send(relayB, {
        method: "Target.detachFromTarget",
        parameters: { sessionId: s2 },
      }).catch(() => undefined);
      expect(marks(backend, "t2")).toEqual([true]);
      // An attach of A's is still pending in the browser when A ends.
      let answer!: () => void;
      const slow = new Promise<void>((resolve) => (answer = resolve));
      const attach = backend.attach.bind(backend);
      backend.attach = async (targetId: string) => {
        await slow;
        return attach(targetId);
      };
      const pending = send(relayA, {
        method: "Target.attachToTarget",
        parameters: { targetId: "t3", flatten: true },
      });
      void pending.catch(() => undefined);
      await Promise.resolve();
      router.endRelay("s", relayA);
      answer();
      await expect(pending).rejects.toMatchObject({ code: "not_found" });
      // Everything A held is let go, the nested session's page too; nothing of A's is drivable.
      expect(marks(backend, "t2")).toEqual([true, false]);
      expect(marks(backend, "t3").at(-1) ?? false).toBe(false);
      await expect(
        send(relayA, {
          method: "Target.sendMessageToTarget",
          parameters: {
            sessionId: s2,
            message: JSON.stringify({
              id: 2,
              method: "Page.navigate",
              params: { url: "https://route.test/" },
            }),
          },
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("holds a popup a page opens during its first load, until that load's hold ends (item 3)", async () => {
      const backend = new Backend();
      backend.targetInfos = [
        { targetId: "seed", type: "page", url: "https://web.test/" },
        { targetId: "opened", type: "page", url: "about:blank" },
      ];
      const router = new SessionCdpRouter(backend);
      router.registerSession("s", "seed", async () => true, "/files/s");
      router.setHomeAddresses(home);
      router.claimTarget("s", "opened");
      // As `Opensteer.openTab` and a session root's `Target.createTarget` hold an agent's open.
      const release = router.holdAgentPage("opened");
      backend.emit("Target.targetCreated", popup("pop", "opened"));
      for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setImmediate(done));
      expect(marks(backend, "pop")).toEqual([true]);
      release();
      expect(marks(backend, "opened")).toEqual([true, false]);
      expect(marks(backend, "pop")).toEqual([true, false]);
    });
  });

  it("refuses nothing before the Home has told the browser its addresses", async () => {
    const backend = new Backend();
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://web.test/" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("s", "seed", async () => true, "/files/s");
    const client = router.openStandardClient("s", {
      wholeContext: false,
      lineage: { attachmentId: "00000000-0000-4000-8000-000000000002", seedTargetId: "seed" },
    });
    const sessionId = await attach(client);
    await expect(
      client.send({
        method: "Page.navigate",
        parameters: { url: "http://localhost:4310/" },
        sessionId,
      }),
    ).resolves.toBeDefined();
  });
});
