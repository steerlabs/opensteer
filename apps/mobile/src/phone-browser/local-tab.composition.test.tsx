// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { MockHostClient, MockPersonalSocket } from "@opensteer/client/mock";
import { DeploymentIdSchema, TabIdSchema, TabSchema, type Tab } from "@opensteer/core";
import { BrowserSessionIdSchema, hostApi, type TabBootstrap } from "@opensteer/protocol";
import { KeyedStreamReceiver } from "@opensteer/protocol/keyed-stream";
import { ScopedClientMessageSchema } from "@opensteer/protocol/personal-sync";
import type {
  BrowserTabRecord,
  BrowserTabStreamMeta,
  HostedBrowserBootstrap,
} from "@opensteer/protocol/browser";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { PagePresence } from "../ui/page-presence.js";
import { LocalPhoneTab } from "./local-tab.js";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";
import { setup, uuid } from "./manager.test-support.js";

vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (values: { ios?: unknown }) => values.ios },
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
}));
vi.mock("react-native-safe-area-context", () => ({}));
// A stale page's cover and chip: none is drawn here, where the page stays live.
vi.mock("react-native-reanimated", () => ({ default: { View: () => null } }));
vi.mock("../ui/motion.js", () => ({ dim: undefined, exit: undefined }));
vi.mock("../ui/last-picture-chip.js", () => ({ LastPictureChip: () => null }));
vi.mock("expo", () => ({ requireNativeView: () => () => null }));
vi.mock("./tab-host.js", () => ({
  PhoneBrowserTabHost: ({
    manager,
    admission,
    onError,
  }: {
    manager: PhoneBrowserManager;
    admission: PhonePresentationAdmission;
    onError: (error: unknown) => void;
  }) => {
    useLayoutEffect(() => {
      void manager.presentTab(admission, "composition-native-host").catch(onError);
      return () => {
        void manager.hideTab(admission.surfaceId).catch(onError);
      };
    }, [manager, admission, onError]);
    return <div>Presented</div>;
  },
}));

