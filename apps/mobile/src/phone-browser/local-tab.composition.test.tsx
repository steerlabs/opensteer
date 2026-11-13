// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { BrowserSessionIdSchema, hostApi } from "@opensteer/protocol";
import { KeyedStreamReceiver } from "@opensteer/protocol/keyed-stream";
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
    const bootstrap = await seed.rpc["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error("The seed Host did not provide bootstrap metadata");
    const base = bootstrap.data;
    const sessionId = BrowserSessionIdSchema.parse(admission.sessionId);
    const browser = (): HostedBrowserBootstrap => {
      const receiver = new KeyedStreamReceiver<BrowserTabRecord, BrowserTabStreamMeta>();
      for (const message of f.server())
        if (message.type === "browser.tabs") receiver.apply(message.stream);
      const records = [...receiver.rows.values()];
      return {
        ...base.browser,
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
        groups: {
          complete: true,
          rows: [
            {
              ...base.browser.groups!.rows[0]!,
              id: sessionId,
              sessionId,
              state: "ready",
              access: "read-write",
              origin: "person",
              placement: { kind: "runner", runnerId: f.fence.runnerId },
              profileId: null,
              runtimeId: "phone-runtime",
              tabCount: records.length,
            },
          ],
        },
        tabs: [
          {
            groupId: sessionId,
            complete: true,
            rows: records.map((record) => ({
              id: record.id,
              sessionId,
              title: record.title,
              site: record.url,
              iconRef: null,
              order: record.order,
              openerId: record.openerId,
              createdAt: new Date(f.clock.now()).toISOString(),
              state: record.state === "live" ? "live" : "suspended",
              availability: "ready",
              documentId: record.documentId,
              loading: record.loading,
              navigationFailed: record.navigationFailed,
              canGoBack: record.canGoBack,
              canGoForward: record.canGoForward,
              occupants: [],
            })),
          },
        ],
      };
    };
    const sockets: { url: string; socket: Socket }[] = [];
    const dispatch = vi.fn(async () => {
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
        tabId: f.surfaceId,
        groupId: sessionId,
        sessionId,
        session: {
          id: sessionId,
          access: "read-write",
          origin: "person",
          state: "ready",
          createdAt: new Date(f.clock.now()).toISOString(),
          updatedAt: new Date(f.clock.now()).toISOString(),
          placement: { kind: "runner", runnerId: f.fence.runnerId },
          profileId: null,
          runtimeId: "phone-runtime",
        },
      };
    });
    const client = new HttpHostClient({
      baseUrl: "http://composition.test",
      capabilities: ["browser-target-control-v1"],
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new Socket();
        sockets.push({ url, socket });
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const name = url.pathname.slice("/v1/rpc/".length) as keyof typeof hostApi;
        if (name === "bootstrap.get")
          return Response.json({
            ok: true,
            data: { ...base, deploymentId: f.deploymentId, browser: browser() },
          });
        const raw = url.searchParams.get("input") ?? init?.body;
        const payload = hostApi[name].payload.parse(typeof raw === "string" ? JSON.parse(raw) : {});
        if (name === "commands.dispatch" && "type" in payload && payload.type === "tab.activate")
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
    try {
      await withTimeout(client.load(), 1_000, {
        timeoutError: () => new Error("The composition Host did not load"),
      });
      const realtime = sockets.find(({ url }) => url.includes("/realtime"))!.socket;
      let sequence = 0;
      const publish = () =>
        realtime.receive({
          type: "host.snapshot",
          snapshot: {
            ...seed.deploymentSnapshot(String(++sequence)),
            deploymentId: f.deploymentId,
            resources: { appTabs: [], browser: browser() },
          },
        });
      realtime.open();
      publish();
      realtime.receive({ type: "host.synchronized", sequence: "1" });
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
        client.dispose();
        seed.dispose();
      }
    }
  },
);