class Socket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(type: string, listener: (event: never) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  receive(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

const front: PagePresence = { interactive: true, shown: true, held: true };
const underSheet: PagePresence = { interactive: false, shown: true, held: true };
const offScreen: PagePresence = { interactive: false, shown: false, held: true };
const background: PagePresence = { interactive: false, shown: false, held: false };

test.each([false, true])(
  "Host admission precedes local presentation, which outlives covers and is renewed after the app leaves (foreground restore: %s)",
  async (restore) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const f = await setup();
    const original = f.manager.localPresentation(f.deploymentId, f.surfaceId)!;
    if (restore) {
      await f.manager.setForeground(false);
      await f.manager.setForeground(true);
      await f.reconnect();
      await f.open("agent-tab");
      await f.agentAttach();
      await f.action({ type: "surface.resume" }, "agent-tab");
    }
    const admission = f.manager.localPresentation(f.deploymentId, f.surfaceId)!;
    const seed = new MockHostClient({ latencyMs: 0 });
    const shell = await seed.rpc["personal.shell.get"]({});
    if (!shell.ok) throw new Error("The seed Host did not provide shell metadata");
    const base = shell.data;
    const sessionId = BrowserSessionIdSchema.parse(admission.sessionId);
    const tabId = TabIdSchema.parse(f.surfaceId);
    const browser = (): HostedBrowserBootstrap => ({
      available: true,
      profiles: [],
      profileHomes: [],
      placements: [
        {
          kind: "runner",
          runnerId: f.fence.runnerId,
          runtimeId: "phone-runtime",
          label: "Phone",
          environmentIds: [],
          available: true,
        },
      ],
    });
    // The phone's own pages, listed as the Host lists them: awake while live, asleep otherwise.
    const tabs = (): TabBootstrap => {
      const receiver = new KeyedStreamReceiver<BrowserTabRecord, BrowserTabStreamMeta>();
      for (const message of f.server())
        if (message.type === "browser.tabs") receiver.apply(message.stream);
      const rows: Tab[] = [...receiver.rows.values()].map((record) =>
        TabSchema.parse({
          tabId: record.id,
          kind: "page",
          title: record.title,
          url: record.url || "about:blank",
          profile: null,
          computer: { computerId: f.fence.runnerId, name: "Phone" },
          groupId: null,
          state: record.state === "live" ? "open" : "asleep",
          openedBy: "person",
          usedBy: [],
          createdAt: new Date(f.clock.now()).toISOString(),
          updatedAt: new Date(f.clock.now()).toISOString(),
        }),
      );
      return {
        tabs: rows,
        layout: { revision: 1, items: rows.map((row) => ({ kind: "tab", tabId: row.tabId })) },
        complete: true,
      };
    };
    const sockets: { url: string; socket: Socket }[] = [];
    let realtime: MockPersonalSocket;
    let generation = 0;
    let sequence = 0;
    const publish = () => {
      const fromSequence = String(sequence);
      const throughSequence = String(++sequence);
      const address = {
        scope: { kind: "shell" } as const,
        subscriptionId: "shell" as const,
        generation,
        throughSequence,
      };
      const snapshot = {
        ...seed.scopedShell(undefined, throughSequence),
        deploymentId: DeploymentIdSchema.parse(f.deploymentId),
      };
      if (sequence === 1) {
        realtime.deliver({ ...address, type: "host.snapshot", snapshot });
        realtime.deliver({ ...address, type: "host.synchronized" });
      } else {
        realtime.deliver({
          ...address,
          type: "host.changes",
          fromSequence,
          changes: [],
          shellProgress: { counts: snapshot.counts },
        });
      }
      // The first frame after an attach answers it, marked as the Host marks it.
      realtime.deliver({
        type: "host.resource",
        subscriptionId: "shell",
        generation,
        ...(sequence === 1 ? { reply: true as const } : {}),
        revisions: Object.fromEntries(
          (["tab", "tab-layout", "browser-placement"] as const).map((kind) => [
            kind,
            throughSequence,
          ]),
        ),
      });
    };
    const dispatch = vi.fn(async () => {
      // The Host restores the sleeping page on the phone that keeps it.
      if (restore)
        await f.client({
          type: "cdp.command",
          requestId: uuid(),
          command: {
            method: "Opensteer.resumeTab",
            parameters: { surfaceId: f.surfaceId },
          },
        });
      return {
        type: "tab.activate",
        tab: tabs().tabs.find((tab) => tab.tabId === tabId),
        viewer: { kind: "page", sessionId, surfaceId: tabId },
      };
    });
    const client = new HttpHostClient({
      baseUrl: "http://composition.test",
      capabilities: ["browser-target-control-v1"],

      webSocketFactory: (url) => {
        if (new URL(url).pathname === "/v1/realtime") {
          realtime = new MockPersonalSocket((data) => {
            const message = ScopedClientMessageSchema.parse(JSON.parse(data));
            if (message.type !== "client.attach") return;
            generation = message.generation;
            queueMicrotask(publish);
          });
          return realtime;
        }
        const socket = new Socket();
        sockets.push({ url, socket });
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const name = url.pathname.slice("/v1/rpc/".length) as keyof typeof hostApi;
        if (name === "personal.shell.get")
          return Response.json({ ok: true, data: { ...base, deploymentId: f.deploymentId } });
        const raw = url.searchParams.get("input") ?? init?.body;
        const payload = hostApi[name].payload.parse(typeof raw === "string" ? JSON.parse(raw) : {});
        if (name === "resources.detail.get") {
          const detail = hostApi[name].payload.parse(payload);
          if (detail.kind === "browser-placement")
            return Response.json({
              ok: true,
              data: {
                revision: String(sequence),
                next: null,
                data: { kind: detail.kind, placements: browser().placements },
              },
            });
          if (detail.kind === "tab" || detail.kind === "tab-layout")
            return Response.json({
              ok: true,
              data: {
                revision: String(sequence),
                next: null,
                data: { kind: detail.kind, tabs: tabs() },
              },
            });
        }
        if (
          name === "commands.dispatch" &&
          "type" in payload &&
          hostApi["commands.dispatch"].payload.parse(payload).type === "tab.activate"
        )
          return Response.json({ ok: true, data: await dispatch() });
        return Response.json(await seed.rpc[name](payload as never));
      },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const present = vi.spyOn(f.manager, "presentTab");
    const hide = vi.spyOn(f.manager, "hideTab");
    const render = (presence: PagePresence, liveSession = !restore) =>
      root.render(
        <LocalPhoneTab
          presence={presence}
          available
          deploymentId={f.deploymentId}
          hostClient={client}
          manager={f.manager}
          admission={restore ? original : admission}
          liveSession={liveSession}
          status={(message) => <div>{message}</div>}
        />,
      );
    const viewers = () => sockets.filter(({ url }) => url.includes("/browser-sessions/"));
    const releaseTabs = client.watchPersonalResource("tab", () => {});
    try {
      await withTimeout(client.load(), 1_000, {
        timeoutError: () => new Error("The composition Host did not load"),
      });
      await vi.waitFor(
        () =>
          expect(
            client.getSnapshot().tabs.get(tabId),
            "Tab resource was never installed",
          ).toBeDefined(),
        { timeout: 1000 },
      );
      // The screen's own activation binds a live page's viewer before the page draws.
      if (!restore) await client.activateTab(tabId);
      await act(async () => render(front));
      expect(container.textContent).toBe("Opening…");
      expect(present).not.toHaveBeenCalled();
      expect(f.presentation().state).toBe("retained");
      await vi.waitFor(
        () =>
          expect(viewers(), "The sleeping local tab never opened its control socket").toHaveLength(
            1,
          ),
        { timeout: 1_000 },
      );
      const show = async (socket: Socket) => {
        await act(async () => socket.open());
        expect(container.textContent).toBe("Opening…");
        expect(f.presentation().state).toBe("retained");
        await act(async () => {
          socket.receive({
            type: "browser.snapshot",
            sessionId,
            state: "ready",
            access: "read-write",
            targetedStreamingVersion: 1,
            dialog: null,
            surfaces: [],
          });
        });
        expect(client.browserViewerState(sessionId, f.surfaceId)).toMatchObject({ admitted: true });
        await vi.waitFor(
          () =>
            expect(f.presentation().state, "The admitted local tab never became visible").toBe(
              "live-visible",
            ),
          { timeout: 1_000 },
        );
        expect(container.textContent).toBe("Presented");
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: "stream.subscribe",
          surfaceId: f.surfaceId,
          frames: false,
        });
        act(publish);
      };
      await show(viewers()[0]!.socket);
      expect(present).toHaveBeenCalledTimes(1);
      if (restore) {
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(f.presentation("agent-tab").state).toBe("live-covered");
      }
      // A sheet over the page, then a screen over it: the page, its viewer and its slot stay.
      for (const covered of [underSheet, offScreen, front]) {
        await act(async () => render(covered, true));
        expect(container.textContent).toBe("Presented");
        expect(f.presentation().state).toBe("live-visible");
      }
      expect(viewers()).toHaveLength(1);
      expect(viewers()[0]!.socket.readyState).toBe(1);
      expect(present).toHaveBeenCalledTimes(1);
      expect(hide).not.toHaveBeenCalled();
      if (restore) expect(dispatch).toHaveBeenCalledTimes(1);
      await act(async () => render(background, true));
      await vi.waitFor(
        () =>
          expect(f.presentation().state, "The hidden local tab never returned to sleep").toBe(
            "retained",
          ),
        { timeout: 1_000 },
      );
      act(publish);
      await act(async () => render(front, true));
      expect(container.textContent).toBe("Opening…");
      expect(present).toHaveBeenCalledTimes(1);
      expect(viewers()).toHaveLength(2);
      await show(viewers()[1]!.socket);
      expect(present).toHaveBeenCalledTimes(2);
      if (restore) expect(f.presentation("agent-tab").state).toBe("live-covered");
    } finally {
      try {
        await act(async () => {
          root.unmount();
          await withTimeout(
            Promise.all(
              hide.mock.results.flatMap((result) =>
                result.type === "return" ? [result.value] : [],
              ),
            ),
            1_000,
            {
              timeoutError: () =>
                new Error("The unmounted tab host did not finish hiding its page"),
            },
          );
        });
      } finally {
        releaseTabs();
        client.dispose();
        seed.dispose();
      }
    }
  },
);
