import { DeviceIdSchema } from "@opensteer/core";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
interface PersonalFixture {
  readonly id: import("@opensteer/core").DeploymentId;
  readonly name: string;
}
import type { PersonalStreamCheckpoint } from "./personal-stream-cache.js";
import { KeyedStreamPublisher } from "@opensteer/protocol/keyed-stream";
import type { HostedBrowserBootstrap as BrowserWireBootstrap } from "@opensteer/protocol/browser";
import type { TabBootstrap } from "@opensteer/protocol";
import { tabFixture } from "../test-support/tab-fixtures.js";
import { schedulesClient } from "./schedules.js";
import { sharedDisplayStreams } from "../integrations/phone-display-stream.js";

import {
  ComputerViewIdSchema,
  AppSchema,
  ModelSelectionSchema,
  SequenceSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  createId,
  emptyExecutionPreferences,
  type AgentEventView as AgentEvent,
  type Message,
  type NotificationView,
  type Request as OpensteerRequest,
  type Tab,
  type TabLayout,
  type Thread,
  type ThreadInputQueue,
} from "@opensteer/core";
import {
  apiVersionQueryParameter,
  apiCurrentQueryParameter,
  hostApiVersion,
  minimumHostApiVersion,
} from "@opensteer/deployment-authority";
import { createIntegrationId } from "@opensteer/integration-core";
import {
  BrowserSurfaceIdSchema,
  ComputerViewSchema,
  HostToClientMessageSchema,
  createBrowserSessionId,
  type HostToClientMessage,
  type RealtimeFrameDiagnostic,
} from "@opensteer/protocol";
import {
  BootstrapReadDiagnostics,
  bootstrapDiagnosticHeader,
} from "@opensteer/shared/bootstrapDiagnostics";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";

import { bootstrapReadDiagnostics } from "./bootstrap-diagnostics.js";
import type { ThreadSummary } from "./client.js";
import type { ExecutionSelection } from "./execution-preferences.js";
import {
  HttpHostClient,
  type HttpHostClientOptions,
  type WebSocketClient,
} from "./host-session-client.js";
import { describeHostConnection } from "./host-connection.js";
import {
  connectionInterruptionHoldMs,
  realtimeIdleProbeDeadlineMs,
  realtimeIdleProbeMs,
  socketProbeDeadlineMs,
} from "./lifecycle.js";
import type {
  ClientLifecycle,
  ClientLifecycleSnapshot,
  ClientNetworkPath,
  ClientNetworkState,
} from "./lifecycle.js";
import { visibleTranscript } from "./transcript.js";
import { conversationRows, groupTranscriptEntries } from "./agent-activity-model.js";

import { threadActivity, threadStopTarget } from "./thread-activity.js";

const now = "2026-08-09T20:00:00.000Z";
const ownerId = createId("user");
const runnerId = createId("runner");
const environmentId = createId("environment");
const harnessInstanceId = createId("harnessInstance");

describe("HttpHostClient tabs", () => {
  /*
   * Ways the tab list can fail a person: a title change rebuilds or rereads
   * the whole list; a gap or unreadable frame leaves the list stale with no
   * restart; a slow bootstrap read takes back what the stream already showed;
   * a page's viewer opens before the Host bound it, or outlives its tab; the
   * Apps page never hears that its list changed.
   */
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      tabFixture({
        tabId: BrowserSurfaceIdSchema.parse(`tab-${index}`),
        title: `Page ${index}`,
        computer: { computerId: DeviceIdSchema.parse(runnerId), name: "Mac" },
      }),
    );
  const layoutOf = (tabs: readonly Tab[], revision = 1): TabLayout => ({
    revision,
    items: tabs.map((tab) => ({ kind: "tab" as const, tabId: tab.tabId })),
  });
  async function tabsHost(page = pageTabHost(makeDeployment())) {
    const sockets: { url: string; socket: FakeSocket }[] = [];
    const client = createHttpHostClient({
      capabilities: ["browser-target-control-v1"],
      fetch: page.fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
    });
    await client.load();
    const carrier = sockets.find(({ url }) => url.includes("/v1/realtime"))!.socket;
    carrier.open();
    carrier.receive({ type: "host.snapshot", snapshot: deploymentSnapshot(page.workspace, "0") });
    const resyncs = () =>
      carrier.sent.filter((data) => JSON.parse(data).type === "client.browser.resync").length;
    return { client, carrier, page, resyncs, sockets };
  }

  it("takes the carrier's stream and patches one tab among the most a list holds without rereads", async () => {
    const f = await tabsHost();
    try {
      expect(f.resyncs()).toBe(1);
      const rows = many(1200);
      publishTabs(f.carrier, rows, layoutOf(rows));
      const tabs = f.client.getSnapshot().tabs;
      expect(tabs.rows.size).toBe(1200);
      expect(tabs.complete).toBe(true);
      const [first, second] = rows.map((row) => tabs.get(row.tabId)!);
      const changed = vi.fn();
      const untouched = vi.fn();
      const structure = vi.fn();
      tabs.subscribeTab(first!.tabId, changed);
      tabs.subscribeTab(second!.tabId, untouched);
      tabs.subscribeStructure(structure);
      const reads = f.page.fetch.mock.calls.length;
      f.carrier.receiveRaw({
        type: "host.tabs",
        stream: {
          op: "change",
          generation: "g1",
          base: 0,
          revision: 1,
          update: [{ tabId: first!.tabId, title: "Fresh title" }],
        },
      });
      expect(tabs.get(first!.tabId)?.title).toBe("Fresh title");
      expect(tabs.get(second!.tabId)).toBe(second);
      expect(changed).toHaveBeenCalledOnce();
      expect(untouched).not.toHaveBeenCalled();
      expect(structure).not.toHaveBeenCalled();
      expect(f.client.getSnapshot().tabs).toBe(tabs);
      expect(f.page.fetch).toHaveBeenCalledTimes(reads);
    } finally {
      f.client.dispose();
    }
  });

  it("asks the carrier for a fresh stream after a gap or an unreadable frame, keeping what it shows", async () => {
    const f = await tabsHost();
    try {
      const rows = many(3);
      publishTabs(f.carrier, rows, layoutOf(rows));
      const before = f.resyncs();
      f.carrier.receiveRaw({
        type: "host.tabs",
        stream: { op: "change", generation: "g1", base: 5, revision: 6, remove: [rows[0]!.tabId] },
      });
      expect(f.resyncs()).toBe(before + 1);
      expect(f.client.getSnapshot().tabs.rows.size).toBe(3);
      expect(f.client.getSnapshot().tabs.syncing).toBe(true);
      f.carrier.receiveRaw({ type: "host.tabs", stream: { op: "unreadable" } });
      expect(f.resyncs()).toBe(before + 2);
      publishTabs(f.carrier, rows.slice(1), layoutOf(rows.slice(1), 2), "g2");
      expect(f.client.getSnapshot().tabs.rows.size).toBe(2);
      expect(f.client.getSnapshot().tabs.syncing).toBe(false);
    } finally {
      f.client.dispose();
    }
  });

  it("keeps the stream's tabs through a slower, older bootstrap read", async () => {
    const f = await tabsHost();
    try {
      const current = { ...f.page.tab, title: "Checkout" };
      publishTabs(f.carrier, [current], layoutOf([current], 2));
      const tabs = f.client.getSnapshot().tabs;
      const row = tabs.get(current.tabId);
      await f.client.refresh();
      expect(f.client.getSnapshot().tabs).toBe(tabs);
      expect(tabs.get(current.tabId)).toBe(row);
      expect(tabs.layout.revision).toBe(2);
    } finally {
      f.client.dispose();
    }
  });

  it("opens a page's viewer only once the Host bound it, and lets go when its tab closes", async () => {
    const f = await tabsHost();
    const { sessionId, tabId } = f.page;
    const viewers = () => f.sockets.filter(({ url }) => url.includes("/browser-sessions/"));
    try {
      publishTabs(f.carrier, [f.page.tab], layoutOf([f.page.tab]));
      const early = f.client.retainBrowserViewer(sessionId, tabId, { picture: false });
      expect(viewers()).toEqual([]);
      early();
      expect(await f.client.activateTab(tabId)).toEqual({
        kind: "page",
        sessionId,
        surfaceId: tabId,
      });
      expect(f.client.tabViewer(tabId)).toMatchObject({ kind: "page", sessionId });
      const release = f.client.retainBrowserViewer(sessionId, tabId);
      expect(viewers()).toHaveLength(1);
      const viewer = viewers()[0]!.socket;
      viewer.open();
      viewer.receiveRaw({
        type: "browser.snapshot",
        sessionId,
        access: "read-write",
        state: "ready",
        dialog: null,
        targetedStreamingVersion: 1,
        surfaces: [{ id: tabId, active: true, title: "Example", url: "https://example.test/" }],
      });
      viewer.receiveBinary(browserFrame(tabId));
      expect(f.client.browserFrames.get(sessionId, tabId)).not.toBeNull();
      f.carrier.receiveRaw({
        type: "host.tabs",
        stream: { op: "change", generation: "g1", base: 0, revision: 1, remove: [tabId] },
      });
      expect(f.client.tabViewer(tabId)).toBeNull();
      expect(f.client.getSnapshot().browserSessions.some(({ id }) => id === sessionId)).toBe(false);
      // The closed tab's transport and picture go with it, though a viewer still holds them.
      expect(viewer.readyState).toBe(3);
      expect(f.client.browserFrames.get(sessionId, tabId)).toBeNull();
      release();
    } finally {
      f.client.dispose();
    }
  });

  it("closes a page's viewer transport when the Host says its tab became unavailable", async () => {
    const f = await tabsHost();
    const { sessionId, tabId } = f.page;
    try {
      publishTabs(f.carrier, [f.page.tab], layoutOf([f.page.tab]));
      await f.client.activateTab(tabId);
      const release = f.client.retainBrowserViewer(sessionId, tabId, { picture: false });
      const viewer = f.sockets.find(({ url }) => url.includes("/browser-sessions/"))!.socket;
      viewer.open();
      f.carrier.receiveRaw({
        type: "host.tabs",
        stream: {
          op: "change",
          generation: "g1",
          base: 0,
          revision: 1,
          update: [
            {
              tabId,
              state: "unavailable",
              unavailableCode: "runtime-failed",
              unavailableReason: "The browser stopped.",
            },
          ],
        },
      });
      expect(viewer.readyState).toBe(3);
      release();
    } finally {
      f.client.dispose();
    }
  });

  it("binds nothing for a tab the stream closed while its activation was answering", async () => {
    const f = await tabsHost();
    const { sessionId, tabId } = f.page;
    try {
      publishTabs(f.carrier, [f.page.tab], layoutOf([f.page.tab]));
      const answer = deferred<void>();
      const fetch = f.page.fetch.getMockImplementation()!;
      f.page.fetch.mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (rpcPayload(url, init).type === "tab.activate") await answer.promise;
        return fetch(input, init);
      });
      const activation = f.client.activateTab(tabId);
      f.carrier.receiveRaw({
        type: "host.tabs",
        stream: { op: "change", generation: "g1", base: 0, revision: 1, remove: [tabId] },
      });
      answer.resolve();
      await activation;
      expect(f.client.tabViewer(tabId)).toBeNull();
      expect(f.client.getSnapshot().browserSessions.some(({ id }) => id === sessionId)).toBe(false);
      expect(() =>
        f.client.retainBrowserViewer(sessionId, tabId, { picture: false })(),
      ).not.toThrow();
      expect(f.sockets.filter(({ url }) => url.includes("/browser-sessions/"))).toEqual([]);
    } finally {
      f.client.dispose();
    }
  });

  it("lets a tab answer meant for the previous account reach neither its list nor its views", async () => {
    let signedIn = true;
    const page = pageTabHost(makeDeployment());
    const fetch = page.fetch.getMockImplementation()!;
    const answers = { activate: deferred<void>(), open: deferred<void>() };
    page.fetch.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const type = rpcPayload(url, init).type;
      if (type === "tab.activate") await answers.activate.promise;
      if (type === "tab.open") {
        await answers.open.promise;
        const tab = tabFixture({ tabId: BrowserSurfaceIdSchema.parse("opened") });
        return json({ tab, layout: layoutOf([page.tab, tab], 9) });
      }
      if (!url.pathname.endsWith("/commands.dispatch") && !signedIn)
        return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
      return fetch(input, init);
    });
    const f = await tabsHost(page);
    try {
      publishTabs(f.carrier, [page.tab], layoutOf([page.tab]));
      const activation = f.client.activateTab(page.tabId);
      const opening = f.client.openTab({ kind: "page", url: "https://example.test/", guest: true });
      signedIn = false;
      await expect(f.client.refresh()).rejects.toThrow();
      signedIn = true;
      await f.client.load();
      answers.activate.resolve();
      answers.open.resolve();
      await expect(activation).rejects.toThrow("signed-in account changed");
      await expect(opening).rejects.toThrow("signed-in account changed");
      expect(f.client.tabViewer(page.tabId)).toBeNull();
      expect(f.client.getSnapshot().browserSessions).toEqual([]);
      expect(f.client.getSnapshot().tabs.get("opened")).toBeUndefined();
    } finally {
      f.client.dispose();
    }
  });

  it("tells the Apps page to read again when the Host's apps change or a notice is lost", async () => {
    const f = await tabsHost();
    try {
      const revision = f.client.getSnapshot().appsRevision;
      f.carrier.receiveRaw({
        type: "host.apps.changed",
        appIds: ["app_00000000-0000-4000-8000-000000000001"],
      });
      expect(f.client.getSnapshot().appsRevision).toBe(revision + 1);
      f.carrier.receiveRaw({ type: "host.apps.changed", appIds: "unreadable" });
      expect(f.client.getSnapshot().appsRevision).toBe(revision + 2);
    } finally {
      f.client.dispose();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Every test addresses the same notional Host, so only the cases about the
 * origin itself say which one. */
type TestHostClientOptions = Omit<HttpHostClientOptions, "baseUrl"> & {
  readonly baseUrl?: string | URL;
  /** Whether the case's own fetch sees the time zone report every bootstrap sends. */
  readonly timeZoneReports?: "answered" | "observed";
  readonly browserUsageReads?: "answered" | "observed";
  /** Whether the case's own fetch sees the task list reads that follow bootstrap and sync. */
  readonly taskReads?: "answered" | "observed";
};

function createHttpHostClient({
  timeZoneReports = "answered",
  browserUsageReads = "answered",
  taskReads = "answered",
  ...options
}: TestHostClientOptions = {}): HttpHostClient {
  return new HttpHostClient({
    baseUrl: "http://127.0.0.1",
    ...options,
    webSocketFactory: (url) => options.webSocketFactory?.(url) ?? new FakeSocket(),
    ...(options.fetch
      ? {
          fetch: rpcContractFetch(options.fetch, timeZoneReports, browserUsageReads, taskReads),
        }
      : {}),
  });
}

function rpcContractFetch(
  fetch: typeof globalThis.fetch,
  timeZoneReports: "answered" | "observed",
  browserUsageReads: "answered" | "observed",
  taskReads: "answered" | "observed",
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const prefix = "/v1/rpc/";
    if (!url.pathname.startsWith(prefix)) return fetch(input, init);
    const name = url.pathname.slice(prefix.length);
    // Nothing waits on this notional Host's reader: the read follows every
    // bootstrap, and no case here is about it.
    if (name === "needsYou.get")
      return json({
        ok: true,
        data: {
          count: 0,
          entries: [],
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
      });
    if (name === "requests.list") {
      return json({
        data: {
          requests: [],
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
        ok: true,
      });
    }
    // The reader has no tasks here unless the case is about them.
    if (name === "tasks.list" && taskReads === "answered") {
      return json({
        data: {
          asOfSequence: SequenceSchema.parse("0"),
          tasks: [],
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        },
        ok: true,
      });
    }
    const payload = rpcPayload(url, init);
    if (name === "thread.browserUsage.get" && browserUsageReads === "answered")
      return json({ data: { threadId: payload.threadId, uses: [] }, ok: true });
    // Likewise the time zone report that follows a bootstrap, except in the
    // cases about that report.
    if (
      timeZoneReports === "answered" &&
      name === "commands.dispatch" &&
      payload.type === "viewer.timeZone.update"
    ) {
      return json({ data: { timeZone: payload.timeZone, type: payload.type }, ok: true });
    }
    const response = await fetch(input, init);
    const responseBody: unknown = response.status === 204 ? {} : await response.json();
    if (!response.ok) {
      const error = objectValue(responseBody, "error");
      const reason = stringValue(error, "reason");
      return json(
        {
          error: {
            code: stringValue(error, "code") ?? "internal",
            message: stringValue(error, "message") ?? "Request failed",
            retryable: booleanValue(error, "retryable") ?? false,
            ...(reason === null ? {} : { reason }),
          },
          ok: false,
        },
        response.status,
      );
    }
    const body = asObject(responseBody);
    const data =
      name === "commands.dispatch"
        ? { asOfSequence: "0", ...body, type: requiredString(payload, "type") }
        : name === "thread.events.list"
          ? {
              ...body,
              asOfSequence: body.asOfSequence ?? SequenceSchema.parse("0"),
            }
          : responseBody;
    if (name === "bootstrap.get") {
      const id = stringValue(data, "deploymentId");
      if (id)
        bootstrapFixtures.set(id, {
          browser: objectValue(data, "browser") as BrowserWireBootstrap,
          tabs: objectValue(data, "tabs") as TabBootstrap,
        });
    }
    return json({ data, ok: true }, response.status);
  };
}

function rpcPayload(url: URL, init: RequestInit | undefined): Readonly<Record<string, unknown>> {
  const raw = url.searchParams.has("input") ? url.searchParams.get("input") : init?.body;
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("RPC input");
  return parsed as Readonly<Record<string, unknown>>;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function objectValue(value: unknown, key: string): unknown {
  return asObject(value)[key];
}

function stringValue(value: unknown, key: string): string | null {
  const candidate = objectValue(value, key);
  return typeof candidate === "string" ? candidate : null;
}

function booleanValue(value: unknown, key: string): boolean | null {
  const candidate = objectValue(value, key);
  return typeof candidate === "boolean" ? candidate : null;
}

function requiredString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new TypeError(`Missing ${key}`);
  return value;
}

describe("HttpHostClient authentication and onboarding", () => {
  it("projects and clears the authenticated session surface", async () => {
    const sessionId = createId("authSession");
    const remoteBootstrap = {
      ...bootstrap([]),
      sessionId,
      sessionSurface: "personal-remote" as const,
    };
    let authenticated = true;
    const remote = createHttpHostClient({
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/auth.config") return json(remoteBootstrap.identityConfig);
        return authenticated ? json(remoteBootstrap) : json({ error: unauthorizedError() }, 401);
      },
    });
    await remote.load();
    expect(remote.getSnapshot().sessionSurface).toBe("personal-remote");
    expect(remote.getSnapshot().sessionId).toBe(sessionId);

    authenticated = false;
    await remote.refresh();
    expect(remote.getSnapshot()).toMatchObject({
      session: "authentication-required",
      sessionSurface: null,
    });
    remote.dispose();
  });

  it("spends a password-recovery capability without retaining it or the new password", async () => {
    const token = `olpr_${"A".repeat(43)}`;
    const newPassword = "new password that must not persist";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      expect(path).toBe("/v1/rpc/auth.password.recover");
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(String(init?.body))).toEqual({ newPassword, token });
      return json({ reset: true });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });

    await client.rpc["auth.password.recover"]({ newPassword, token });
    expect(JSON.stringify(client)).not.toContain(token);
    expect(JSON.stringify(client)).not.toContain(newPassword);
    client.dispose();
  });

  it("creates a bounded local Runner enrollment without retaining its token", async () => {
    const token = "local-runner-one-use-token-with-sufficient-entropy";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      expect(path).toBe("/v1/rpc/commands.dispatch");
      expect(JSON.parse(String(init?.body))).toEqual({
        allowedModules: ["agents"],
        idempotencyKey: "desktop-local-runner:test",
        name: "Test computer",
        type: "runner.enrollment.createLocal",
      });
      return json({
        enrollmentId: "ren_test-computer",
        expiresAt: "2026-08-09T20:10:00.000Z",
        token,
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });

    await expect(
      client.dispatch({
        allowedModules: ["agents"],
        idempotencyKey: "desktop-local-runner:test",
        name: "Test computer",
        type: "runner.enrollment.createLocal",
      }),
    ).resolves.toMatchObject({
      enrollmentId: "ren_test-computer",
      expiresAt: "2026-08-09T20:10:00.000Z",
      token,
    });
    expect(JSON.stringify(client)).not.toContain(token);
    client.dispose();
  });

  it("consumes first-owner setup without retaining the enrollment or password", async () => {
    const setupToken = "host-setup-secret-that-must-not-persist";
    const password = "correct-horse";
    const requests: Array<{
      body: string | null;
      credentials: RequestCredentials | undefined;
      path: string;
    }> = [];
    let authenticated = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({
        body: typeof init?.body === "string" ? init.body : null,
        credentials: init?.credentials,
        path: url.pathname,
      });
      if (url.pathname === "/v1/rpc/auth.config") {
        return json({
          deployment: { kind: "personal" as const, name: null },
          emailDeliveryAvailable: false,
          localPasswordEnabled: true,
          machineOwner: false,
          oidcProviders: [],
          passkeysEnabled: false,
          exposure: "loopback",
          portalOrigin: null,
          publicOrigin: "http://localhost:43100",
          setupState: "required",
          signupPolicy: "invite-only",
        });
      }
      if (url.pathname === "/v1/rpc/auth.setup.exchange") {
        expect(JSON.parse(String(init?.body))).toEqual({ token: setupToken });
        return json({ admitted: true });
      }
      if (url.pathname === "/v1/rpc/auth.setup.claim") {
        // No display name: the Host derives one from the address.
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "alex@example.com",
          kind: "password",
          password,
        });
        authenticated = true;
        return json({ session: authenticatedSession() });
      }
      if (!authenticated) return json({ error: unauthorizedError() }, 401);
      return json(bootstrap([]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });

    await client.load();
    expect(client.getSnapshot().session).toBe("authentication-required");

    await client.rpc["auth.setup.exchange"]({ token: setupToken });
    await client.rpc["auth.setup.claim"]({ email: "alex@example.com", kind: "password", password });
    await client.refresh();

    expect(client.getSnapshot()).toMatchObject({
      connection: "connecting",
      session: "authenticated",
    });
    // Claiming is a single call, so there is no window in which the account
    // exists while the Host is still unclaimed.
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/rpc/bootstrap.get",
      "/v1/rpc/auth.config",
      "/v1/rpc/auth.setup.exchange",
      "/v1/rpc/auth.setup.claim",
      "/v1/rpc/bootstrap.get",
    ]);
    expect(requests.every((request) => request.credentials === "include")).toBe(true);
    expect(JSON.stringify(client)).not.toContain(setupToken);
    expect(JSON.stringify(client)).not.toContain(password);
    client.dispose();
  });

  it("re-reads a Host session that was restored outside the client", async () => {
    let authenticated = false;
    const paths: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/v1/rpc/auth.config") {
        return json({
          deployment: { kind: "personal" as const, name: null },
          emailDeliveryAvailable: false,
          exposure: "networked",
          localPasswordEnabled: false,
          machineOwner: false,
          oidcProviders: [{ id: "workos", label: "SSO", type: "oidc" }],
          passkeysEnabled: false,
          portalOrigin: null,
          publicOrigin: "https://opensteer.example",
          setupState: "complete",
          signupPolicy: "invite-only",
        });
      }
      if (!authenticated) return json({ error: unauthorizedError() }, 401);
      return json(bootstrap([]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });

    await client.load();
    expect(client.getSnapshot().session).toBe("authentication-required");

    // Desktop main opened a Host session of its own; the latched client stopped
    // polling, so only an explicit re-authentication can observe it.
    authenticated = true;
    await client.reauthenticate();

    expect(client.getSnapshot()).toMatchObject({
      connection: "connecting",
      session: "authenticated",
    });
    expect(paths).toEqual([
      "/v1/rpc/bootstrap.get",
      "/v1/rpc/auth.config",
      "/v1/rpc/bootstrap.get",
    ]);
    client.dispose();
  });

  it("sends the execution tuple it was given and remembers it after, without waiting for that", async () => {
    const remembering = Promise.withResolvers<void>();
    let held = remembering.promise;
    const workspace = makeDeployment("Placement work");
    const localEnvironmentId = createId("environment");
    const localRunnerId = createId("runner");
    const codexHarnessId = createId("harnessInstance");
    const payload = {
      ...bootstrap([workspace]),
      environments: [
        {
          can: { executeTasks: true },
          capabilities: ["filesystem"],
          connected: true,
          harnessAuthenticationAllowed: true,

          harnessCatalogs: [
            {
              continuationIdentity: {
                continuationKey: "runner:v1:XBFO4gDBdSg2fXioCLyTd-RGpc_Zcz838BvyfVUY5d0",
                driverKind: "claude",
              },
              driverKind: "claude",
              harnessInstanceId: codexHarnessId,
              models: [
                {
                  displayName: "Claude Sonnet",
                  isDefault: true,
                  modelId: "sonnet",
                  options: [],
                  providerId: "anthropic",
                },
              ],
              status: "ready",
            },
          ],
          harnessDrivers: [
            {
              accessModes: [...ThreadAccessModeSchema.options],
              driverKind: "claude",
              readiness: "runtime-check" as const,
              sources: [
                {
                  fields: [],
                  kind: "first-party",
                  label: "Anthropic",
                  quota: "none",
                  sourceId: "anthropic",
                  stateKinds: ["ambient", "isolated"],
                },
              ],
            },
          ],
          providerStateModes: ["ambient", "isolated"] as const,
          id: localEnvironmentId,
          kind: "local" as const,
          name: "Alex’s Mac",
          runnerId: localRunnerId,
          status: "connected" as const,
        },
        {
          can: { executeTasks: true },
          capabilities: ["filesystem"],
          connected: true,
          harnessAuthenticationAllowed: true,

          harnessCatalogs: [codexCatalog(harnessInstanceId)],
          harnessDrivers: [
            {
              accessModes: [...ThreadAccessModeSchema.options],
              driverKind: "codex",
              readiness: "runtime-check" as const,
              sources: [
                {
                  fields: [],
                  kind: "first-party",
                  label: "OpenAI",
                  quota: "windows",
                  sourceId: "openai",
                  stateKinds: ["ambient", "isolated"],
                },
              ],
            },
          ],
          providerStateModes: ["ambient", "isolated"] as const,
          id: environmentId,
          kind: "main" as const,
          name: "Main runner",
          runnerId,
          status: "connected" as const,
        },
      ],
      harnesses: [
        {
          config: { model: "gpt-5.6-sol" },
          driverKind: "codex",
          enabled: true,
          environmentId,
          id: harnessInstanceId,
          isDefault: true,
          name: "Codex",
          runtimeRevision: 1,
          sourceId: "openai",
          stateKind: "ambient" as const,
        },
        {
          config: {},
          driverKind: "claude",
          enabled: true,
          environmentId: localEnvironmentId,
          id: codexHarnessId,
          isDefault: true,
          name: "Claude Code",
          runtimeRevision: 1,
          sourceId: "anthropic",
          stateKind: "ambient" as const,
        },
      ],
    };
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(payload);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
        environmentId: Thread["environmentId"];
        harnessInstanceId: Thread["harnessInstanceId"];
        modelSelection: Thread["modelSelection"];
        selection?: ExecutionSelection;
      };
      bodies.push(body);
      if (body.type === "execution.preferences.remember") {
        // Held open: the new Thread is the person's to see, not this.
        await held;
        return json({
          preferences: {
            accessMode: body.accessMode ?? "auto",
            history: body.selection ? [body.selection] : [],
          },
        });
      }
      return json(
        {
          thread: {
            ...makeThread(workspace.id),
            environmentId: body.environmentId,
            harnessInstanceId: body.harnessInstanceId,
            modelSelection: body.modelSelection,
          },
          wasDuplicate: false,
        },
        201,
      );
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });
    await client.load();

    const modelSelection = ModelSelectionSchema.parse({
      modelId: "sonnet",
      options: {},
      providerId: "anthropic",
    });
    await client.createThread({
      accessMode: "full-access",
      environmentId: localEnvironmentId,
      harnessInstanceId: codexHarnessId,
      modelSelection,
    });
    remembering.resolve();
    await vi.waitFor(
      () => expect(client.getSnapshot().executionPreferences.history).toHaveLength(1),
      { timeout: 1_000 },
    );

    expect(bodies).toEqual([
      expect.objectContaining({
        accessMode: "full-access",
        environmentId: localEnvironmentId,
        harnessInstanceId: codexHarnessId,
        modelSelection,
        type: "thread.create",
      }),
      expect.objectContaining({
        accessMode: "full-access",
        selection: {
          environmentId: localEnvironmentId,
          harnessInstanceId: codexHarnessId,
          modelSelection,
        },
        type: "execution.preferences.remember",
      }),
    ]);
    expect(client.getSnapshot().executionPreferences).toEqual({
      accessMode: "full-access",
      history: [
        { environmentId: localEnvironmentId, harnessInstanceId: codexHarnessId, modelSelection },
      ],
    });

    bodies.length = 0;
    await client.createThread({
      accessMode: "full-access",
      environmentId: localEnvironmentId,
      harnessInstanceId: codexHarnessId,
      modelSelection,
    });
    await vi.waitFor(() => expect(bodies).toHaveLength(2), { timeout: 1_000 });
    expect(bodies).toEqual([
      expect.objectContaining({ type: "thread.create" }),
      expect.objectContaining({
        selection: {
          environmentId: localEnvironmentId,
          harnessInstanceId: codexHarnessId,
          modelSelection,
        },
      }),
    ]);
    expect(bodies[1]).toMatchObject({
      accessMode: "full-access",
      type: "execution.preferences.remember",
    });

    // A choice made while a new Thread's remember is still out goes after it,
    // so the earlier one cannot land last and take the choice back.
    const late = Promise.withResolvers<void>();
    held = late.promise;
    bodies.length = 0;
    await client.createThread({
      accessMode: "full-access",
      environmentId: localEnvironmentId,
      harnessInstanceId: codexHarnessId,
      modelSelection,
    });
    const chosen = client.rememberExecution({ accessMode: "auto" });
    await vi.waitFor(() => expect(bodies).toHaveLength(2), { timeout: 1_000 });
    held = Promise.resolve();
    late.resolve();
    await chosen;
    expect(bodies.map((body) => body.accessMode ?? null)).toEqual([
      "full-access",
      "full-access",
      "auto",
    ]);
    expect(client.getSnapshot().executionPreferences.accessMode).toBe("auto");
    client.dispose();
  });

  it("rejects a bootstrap response without the required work location status", async () => {
    const workspace = makeDeployment("Strict contract");
    const attached = bootstrap([workspace]);
    const invalid = {
      ...attached,
      environments: attached.environments.map(({ status: _status, ...environment }) => environment),
    };
    const client = createHttpHostClient({
      fetch: async () => json(invalid),
      webSocketFactory: () => new FakeSocket(),
    });

    await expect(client.load()).rejects.toThrow(/incompatible response/u);
    client.dispose();
  });

  it("takes the Host's word on who may sign in a work location, over the instance role", async () => {
    const workspace = makeDeployment("Bound cloud");
    const attached = bootstrap([workspace]);
    const payload = {
      ...attached,
      environments: [
        // Bound to this person: theirs to sign in even though the Host says
        // they are not an instance administrator.
        {
          ...attached.environments[0],
          harnessAuthenticationAllowed: true,

          id: createId("environment"),
          kind: "managed" as const,
          name: "Their managed Runner",
        },
        // Someone else's, on the same instance.
        {
          ...attached.environments[0],
          harnessAuthenticationAllowed: false,

          id: createId("environment"),
          kind: "managed" as const,
          name: "Another managed Runner",
        },
      ],
      user: { ...attached.user },
    };
    const client = createHttpHostClient({
      fetch: async () => json(payload),
      webSocketFactory: () => new FakeSocket(),
    });

    await client.load();

    expect(
      client.getSnapshot().environments.map(({ harnessAuthenticationAllowed, name }) => ({
        harnessAuthenticationAllowed,
        name,
      })),
    ).toEqual([
      { harnessAuthenticationAllowed: true, name: "Their managed Runner" },
      { harnessAuthenticationAllowed: false, name: "Another managed Runner" },
    ]);
    client.dispose();
  });

  it("rejects a bootstrap response without an explicit sign-in permission", async () => {
    const workspace = makeDeployment("Strict permission");
    const attached = bootstrap([workspace]);
    const invalid = {
      ...attached,
      environments: attached.environments.map(
        ({ harnessAuthenticationAllowed: _allowed, ...environment }) => environment,
      ),
    };
    const client = createHttpHostClient({
      fetch: async () => json(invalid),
      webSocketFactory: () => new FakeSocket(),
    });

    await expect(client.load()).rejects.toThrow(/incompatible response/u);
    client.dispose();
  });

  it("remembers the account and model a Thread was moved onto", async () => {
    const workspace = makeDeployment("Switch account");
    const thread = makeThread(workspace.id);
    const otherHarnessId = createId("harnessInstance");
    const sockets: FakeSocket[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
        selection?: ExecutionSelection;
      };
      bodies.push(body);
      if (body.type === "execution.preferences.remember") {
        return json({
          preferences: { accessMode: "auto", history: body.selection ? [body.selection] : [] },
        });
      }
      return json({
        thread: { ...thread, harnessInstanceId: otherHarnessId },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    const updated = await client.updateThreadExecution(thread.id, {
      harnessInstanceId: otherHarnessId,
      modelSelection: thread.modelSelection,
    });

    expect(updated.harnessInstanceId).toBe(otherHarnessId);
    expect(bodies.map((body) => body.type)).toEqual([
      "thread.execution.update",
      "execution.preferences.remember",
    ]);
    // The Thread keeps its own work location; only the account and model move.
    expect(bodies[1]?.selection).toEqual({
      environmentId: thread.environmentId,
      harnessInstanceId: otherHarnessId,
      modelSelection: thread.modelSelection,
    });
    expect(client.getSnapshot().executionPreferences.history).toHaveLength(1);
    client.dispose();
  });

  it("keeps a Thread mutation that succeeded when remembering it fails", async () => {
    const workspace = makeDeployment("Quiet remember");
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.type === "execution.preferences.remember") {
        return json({ error: { code: "internal", message: "no", retryable: true } }, 500);
      }
      return json({ thread: { ...thread, accessMode: "approval-required" } });
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });

    await expect(client.updateThreadAccess(thread.id, "approval-required")).resolves.toMatchObject({
      accessMode: "approval-required",
    });
    expect(client.getSnapshot().executionPreferences).toEqual(emptyExecutionPreferences);
    client.dispose();
  });

  it("reads a bootstrap without remembered choices as nothing remembered", async () => {
    const workspace = makeDeployment("Older Host");
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => new FakeSocket(),
    });

    await client.load();

    expect(client.getSnapshot().executionPreferences).toEqual(emptyExecutionPreferences);
    client.dispose();
  });
});

describe("HttpHostClient harness authentication", () => {
  it("rejects an envelope without the environment status rather than guessing one", async () => {
    const fetch = vi.fn(async () =>
      json({ authentication: { status: "not-started" } }),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });

    await expect(
      client.rpc["harness.authentication.get"]({ environmentId, harnessInstanceId }),
    ).resolves.toMatchObject({ ok: false });
    client.dispose();
  });
});

describe("HttpHostClient durable realtime", () => {
  describe("ensure loaded", () => {
    function fixture() {
      const workspace = makeDeployment();
      const socket = new FakeSocket();
      const fetch = vi.fn(async () => json(bootstrap([workspace])));
      const client = createHttpHostClient({
        fetch,
        webSocketFactory: () => socket,
      });
      const synchronize = () => {
        socket.open();
        socket.receive({ type: "host.snapshot", snapshot: deploymentSnapshot(workspace, "0") });
        socket.receive({ type: "host.synchronized", sequence: sequence("0") });
      };
      return { client, fetch, socket, synchronize };
    }

    it("reuses a live snapshot while explicit refresh and reauthentication still read", async () => {
      const f = fixture();
      try {
        await f.client.load();
        f.synchronize();
        expect(f.client.getSnapshot().connection).toBe("connected");
        expect(f.fetch).toHaveBeenCalledTimes(1);

        await f.client.load();
        await f.client.load();
        expect(f.fetch).toHaveBeenCalledTimes(1);

        await f.client.refresh();
        expect(f.fetch).toHaveBeenCalledTimes(2);
        await f.client.reauthenticate();
        expect(f.fetch).toHaveBeenCalledTimes(3);
      } finally {
        f.client.dispose();
      }
    });

    it.each(["connecting", "subscribing", "disconnected"])(
      "rereads on load while the channel is %s",
      async (state) => {
        const f = fixture();
        try {
          await f.client.load();
          if (state === "subscribing") f.socket.open();
          if (state === "disconnected") {
            f.synchronize();
            f.socket.serverClose();
          }
          await f.client.load();
          expect(f.fetch).toHaveBeenCalledTimes(2);
        } finally {
          f.client.dispose();
        }
      },
    );

    it.each(["initial", "live"])("retries load after a %s bootstrap failure", async (state) => {
      const f = fixture();
      try {
        if (state === "live") {
          await f.client.load();
          f.synchronize();
        }
        const reads = f.fetch.mock.calls.length;
        f.fetch.mockRejectedValueOnce(new TypeError("Network request failed"));
        const reading = state === "initial" ? f.client.load() : f.client.refresh();
        await Promise.all([
          expect(reading).rejects.toThrow("The Host could not be reached."),
          expect(f.client.load()).rejects.toThrow("The Host could not be reached."),
        ]);

        await f.client.load();
        expect(f.fetch).toHaveBeenCalledTimes(reads + 2);
        expect(f.client.getSnapshot().session).toBe("authenticated");
        if (state === "live") {
          await f.client.load();
          expect(f.fetch).toHaveBeenCalledTimes(reads + 2);
        }
      } finally {
        f.client.dispose();
      }
    });
  });

  it("routes viewer-wide history notices to the history cache", async () => {
    const workspace = makeDeployment();
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => socket,
    });
    try {
      await client.load();
      socket.open();
      socket.receive({ snapshot: deploymentSnapshot(workspace, "0"), type: "host.snapshot" });
      const changed = vi.spyOn(client.browserHistory, "changed");
      const profileId = createId("browserProfile");
      socket.receive({ type: "host.browser-history-changed", profileId });
      expect(changed).toHaveBeenCalledExactlyOnceWith(profileId);
    } finally {
      client.dispose();
    }
  });

  it("refreshes only retained schedule anchors for worker control events without loading flashes", async () => {
    const workspace = makeDeployment();
    const unrelated = makeThread(workspace.id);
    let worker = { ...makeThread(workspace.id), listed: false };
    const mock = new MockHostClient({ latencyMs: 0 });
    const listed = await mock.rpc["triggers.list"]({});
    if (!listed.ok) throw new Error("Missing schedule fixture");
    const seed = listed.data.triggers[0]!;
    const got = await mock.rpc["triggers.get"]({ triggerId: seed.id });
    if (!got.ok) throw new Error("Missing detail fixture");
    const otherWorker = makeThread(workspace.id);
    const other = { ...seed, id: createId("trigger"), anchorThreadId: otherWorker.id };
    const summary = { ...seed, anchorThreadId: worker.id, systemRole: "memory-light" as const };
    const reads = { list: 0, worker: 0, other: 0 };
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 1,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/rpc/triggers.list") {
          reads.list++;
          return json({ triggers: [summary, other] });
        }
        if (url.pathname === "/v1/rpc/triggers.get") {
          const isOther = rpcPayload(url, init).triggerId === other.id;
          if (isOther) reads.other++;
          else reads.worker++;
          return json({
            ...got.data,
            trigger: { ...got.data.trigger, ...(isOther ? other : summary) },
            anchorThread: isOther ? otherWorker : worker,
          });
        }
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const stops: (() => void)[] = [];
    try {
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [unrelated] },
      });
      socket.receive({
        type: "host.synchronized",

        sequence: sequence("0"),
      });
      expect(reads).toEqual({ list: 0, worker: 0, other: 0 });
      const store = schedulesClient(client);
      const detail = store.detail(summary.id);
      const otherDetail = store.detail(other.id);
      const states: string[] = [];
      stops.push(
        store.list.subscribe(() => states.push(store.list.getSnapshot().status)),
        detail.subscribe(() => states.push(detail.getSnapshot().status)),
        otherDetail.subscribe(() => {}),
      );
      await vi.waitFor(
        () => {
          expect(store.list.getSnapshot().status).toBe("ready");
          expect(detail.getSnapshot().status).toBe("ready");
          expect(otherDetail.getSnapshot().status).toBe("ready");
        },
        { timeout: 1000 },
      );
      expect(reads).toEqual({ list: 1, worker: 1, other: 1 });
      states.length = 0;
      const state = (thread: Thread, at: string) =>
        agentEvent(workspace.id, thread.id, null, at, "thread.state-changed", {
          status: thread.status,
          doneAt: thread.doneAt,
          inputQueuePaused: thread.inputQueuePaused,
          pendingRequests: 0,
        });
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [state({ ...unrelated, status: "running" }, "1")],
        }),
      );
      expect(reads).toEqual({ list: 1, worker: 1, other: 1 });
      for (const [index, patch] of [
        { doneAt: "2026-11-03T10:00:00Z" },
        { doneAt: null },
        { inputQueuePaused: true },
        { status: "running" as const },
        {
          modelSelection: ModelSelectionSchema.parse({
            ...worker.modelSelection,
            modelId: "another",
          }),
        },
      ].entries()) {
        worker = { ...worker, ...patch };
        const at = String(index + 2);
        socket.receive(
          eventsFrame({
            type: "host.events",
            events: [
              "modelSelection" in patch
                ? agentEvent(workspace.id, worker.id, null, at, "thread.execution-updated", {
                    thread: worker,
                  })
                : state(worker, at),
            ],
          }),
        );
        await vi.waitFor(
          () => {
            expect(reads).toEqual({ list: index + 2, worker: index + 2, other: 1 });
            expect(detail.getSnapshot().data?.definition.anchorThread).toMatchObject(patch);
          },
          { timeout: 1000 },
        );
      }
      expect(states).not.toContain("loading");
      socket.receive({ type: "host.triggers-changed" });
      await vi.waitFor(() => expect(reads).toEqual({ list: 7, worker: 7, other: 2 }), {
        timeout: 1000,
      });
      socket.receive(eventsFrame({ type: "host.events", events: [state(worker, "7")] }));
      expect(reads).toEqual({ list: 7, worker: 7, other: 2 });
      expect(client.getSnapshot().threads.some(({ id }) => id === worker.id)).toBe(false);
      await vi.waitFor(() => expect(otherDetail.getSnapshot().status).toBe("ready"), {
        timeout: 1000,
      });
      socket.serverClose();
      await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 1000 });
      sockets[1]!.open();
      sockets[1]!.receive({
        type: "host.synchronized",

        sequence: sequence("7"),
      });
      await vi.waitFor(() => expect(reads).toEqual({ list: 8, worker: 8, other: 3 }), {
        timeout: 1000,
      });
    } finally {
      for (const stop of stops) stop();
      client.dispose();
      mock.dispose();
    }
  });

  it("invalidates Trigger reads when a program-only occurrence changes", async () => {
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const listener = vi.fn();
    client.subscribe(listener);

    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({ snapshot: deploymentSnapshot(workspace, "0"), type: "host.snapshot" });
    const before = client.getSnapshot().triggerRevision;
    sockets[0]!.receive({ type: "host.triggers-changed" });

    expect(client.getSnapshot().triggerRevision).toBe(before + 1);
    expect(listener).toHaveBeenCalled();
    const hidden = { ...makeThread(workspace.id), listed: false };
    const events = [
      agentEvent(workspace.id, hidden.id, null, "1", "thread.state-changed", {
        status: "idle",
        inputQueuePaused: false,
        pendingRequests: 0,
        doneAt: "2026-11-03T10:00:00Z",
      }),
      agentEvent(workspace.id, hidden.id, null, "2", "thread.input-queue-updated", {
        paused: true,
      }),
      agentEvent(workspace.id, hidden.id, null, "3", "thread.execution-updated", {
        thread: hidden,
      }),
    ];
    sockets[0]!.receive(eventsFrame({ type: "host.events", events }));
    expect(client.getSnapshot().triggerRevision).toBe(before + 1);
    expect(client.getSnapshot().threads.some(({ id }) => id === hidden.id)).toBe(false);
    client.dispose();
  });

  it.each([true, false])(
    "holds every open child however long the history, without paging settled history (family %s)",
    async (family) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const mock = new MockHostClient({ latencyMs: 0 });
      const seed = Object.values(mock.getSnapshot().assignments)[0]!;
      const older = {
        ...seed,
        status: "open" as const,
        finishedAt: null,
        parentThreadId: thread.id,
      };
      const recent = Array.from({ length: 100 }, () => ({
        ...older,
        id: createId("delegation"),
        status: "completed" as const,
        finishedAt: now,
      }));
      const reads: { readonly open: unknown; readonly before: unknown }[] = [];
      const client = createHttpHostClient({
        capabilities: family ? ["task-family-v1"] : [],
        webSocketFactory: () => new FakeSocket(),
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/v1/rpc/thread.assignments.list") {
            const payload = rpcPayload(url, init);
            reads.push({ open: payload.open, before: payload.before });
            // The open set spans two pages; history has more than the newest page.
            const assignments = payload.open ? (payload.before ? [older] : []) : recent;
            const more = payload.open ? !payload.before : true;
            return json({
              assignments,
              threadId: thread.id,
              window: {
                byteCount: 1,
                hasMore: more,
                itemCount: assignments.length,
                nextBefore: more ? "older" : null,
                totalItems: 101,
              },
            });
          }
          return json({ ...bootstrap([workspace]) });
        },
      });
      await client.load();
      client.observeThread(thread.id);
      await vi.waitFor(() => expect(reads).toHaveLength(family ? 3 : 1), { timeout: 1000 });
      await vi.waitFor(
        () =>
          expect(Object.keys(client.getSnapshot().assignments)).toHaveLength(family ? 101 : 100),
        { timeout: 1000 },
      );
      expect(reads.filter(({ open }) => open === undefined)).toEqual([
        { open: undefined, before: undefined },
      ]);
      expect(client.getSnapshot().assignments[older.id] !== undefined).toBe(family);
      client.dispose();
      mock.dispose();
    },
  );

  it.each([true, false])(
    "loads task automations only with capability (%s), coalescing notices and preserving unchanged arrays",
    async (enabled) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const socket = new FakeSocket();
      const mock = new MockHostClient({ latencyMs: 0 });
      const listed = await mock.rpc["triggers.list"]({});
      if (!listed.ok) throw new Error(listed.error.message);
      const triggers = listed.data.triggers
        .filter((t) => t.kind === "schedule" && t.status === "active")
        .slice(0, 1);
      let reads = 0;
      let hold: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
      const client = createHttpHostClient({
        capabilities: enabled ? ["task-family-v1"] : [],
        webSocketFactory: () => socket,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/v1/rpc/triggers.list") {
            reads++;
            expect(rpcPayload(url, init)).toEqual({ anchorThreadId: thread.id });
            return hold ? hold.promise : json({ triggers });
          }
          return json(bootstrap([workspace]));
        },
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      });
      client.observeThread(thread.id);
      if (!enabled) {
        socket.receive({ type: "host.triggers-changed" });
        await client.refresh();
        expect(reads).toBe(0);
      } else {
        await vi.waitFor(
          () => expect(client.getSnapshot().threadAutomations[thread.id]).toHaveLength(1),
          { timeout: 1000 },
        );
        const held = client.getSnapshot().threadAutomations[thread.id];
        hold = Promise.withResolvers<Response>();
        socket.receive({ type: "host.triggers-changed" });
        socket.receive({ type: "host.triggers-changed" });
        socket.receive({ type: "host.triggers-changed" });
        expect(reads).toBe(2);
        const answer = hold;
        hold = undefined;
        answer.resolve(json({ triggers }));
        await vi.waitFor(() => expect(reads).toBe(3), { timeout: 1000 });
        expect(client.getSnapshot().threadAutomations[thread.id]).toBe(held);
        socket.receive({
          type: "host.snapshot",
          snapshot: { ...deploymentSnapshot(workspace, "1"), threads: [thread] },
        });
        await vi.waitFor(() => expect(reads).toBe(4), { timeout: 1000 });
      }
      client.dispose();
      mock.dispose();
    },
  );

  it("reads a conversation's automations afresh when it is opened again, after a failure, and after a replayed reconnect", async () => {
    const workspace = makeDeployment();
    const a = makeThread(workspace.id);
    const b = makeThread(workspace.id);
    const mock = new MockHostClient({ latencyMs: 0 });
    const listed = await mock.rpc["triggers.list"]({});
    if (!listed.ok) throw new Error(listed.error.message);
    const trigger = listed.data.triggers.find((t) => t.kind === "schedule")!;
    const reads: string[] = [];
    let fail = false;
    let gate: Promise<void> | null = null;
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      capabilities: ["task-family-v1"],
      random: () => 0,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/rpc/triggers.list") {
          const anchor = String(rpcPayload(url, init).anchorThreadId);
          reads.push(anchor);
          if (gate !== null && anchor === a.id) {
            const held = gate;
            gate = null;
            await held;
          }
          if (fail) return json({ error: { code: "internal", message: "down" } }, 500);
          // Named for the read that answered, so a test can see which one it holds.
          return json({
            triggers:
              anchor === a.id
                ? [{ ...trigger, anchorThreadId: a.id, name: `Read ${reads.length}` }]
                : [],
          });
        }
        return json(bootstrap([workspace]));
      },
    });
    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({
      type: "host.snapshot",
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [a, b] },
    });
    sockets[0]!.receive({
      sequence: sequence("0"),
      type: "host.synchronized",
    });
    const held = () => client.getSnapshot().threadAutomations[a.id]?.[0]?.name;
    const holds = async (name: string) =>
      vi.waitFor(() => expect(held(), `holds ${name}`).toBe(name), { timeout: 1000 });

    client.activateThread(a.id);
    await holds("Read 1");
    // Opened again after another conversation: read afresh.
    client.activateThread(b.id);
    client.activateThread(a.id);
    await vi.waitFor(() => expect(held()).toMatch(/^Read [2-9]/u), { timeout: 1000 });

    // A failed read keeps what was held and is retried when it is opened again.
    const readsOfA = () => reads.filter((id) => id === a.id).length;
    const beforeFailure = readsOfA();
    fail = true;
    client.activateThread(b.id);
    client.activateThread(a.id);
    await vi.waitFor(() => expect(readsOfA(), "the failing read").toBe(beforeFailure + 1), {
      timeout: 1000,
    });
    const failed = reads.length;
    expect(held()).toMatch(/^Read /u);
    fail = false;
    await vi.waitFor(
      () => {
        client.activateThread(b.id);
        client.activateThread(a.id);
        expect(Number(held()?.slice(5))).toBeGreaterThan(failed);
      },
      { timeout: 1000 },
    );

    // Opened again while a read from before is still out: that answer may
    // predate a change made meanwhile, so one more read follows it.
    const release = Promise.withResolvers<void>();
    gate = release.promise;
    const beforeReopen = readsOfA();
    client.activateThread(b.id);
    client.activateThread(a.id);
    await vi.waitFor(() => expect(readsOfA(), "the held read").toBe(beforeReopen + 1), {
      timeout: 1000,
    });
    client.activateThread(b.id);
    client.activateThread(a.id);
    release.resolve();
    await vi.waitFor(() => expect(readsOfA(), "the read after it").toBe(beforeReopen + 2), {
      timeout: 1000,
    });

    // A triggers notice lost while away is recovered when the stream replays.
    const before = held();
    sockets[0]!.serverClose();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 1000 });
    sockets[1]!.open();
    sockets[1]!.receive({
      sequence: sequence("0"),
      type: "host.synchronized",
    });
    await vi.waitFor(() => expect(held()).not.toBe(before), { timeout: 1000 });
    client.dispose();
    mock.dispose();
  });

  it("loads browser history without live sessions and preserves other scopes across bootstrap", async () => {
    const workspace = makeDeployment();
    const sessionId = createBrowserSessionId();
    const a = createId("thread");
    const b = createId("thread");
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith("thread.browserUsage.get")) {
        const payload = rpcPayload(url, init);
        expect((payload.runIds as unknown[]).length).toBeLessThanOrEqual(16);
        return json({
          threadId: payload.threadId,
          uses: [
            {
              sessionId,
              threadId: payload.threadId,
              runId: null,
              tabId: null,
              firstUsedAt: now,
              lastUsedAt: now,
            },
          ],
        });
      }
      return json(
        bootstrap([workspace], {
          available: true,
          placements: [],
          profiles: [],
        }),
      );
    };
    const client = createHttpHostClient({
      fetch,
      browserUsageReads: "observed",
    });
    await client.load();
    client.activateThread(a);
    await vi.waitFor(() =>
      expect(client.getSnapshot().browserUses?.some((use) => use.threadId === a)).toBe(true),
    );
    client.activateThread(b);
    await vi.waitFor(() =>
      expect(client.getSnapshot().browserUses?.some((use) => use.threadId === b)).toBe(true),
    );
    await client.refresh();
    expect(
      client
        .getSnapshot()
        .browserUses?.map((use) => use.threadId)
        .sort(),
    ).toEqual([a, b].sort());
    client.dispose();
  });

  it("carries one count-only summary after repeated loads recreate the client", async () => {
    const diagnostics = new BootstrapReadDiagnostics();
    const trigger = vi
      .spyOn(bootstrapReadDiagnostics, "trigger")
      .mockImplementation(diagnostics.trigger.bind(diagnostics));
    const start = vi
      .spyOn(bootstrapReadDiagnostics, "start")
      .mockImplementation(diagnostics.start.bind(diagnostics));
    const take = vi
      .spyOn(bootstrapReadDiagnostics, "takeSummary")
      .mockImplementation(diagnostics.takeSummary.bind(diagnostics));
    const summaries: (string | null)[] = [];
    try {
      for (let index = 0; index < 12; index++) {
        const client = createHttpHostClient({
          webSocketFactory: () => new FakeSocket(),
          fetch: async (input, init) => {
            const request = new Request(input, init);
            if (new URL(request.url).pathname.endsWith("bootstrap.get"))
              summaries.push(request.headers.get(bootstrapDiagnosticHeader));
            return json(bootstrap([]));
          },
        });
        try {
          await client.load();
        } finally {
          client.dispose();
        }
      }
      expect(summaries).toHaveLength(12);
      expect(summaries.filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(summaries[5]!)).toEqual({
        windowMs: expect.any(Number),
        triggers: { load: 6 },
        starts: { load: 6 },
      });
      expect(summaries.slice(0, 5)).toEqual(Array(5).fill(null));
      expect(summaries.slice(6)).toEqual(Array(6).fill(null));
    } finally {
      trigger.mockRestore();
      start.mockRestore();
      take.mockRestore();
    }
  });

  it.each(["host.browser-sessions-changed", "host.machines.changed"] as const)(
    "refreshes thread-visible bootstrap state on %s without a mounted Computers page",
    async (noticeType) => {
      const workspace = makeDeployment();
      const sockets: FakeSocket[] = [];
      // The agent's browser is only on the second read: the announcement is what
      // brings it forward, not the poll.
      let opened = false;
      const fetch = vi.fn(async () =>
        json(
          bootstrap([workspace], {
            available: true,
            placements: [],
            profiles: opened
              ? [{ id: createId("browserProfile"), name: "Available profile", homeRunnerId: null }]
              : [],
          }),
        ),
      ) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        fetch,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });

      await client.load();
      sockets[0]!.open();
      sockets[0]!.receive({ snapshot: deploymentSnapshot(workspace, "0"), type: "host.snapshot" });
      expect(client.getSnapshot().browserSessions).toEqual([]);

      opened = true;
      sockets[0]!.receive({
        type: noticeType,
      });
      await vi.waitUntil(() => client.getSnapshot().browserProfiles.length === 1);

      expect(client.getSnapshot().browserProfiles[0]?.name).toBe("Available profile");
      client.dispose();
    },
  );

  it("refreshes the engine catalog after an older bootstrap has finished", async () => {
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    const client = createHttpHostClient({
      webSocketFactory: () => new FakeSocket(),
      fetch: async () => {
        reads += 1;
        if (reads !== 2) return json(bootstrap([]));
        // A read taken after catalog discard but before inspection commits.
        const stale = bootstrap([]);
        stale.environments[0]!.harnessCatalogs = [];
        return new Promise<Response>((resolve) => {
          release = () => resolve(json(stale));
          entered();
        });
      },
    });
    try {
      await client.load();
      const olderRead = client.load();
      await withTimeout(reading, 1_000, {
        timeoutError: () =>
          new Error("The overlapping bootstrap did not reach its stale catalog read"),
      });
      // The CLI inspection has now committed. Its caller needs a new read,
      // even though the earlier bootstrap has not delivered its answer yet.
      const refreshed = client.refresh();
      release();
      await Promise.all([olderRead, refreshed]);
      expect(client.getSnapshot().environments[0]?.harnessCatalogs[0]?.status).toBe("ready");
      expect(reads).toBe(3);
    } finally {
      client.dispose();
    }
  });

  it("answers a notice that lands mid-read with exactly one more read", async () => {
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    // Every read waits until the test releases it, so a notice can arrive
    // while one is still in flight. The Host's truth advances per read:
    // nothing, then starting, then ready.
    const releases: (() => void)[] = [];
    let reads = 0;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          reads += 1;
          const read = reads;
          releases.push(() =>
            resolve(
              json(
                bootstrap([workspace], {
                  available: true,
                  placements: [],
                  profiles:
                    read >= 2
                      ? [
                          {
                            id: createId("browserProfile"),
                            name: read >= 3 ? "ready" : "starting",
                            homeRunnerId: null,
                          },
                        ]
                      : [],
                }),
              ),
            ),
          );
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const loaded = client.load();
    await vi.waitUntil(() => releases.length === 1);
    releases.shift()!();
    await loaded;
    sockets[0]!.open();
    sockets[0]!.receive({ snapshot: deploymentSnapshot(workspace, "0"), type: "host.snapshot" });

    const triggers = vi.spyOn(bootstrapReadDiagnostics, "trigger");
    const starts = vi.spyOn(bootstrapReadDiagnostics, "start");
    // Starting: one read begins. Ready lands twice while it is still out.
    sockets[0]!.receive({ type: "host.browser-sessions-changed" });
    await vi.waitUntil(() => releases.length === 1);
    sockets[0]!.receive({ type: "host.browser-sessions-changed" });
    sockets[0]!.receive({ type: "host.browser-sessions-changed" });
    expect(reads).toBe(2);

    releases.shift()!();
    await vi.waitUntil(() => client.getSnapshot().browserProfiles[0]?.name === "starting");
    // The two notices that arrived mid-read collapse into one follow-up read.
    await vi.waitUntil(() => releases.length === 1);
    expect(reads).toBe(3);
    releases.shift()!();
    await vi.waitUntil(() => client.getSnapshot().browserProfiles[0]?.name === "ready");

    await vi.waitFor(() => expect(reads).toBe(3));
    expect(reads).toBe(3);
    expect(triggers.mock.calls.map(([reason]) => reason)).toEqual([
      "host.browser-sessions-changed",
      "host.browser-sessions-changed",
      "host.browser-sessions-changed",
    ]);
    expect(starts.mock.calls.map(([reason]) => reason)).toEqual([
      "host.browser-sessions-changed",
      "host.browser-sessions-changed",
    ]);
    triggers.mockRestore();
    starts.mockRestore();
    client.dispose();
  });

  it("leaves a notice for the foreground while the app is hidden", async () => {
    const workspace = makeDeployment();
    const profileId = createId("browserProfile");
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    let reads = 0;
    const client = createHttpHostClient({
      fetch: async () => {
        reads += 1;
        return json(
          bootstrap([workspace], {
            available: true,
            placements: [],
            profiles: reads > 1 ? [{ id: profileId, name: "Later", homeRunnerId: null }] : [],
          }),
        );
      },
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({ snapshot: deploymentSnapshot(workspace, "0"), type: "host.snapshot" });
    expect(reads).toBe(1);

    sockets[0]!.receive({ type: "host.synchronized", sequence: sequence("0") });
    platform.enterBackground();
    sockets[0]!.receive({ type: "host.browser-sessions-changed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nobody is looking, so nothing is fetched for them.
    expect(reads).toBe(1);
    expect(client.getSnapshot().browserProfiles).toEqual([]);

    // The return already rereads; the notice needs nothing of its own.
    platform.enterForeground();
    await vi.waitUntil(() => client.getSnapshot().browserProfiles.length === 1);
    expect(reads).toBe(2);
    client.dispose();
  });

  it("restores a pending Request from a zero-cursor snapshot", async () => {
    const workspace = makeDeployment();
    const thread = {
      ...makeThread(workspace.id),
      pendingRequests: 1,
      status: "waiting" as const,
    };
    const runId = createId("run");
    const pending = pendingRequest({
      presentation: {
        fields: [
          {
            custom: false,
            id: "choice",
            multiSelect: false,
            prompt: "Which option?",
            secret: false,
          },
        ],
        kind: "form",
        title: "Input needed",
      },
      runId,
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({
      snapshot: {
        ...deploymentSnapshot(workspace, "2"),
        pendingRequests: [pending],
        pendingRequestWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([pending])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
        threads: [thread],
        threadWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([thread])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
      },
      type: "host.snapshot",
    });

    expect(client.getSnapshot().requests[thread.id]).toEqual([
      expect.objectContaining({ id: pending.id, originatingRunId: runId }),
    ]);
    client.dispose();
  });

  it("follows the pending-only Request cursor until every pending item is reachable", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), pendingRequests: 2 };
    const first = pendingRequest({
      presentation: { kind: "external", subject: { id: "one", kind: "test" }, title: "One" },
      runId: createId("run"),
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    const second = pendingRequest({
      presentation: { kind: "external", subject: { id: "two", kind: "test" }, title: "Two" },
      runId: createId("run"),
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    const requestPages: Readonly<Record<string, unknown>>[] = [];
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/thread.requests.list") {
        const request = rpcPayload(url, undefined);
        requestPages.push(request);
        const older = request.before === "request_cursor";
        return json({
          requests: [older ? second : first],
          threadId: thread.id,
          window: {
            byteCount: 256,
            hasMore: !older,
            itemCount: 1,
            nextBefore: older ? null : "request_cursor",
            totalItems: 2,
          },
        });
      }
      if (url.pathname === "/v1/rpc/thread.events.list") {
        return json({
          thread,
          events: [],
          threadId: thread.id,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 0,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 0,
          },
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]!.open();
    sockets[0]!.receive({
      snapshot: {
        ...deploymentSnapshot(workspace, "2"),
        threads: [thread],
        threadWindow: {
          byteCount: 128,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
      },
      type: "host.snapshot",
    });

    client.activateThread(thread.id);
    await vi.waitFor(() => expect(client.getSnapshot().requests[thread.id]).toHaveLength(2));

    expect(client.getSnapshot().requests[thread.id]?.map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(requestPages).toEqual([
      { limit: 100, threadId: thread.id },
      { before: "request_cursor", limit: 100, threadId: thread.id },
    ]);
    client.dispose();
  });

  it("removes a provider-cancelled Request when the canonical cancellation event arrives", async () => {
    const workspace = makeDeployment();
    const thread = {
      ...makeThread(workspace.id),
      pendingRequests: 1,
      status: "waiting" as const,
    };
    const runId = createId("run");
    const pending = pendingRequest({
      presentation: {
        detail: "Run a delegated check",
        kind: "choice",
        options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
        title: "Worker permission",
      },
      runId,
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...deploymentSnapshot(workspace, "0"),
        pendingRequests: [pending],
        pendingRequestWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([pending])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
        threads: [thread],
        threadWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify([thread])).byteLength,
          hasMore: false,
          itemCount: 1,
          nextBefore: null,
          totalItems: 1,
        },
      },
      type: "host.snapshot",
    });

    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "request.cancelled", {
            requestId: pending.id,
            reason: "source-closed",
          }),
          agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
            status: "running",
            inputQueuePaused: false,
            pendingRequests: 0,
          }),
        ],
        type: "host.events",
      }),
    );
    expect(client.getSnapshot().requests[thread.id]).toEqual([]);
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
    expect(client.getSnapshot().transcripts[thread.id]).toEqual([
      expect.objectContaining({
        kind: "request",
        outcome: "Cancelled · source-closed",
        requestId: pending.id,
      }),
    ]);
    client.dispose();
  });

  it.each([true, false])(
    "loads an older durable message window through its continuation cursor (turn pages %s)",
    async (turnPages) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const recent = makeMessage(thread.id, "assistant", "Recent");
      const internalResult: Message = {
        ...recent,
        content: [{ text: 'Delegated Thread result\n{"outcome":"completed"}', type: "text" }],
        id: createId("message"),
        kind: "run-result",
        sequence: SequenceSchema.parse("2"),
      };
      const earlier = makeMessage(thread.id, "input", "Earlier");
      const sockets: FakeSocket[] = [];
      const requestedUrls: string[] = [];
      const eventRequests: Record<string, unknown>[] = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrls.push(String(input));
        const path = new URL(String(input)).pathname;
        if (path === "/v1/rpc/thread.events.list") {
          eventRequests.push(rpcPayload(new URL(String(input)), init));
          return json({
            thread,
            events: [
              agentEvent(workspace.id, thread.id, earlier.runId, "1", "message.created", {
                input: makeThreadInput(earlier),
                message: earlier,
              }),
            ],
            threadId: thread.id,
            window: {
              byteCount: 256,
              hasMore: false,
              itemCount: 1,
              nextBefore: null,
              threadId: thread.id,
              totalItems: 2,
            },
          });
        }
        return json(bootstrap([workspace]));
      }) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        capabilities: async () => (turnPages ? ["history-turns-v1"] : []),
        fetch,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: {
          ...deploymentSnapshot(workspace, "2"),
          messages: [recent, internalResult],
          messageWindows: [
            {
              byteCount: 256,
              hasMore: true,
              itemCount: 1,
              nextBefore: "message_cursor",
              threadId: thread.id,
              totalItems: 2,
            },
          ],
          threads: [thread],
        },
        type: "host.snapshot",
      });

      await client.loadEarlierTranscript(thread.id);

      expect(
        client
          .getSnapshot()
          .transcripts[thread.id]?.filter((entry) => entry.kind === "message")
          .map((entry) => entry.body),
      ).toEqual(["Earlier", "Recent"]);
      expect(client.getSnapshot().transcriptWindows[thread.id]?.hasMore).toBe(false);
      expect(requestedUrls).toEqual(
        expect.arrayContaining([expect.stringContaining("message_cursor")]),
      );
      expect(eventRequests).toEqual([
        { before: "message_cursor", threadId: thread.id, ...(turnPages ? { turns: 10 } : {}) },
      ]);
      client.dispose();
    },
  );

  describe("earlier visible history", () => {
    async function setupHistory(
      options: {
        purpose?: "voice" | "task";
        turnPages?: boolean;
        steps?: boolean;
        emptyFirst?: boolean;
        scanLimit?: number;
        scanBytes?: number;
        exhausted?: boolean;
        stuck?: boolean;
        holdSecond?: boolean;
        holdFirst?: boolean;
        folded?: boolean;
        /** The newest page starts inside a Run a steer split, so no Run entry heads its first trace. */
        cut?: boolean;
        longScan?: boolean;
        shown?: "active" | "observed";
      } = {},
    ) {
      const workspace = makeDeployment();
      const thread = { ...makeThread(workspace.id), purpose: options.purpose ?? "voice" };
      const recent = {
        ...makeMessage(thread.id, options.folded || options.cut ? "assistant" : "input", "Recent"),
        runId: options.folded || options.cut ? createId("run") : null,
      };
      const steer = { ...makeMessage(thread.id, "input", "Steer"), runId: recent.runId };
      const earlier = makeMessage(thread.id, "input", "Earlier question");
      const reply = {
        ...makeMessage(thread.id, "assistant", "Earlier reply"),
        runId: earlier.runId,
      };
      const silentRun = createId("run");
      const silent: AgentEvent[] = [];
      const visible = [
        agentEvent(workspace.id, thread.id, earlier.runId, "1", "message.created", {
          input: makeThreadInput(earlier),
          message: earlier,
        }),
        agentEvent(workspace.id, thread.id, earlier.runId, "2", "message.created", {
          input: null,
          message: reply,
        }),
        agentEvent(workspace.id, thread.id, earlier.runId, "3", "run.completed", {
          status: "completed",
          replyMessageId: reply.id,
        }),
      ];
      const firstAsked = Promise.withResolvers<void>();
      const firstAnswer = Promise.withResolvers<void>();
      const secondAsked = Promise.withResolvers<void>();
      const secondAnswer = Promise.withResolvers<void>();
      const requests: Record<string, unknown>[] = [];
      let viewerId = ownerId;
      let warming = options.folded === true || options.cut === true || options.shown !== undefined;
      const socket = new FakeSocket();
      const client = createHttpHostClient({
        capabilities: options.turnPages === false ? [] : ["history-turns-v1"],
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname !== "/v1/rpc/thread.events.list") {
            const boot = bootstrap([workspace]);
            return json({ ...boot, user: { ...boot.user, id: viewerId } });
          }
          const request = rpcPayload(url, init);
          if (request.threadId !== thread.id)
            return json({
              thread: { ...thread, id: ThreadIdSchema.parse(request.threadId) },
              threadId: request.threadId,
              events: [],
              window: {
                byteCount: 0,
                itemCount: 0,
                totalItems: 0,
                hasMore: false,
                nextBefore: null,
                threadId: request.threadId,
              },
            });
          if (warming) {
            warming = false;
            const events = options.cut
              ? [
                  agentEvent(workspace.id, thread.id, recent.runId, "3", "reasoning.completed", {
                    blockId: "cut-step",
                    text: "Work before the steer",
                  }),
                  agentEvent(workspace.id, thread.id, recent.runId, "4", "message.created", {
                    input: makeThreadInput(steer),
                    message: steer,
                  }),
                  agentEvent(workspace.id, thread.id, recent.runId, "5", "run.completed", {
                    status: "completed",
                    replyMessageId: recent.id,
                  }),
                  agentEvent(workspace.id, thread.id, recent.runId, "6", "message.created", {
                    input: null,
                    message: recent,
                  }),
                ]
              : [
                  ...(options.folded
                    ? [
                        agentEvent(workspace.id, thread.id, recent.runId, "5", "run.completed", {
                          status: "completed",
                          replyMessageId: recent.id,
                        }),
                      ]
                    : []),
                  agentEvent(workspace.id, thread.id, recent.runId, "6", "message.created", {
                    input: null,
                    message: recent,
                  }),
                ];
            if (options.shown) {
              for (let index = 0; index < 9; index += 1) {
                const message = makeMessage(thread.id, "input", `Newer question ${index}`);
                events.push(
                  agentEvent(workspace.id, thread.id, message.runId, "6", "message.created", {
                    input: makeThreadInput(message),
                    message,
                  }),
                );
              }
            }
            return json({
              thread,
              threadId: thread.id,
              events,
              window: {
                byteCount: 0,
                itemCount: 0,
                totalItems: 6,
                threadId: thread.id,
                hasMore: true,
                nextBefore: "recent",
              },
            });
          }
          requests.push(request);
          const first = requests.length === 1;
          if (first && options.holdFirst) {
            firstAsked.resolve();
            await firstAnswer.promise;
          }
          if (requests.length === 2 && options.holdSecond) {
            secondAsked.resolve();
            await secondAnswer.promise;
          }
          const navigating = !request.before;
          const events = navigating
            ? visible
            : options.longScan && !first
              ? []
              : first
                ? options.emptyFirst
                  ? []
                  : options.steps || options.folded || options.cut
                    ? [
                        agentEvent(
                          workspace.id,
                          thread.id,
                          options.folded || options.cut ? recent.runId : silentRun,
                          "4",
                          "reasoning.completed",
                          {
                            blockId: "older-step",
                            text: "Older work without a reply",
                          },
                        ),
                      ]
                    : silent
                : options.exhausted
                  ? []
                  : visible;
          return json({
            thread,
            threadId: thread.id,
            events,
            window: {
              byteCount: options.scanBytes ?? 256,
              itemCount: events.length,
              totalItems: 6,
              threadId: thread.id,
              hasMore:
                !navigating &&
                (first ||
                  (options.longScan
                    ? requests.length < (options.scanLimit ?? 5)
                    : options.holdSecond === true)),
              nextBefore: navigating
                ? null
                : first
                  ? options.stuck
                    ? "recent"
                    : "silent"
                  : options.holdSecond || options.longScan
                    ? `oldest-${requests.length}`
                    : null,
            },
          });
        },
        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...deploymentSnapshot(workspace, "6"),
          threads: [thread],
          messages: [recent],
          messageWindows: [
            {
              byteCount: 256,
              hasMore: true,
              itemCount: 1,
              nextBefore: "recent",
              totalItems: 6,
              threadId: thread.id,
            },
          ],
        },
      });
      let release: (() => void) | undefined;
      if (warming) {
        await client.loadLatestTranscript(thread.id);
        if (options.shown === "observed") release = client.observeThread(thread.id);
        else client.activateThread(thread.id);
      }
      return {
        leave: () =>
          options.shown === "observed" ? release?.() : client.activateThread(createId("thread")),
        client,
        requests,
        thread,
        firstAsked,
        firstAnswer,
        secondAsked,
        secondAnswer,
        receiveHuman: () => {
          const live = { ...makeMessage(thread.id, "input", "Live"), sequence: sequence("7") };
          socket.receive(
            eventsFrame({
              type: "host.events",
              events: [
                agentEvent(workspace.id, thread.id, null, "7", "message.created", {
                  input: makeThreadInput(live),
                  message: live,
                }),
              ],
            }),
          );
        },
        changeViewer: async () => {
          viewerId = createId("user");
          await client.refresh();
        },
        replaceWindow: (nextBefore: string) =>
          socket.receive({
            type: "host.snapshot",
            snapshot: {
              ...deploymentSnapshot(workspace, "7"),
              threads: [thread],
              messages: [recent],
              messageWindows: [
                {
                  byteCount: 256,
                  hasMore: true,
                  itemCount: 1,
                  nextBefore,
                  totalItems: 6,
                  threadId: thread.id,
                },
              ],
            },
          }),
        removeThread: () =>
          socket.receive({ type: "host.snapshot", snapshot: deploymentSnapshot(workspace, "7") }),
      };
    }

    it.each([
      [100, 256, 20],
      [100, 700 * 1024, 3],
    ])(
      "bounds Earlier's invisible scan by pages and bytes (%s, %s)",
      async (scanLimit, scanBytes, expectedReads) => {
        const f = await setupHistory({ longScan: true, scanLimit, scanBytes });
        try {
          await f.client.loadEarlierTranscript(f.thread.id);
          expect(f.requests).toHaveLength(expectedReads);
          expect(f.client.getSnapshot().transcriptWindows[f.thread.id]?.hasMore).toBe(true);
        } finally {
          f.client.dispose();
        }
      },
    );

    it("keeps the Earlier anchor while an empty page advances its cursor", async () => {
      const f = await setupHistory({ emptyFirst: true });
      try {
        const anchor = f.client.getSnapshot().transcripts[f.thread.id]?.at(-1)?.id;
        await f.client.loadEarlierTranscript(f.thread.id);
        expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
        expect(f.client.getSnapshot().transcripts[f.thread.id]?.at(-1)?.id).toBe(anchor);
        expect(
          f.client
            .getSnapshot()
            .transcripts[f.thread.id]?.some(
              (entry) => entry.kind === "message" && entry.body === "Earlier question",
            ),
        ).toBe(true);
      } finally {
        f.client.dispose();
      }
    });

    it("does not count a live human message as older-page progress", async () => {
      const f = await setupHistory({ holdFirst: true, shown: "active" });
      try {
        const loading = f.client.loadEarlierTranscript(f.thread.id);
        await withTimeout(f.firstAsked.promise, 1000, {
          timeoutError: () => new Error("The first page was never requested."),
        });
        f.receiveHuman();
        await vi.waitFor(
          () =>
            expect(
              f.client
                .getSnapshot()
                .transcripts[f.thread.id]?.some(
                  (entry) => entry.kind === "message" && entry.body === "Live",
                ),
            ).toBe(true),
          { timeout: 1000 },
        );
        f.firstAnswer.resolve();
        await loading;
        expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
      } finally {
        f.firstAnswer.resolve();
        f.client.dispose();
      }
    });

    it.each([true, false])(
      "reads past a byte-cut page folded into the first drawn work turn (turn pages %s)",
      async (turnPages) => {
        const f = await setupHistory({ purpose: "task", folded: true, turnPages });
        try {
          await f.client.loadEarlierTranscript(f.thread.id);
          expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
        } finally {
          f.client.dispose();
        }
      },
    );

    it.each(["around", "latest"] as const)(
      "retires a long scan to load %s after its in-flight page",
      async (destination) => {
        const f = await setupHistory({ holdSecond: true, longScan: true });
        try {
          const loading = f.client.loadEarlierTranscript(f.thread.id);
          await withTimeout(f.secondAsked.promise, 1000, {
            timeoutError: () => new Error("The second page was never requested."),
          });
          const navigation =
            destination === "around"
              ? f.client.loadTranscriptAround(f.thread.id, createId("message"))
              : f.client.loadLatestTranscript(f.thread.id);
          f.secondAnswer.resolve();
          await withTimeout(Promise.all([loading, navigation]), 1000, {
            timeoutError: () => new Error("Navigation waited beyond the in-flight page."),
          });
          expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent", undefined]);
        } finally {
          f.secondAnswer.resolve();
          f.client.dispose();
        }
      },
    );

    it.each(["active", "observed"] as const)(
      "stops when the reader leaves the %s Thread",
      async (shown) => {
        const f = await setupHistory({ shown, holdSecond: true, longScan: true });
        try {
          const loading = f.client.loadEarlierTranscript(f.thread.id);
          await withTimeout(f.secondAsked.promise, 1000, {
            timeoutError: () => new Error("The second page was never requested."),
          });
          f.leave();
          const before = f.client.getSnapshot().transcripts[f.thread.id];
          f.secondAnswer.resolve();
          await loading;
          expect(f.requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
          expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(before);
        } finally {
          f.secondAnswer.resolve();
          f.client.dispose();
        }
      },
    );

    it("keeps scanning an observed Thread when another Thread becomes active", async () => {
      const f = await setupHistory({ shown: "observed", holdSecond: true, longScan: true });
      try {
        const loading = f.client.loadEarlierTranscript(f.thread.id);
        await withTimeout(f.secondAsked.promise, 1000, {
          timeoutError: () => new Error("The second page was never requested."),
        });
        f.client.activateThread(createId("thread"));
        f.secondAnswer.resolve();
        await loading;
        expect(f.requests.length).toBeGreaterThan(2);
      } finally {
        f.secondAnswer.resolve();
        f.client.dispose();
      }
    });

    it("reads past older steps that only rename a split Run's first trace", async () => {
      const { client, requests, thread } = await setupHistory({ cut: true, purpose: "task" });
      try {
        await client.loadEarlierTranscript(thread.id);
        expect(requests).toHaveLength(2);
      } finally {
        client.dispose();
      }
    });

    it("starts afresh when asked again after its scan was retired", async () => {
      const f = await setupHistory({ shown: "active", holdSecond: true, longScan: true });
      try {
        const loading = f.client.loadEarlierTranscript(f.thread.id);
        await withTimeout(f.secondAsked.promise, 1000, {
          timeoutError: () => new Error("The second page was never requested."),
        });
        f.leave();
        f.client.activateThread(f.thread.id);
        const again = f.client.loadEarlierTranscript(f.thread.id);
        f.secondAnswer.resolve();
        await Promise.all([loading, again]);
        expect(f.requests.length).toBeGreaterThan(2);
      } finally {
        f.secondAnswer.resolve();
        f.client.dispose();
      }
    });

    it("exhausts an entirely invisible remainder", async () => {
      const { client, requests, thread } = await setupHistory({ exhausted: true });
      try {
        await client.loadEarlierTranscript(thread.id);
        expect(requests).toHaveLength(2);
        expect(client.getSnapshot().transcriptWindows[thread.id]?.hasMore).toBe(false);
      } finally {
        client.dispose();
      }
    });

    it("stops at the first added work trace", async () => {
      const { client, requests, thread } = await setupHistory({ purpose: "task", steps: true });
      try {
        await client.loadEarlierTranscript(thread.id);
        expect(requests).toHaveLength(1);
      } finally {
        client.dispose();
      }
    });

    it("rejects a continuation cursor that does not advance", async () => {
      const { client, thread } = await setupHistory({ stuck: true });
      try {
        await expect(client.loadEarlierTranscript(thread.id)).rejects.toThrow(
          "continuation cursor",
        );
      } finally {
        client.dispose();
      }
    });

    it.each(["replacement", "silent"])(
      "stops if a snapshot replaces the window during a read (cursor %s)",
      async (cursor) => {
        const { client, requests, thread, secondAsked, secondAnswer, replaceWindow } =
          await setupHistory({ holdSecond: true, steps: true });
        try {
          const loading = client.loadEarlierTranscript(thread.id);
          await withTimeout(secondAsked.promise, 1000, {
            timeoutError: () => new Error("The continuation was never requested."),
          });
          replaceWindow(cursor);
          secondAnswer.resolve();
          await loading;
          expect(requests.map(({ before }) => before)).toEqual(["recent", "silent"]);
          expect(client.getSnapshot().transcriptWindows[thread.id]?.nextBefore).toBe(cursor);
        } finally {
          secondAnswer.resolve();
          client.dispose();
        }
      },
    );

    it.each(["dispose", "viewer", "thread"] as const)(
      "stops a pending page after %s changes",
      async (change) => {
        const { client, requests, thread, secondAsked, secondAnswer, changeViewer, removeThread } =
          await setupHistory({ holdSecond: true, steps: true });
        try {
          const loading = client.loadEarlierTranscript(thread.id);
          const concurrent = client.loadEarlierTranscript(thread.id);
          await withTimeout(secondAsked.promise, 1000, {
            timeoutError: () => new Error("The invisible page never requested its continuation."),
          });
          expect(client.getSnapshot().transcriptWindows[thread.id]?.nextBefore).toBe("silent");
          expect(
            client
              .getSnapshot()
              .transcripts[thread.id]?.some((entry) => entry.kind === "reasoning"),
          ).toBe(true);
          if (change === "dispose") client.dispose();
          else if (change === "viewer") await changeViewer();
          else removeThread();
          const before = client.getSnapshot().transcripts[thread.id];
          secondAnswer.resolve();
          await Promise.all([loading, concurrent]);
          expect(requests).toHaveLength(2);
          expect(client.getSnapshot().transcripts[thread.id]).toBe(before);
        } finally {
          secondAnswer.resolve();
          client.dispose();
        }
      },
    );
  });

  describe("opening a Thread", () => {
    async function openThread(
      purpose: "voice" | "task",
      capabilities: readonly "history-turns-v1"[],
      options: {
        hold?: boolean;
        silentTurns?: number;
        tail?: boolean;
        stuck?: boolean;
        conversation?: boolean;
        conversationRows?: number;
        asOf?: string;
      } = {},
    ) {
      const workspace = makeDeployment();
      const thread = { ...makeThread(workspace.id), purpose };

      const question = makeMessage(thread.id, "input", "Earlier question");
      const reply = {
        ...makeMessage(thread.id, "assistant", "Earlier reply"),
        runId: question.runId,
      };
      const silentRun = createId("run");
      const startedBy = { cause: "task-return", kind: "platform" as const };
      const pages: Record<string, { events: AgentEvent[]; nextBefore: string | null }> = {
        newest: {
          events: [
            agentEvent(workspace.id, thread.id, silentRun, "4", "run.started", {
              status: "running",
              startedBy,
            }),
            agentEvent(workspace.id, thread.id, silentRun, "5", "run.completed", {
              status: "completed",
              replyMessageId: null,
            }),
          ],
          nextBefore: "4",
        },
        "4": {
          events: [
            agentEvent(workspace.id, thread.id, question.runId, "1", "message.created", {
              input: makeThreadInput(question),
              message: question,
            }),
            agentEvent(workspace.id, thread.id, question.runId, "2", "message.created", {
              input: null,
              message: reply,
            }),
            agentEvent(workspace.id, thread.id, question.runId, "3", "run.completed", {
              status: "completed",
              replyMessageId: reply.id,
            }),
          ],
          nextBefore: null,
        },
      };
      if (options.silentTurns) {
        pages.newest!.events = Array.from({ length: options.silentTurns }, (_, index) => {
          const runId = createId("run");
          const emptyReply = { ...makeMessage(thread.id, "assistant", ""), runId };
          return [
            agentEvent(workspace.id, thread.id, runId, String(4 + index * 3), "run.started", {
              status: "running",
              startedBy,
            }),
            agentEvent(workspace.id, thread.id, runId, String(5 + index * 3), "message.created", {
              message: emptyReply,
              input: null,
            }),
            agentEvent(workspace.id, thread.id, runId, String(6 + index * 3), "run.completed", {
              status: "completed",
              replyMessageId: null,
            }),
          ];
        }).flat();
      }
      if (options.tail) {
        // The newest page holds only the end of the earlier turn: its reply is older.
        pages.newest!.events = [
          agentEvent(workspace.id, thread.id, question.runId, "4", "run.completed", {
            status: "completed",
            replyMessageId: reply.id,
          }),
        ];
        pages["4"]!.events = pages["4"]!.events.slice(0, 2);
      }
      if (options.stuck) pages["4"]!.events = [];
      if (options.stuck) pages["4"]!.nextBefore = "4";
      if (options.conversation) {
        pages.newest = {
          events: Array.from({ length: options.conversationRows ?? 10 }, (_, index) => {
            const message = makeMessage(thread.id, "input", `Visible question ${index}`);
            return agentEvent(
              workspace.id,
              thread.id,
              message.runId,
              String(index + 1),
              "message.created",
              {
                input: makeThreadInput(message),
                message,
              },
            );
          }),
          nextBefore: "older",
        };
      }
      let viewerId = ownerId;
      const olderAsked = Promise.withResolvers<void>();
      const olderAnswer = Promise.withResolvers<void>();
      const requests: Readonly<Record<string, unknown>>[] = [];
      const socket = new FakeSocket();
      const client = createHttpHostClient({
        capabilities,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname !== "/v1/rpc/thread.events.list") {
            const boot = bootstrap([workspace]);
            return json({ ...boot, user: { ...boot.user, id: viewerId } });
          }
          const request = rpcPayload(url, init);
          requests.push(request);
          const before = typeof request.before === "string" ? request.before : "newest";
          const capturedPage = pages[before];
          if (before !== "newest" || (options.hold && requests.length === 1)) {
            olderAsked.resolve();
            await withTimeout(olderAnswer.promise, 1000, {
              timeoutError: () => new Error("The held opening page was never released."),
            });
          }
          const page = capturedPage!;
          return json({
            thread,
            threadId: thread.id,
            events: page.events,
            asOfSequence: options.asOf ?? page.events.at(-1)?.sequence ?? "5",
            window: {
              byteCount: 256,
              itemCount: page.events.length,
              totalItems: 5,
              threadId: thread.id,
              hasMore: page.nextBefore !== null,
              nextBefore: page.nextBefore,
            },
          });
        },
        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      });
      client.activateThread(thread.id);
      return {
        client,
        olderAnswer,
        olderAsked,
        requests,
        thread,
        workspace,
        socket,
        pages,
        changeViewer: async () => {
          viewerId = createId("user");
          await client.refresh();
        },
      };
    }

    it("requests whole turns and draws ten rows in one read", async () => {
      const f = await openThread("voice", ["history-turns-v1"], {
        conversation: true,
      });
      try {
        await finishOpening(f);
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({ turns: 10 });
        expect(openingRows(f)).toHaveLength(10);
      } finally {
        f.client.dispose();
      }
    });

    it("installs a first page that draws less than a screen", async () => {
      const f = await openThread("voice", ["history-turns-v1"], {
        conversation: true,
        conversationRows: 3,
      });
      try {
        // An opening needs just the first page.
        await finishOpening(f);
        expect(f.requests).toHaveLength(1);
        expect(openingRows(f)).toHaveLength(3);
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]?.nextBefore).toBe("older");
      } finally {
        f.client.dispose();
      }
    });

    it("does not replay deliberately omitted events at the snapshot cut", async () => {
      const f = await heldOpening({ asOf: "8" });
      try {
        for (const sequence of ["7", "8", "9"]) {
          const message = makeMessage(f.thread.id, "input", `Buffered ${sequence}`);
          f.socket.receive(
            eventsFrame({
              type: "host.events",
              events: [
                agentEvent(
                  f.workspace.id,
                  f.thread.id,
                  message.runId,
                  sequence,
                  "message.created",
                  {
                    input: makeThreadInput(message),
                    message,
                  },
                ),
              ],
            }),
          );
        }
        await finishOpening(f);
        expect(openingRows(f)).toEqual(["Earlier question", "Earlier reply", "Buffered 9"]);
      } finally {
        f.olderAnswer.resolve();
        f.client.dispose();
      }
    });

    it("reads back past the tail of a long turn until the opening draws", async () => {
      const f = await openThread("voice", ["history-turns-v1"], { tail: true });
      try {
        await finishOpening(f);
        expect(f.requests.map(({ before }) => before)).toEqual([undefined, "4"]);
        expect(openingRows(f)).toEqual(["Earlier question", "Earlier reply"]);
      } finally {
        f.olderAnswer.resolve();
        f.client.dispose();
      }
    });

    it("reads one page of a task whose newest Run draws its work", async () => {
      const { client, requests, thread } = await openThread("task", ["history-turns-v1"]);
      try {
        await vi.waitFor(
          () => expect(client.getSnapshot().threadLookups[thread.id]).toBeUndefined(),
          { timeout: 1000 },
        );
        expect(requests).toHaveLength(1);
        expect(client.getSnapshot().transcriptWindows[thread.id]).toMatchObject({
          hasMore: true,
          nextBefore: "4",
        });
      } finally {
        client.dispose();
      }
    });

    async function heldOpening(options: Parameters<typeof openThread>[2] = {}) {
      const f = await openThread("voice", ["history-turns-v1"], { ...options, hold: true });
      try {
        await withTimeout(f.olderAsked.promise, 1000, {
          timeoutError: () => new Error("Opening never requested the older page."),
        });
        return f;
      } catch (error) {
        f.olderAnswer.resolve();
        f.client.dispose();
        throw error;
      }
    }

    async function finishOpening(f: Awaited<ReturnType<typeof openThread>>) {
      f.olderAnswer.resolve();
      await vi.waitFor(
        () =>
          expect(
            f.client.getSnapshot().threadLookups[f.thread.id],
            "Opening did not settle",
          ).toBeUndefined(),
        { timeout: 1000 },
      );
    }

    function openingRows(f: Awaited<ReturnType<typeof openThread>>) {
      return conversationRows(
        groupTranscriptEntries(
          visibleTranscript(f.client.getSnapshot().transcripts[f.thread.id] ?? [], null, {
            conversation: true,
          }),
        ),
        { live: false, atComputer: () => false },
      ).map(({ group }) =>
        group.kind === "turn"
          ? group.turn.reply?.body
          : group.kind === "message"
            ? group.entry.body
            : null,
      );
    }

    it("replays newer socket messages once while opening scans, without reapplying covered events", async () => {
      const f = await heldOpening();
      try {
        const live = makeMessage(f.thread.id, "input", "Live question");
        const event = agentEvent(f.workspace.id, f.thread.id, live.runId, "6", "message.created", {
          input: makeThreadInput(live),
          message: live,
        });
        f.socket.receive(
          eventsFrame({ type: "host.events", events: [...f.pages.newest!.events, event] }),
        );
        f.socket.receive(eventsFrame({ type: "host.events", events: [event] }));
        await finishOpening(f);
        expect(openingRows(f)).toEqual(["Earlier question", "Earlier reply", "Live question"]);
        expect(
          f.client.getSnapshot().transcripts[f.thread.id]?.filter((entry) => entry.kind === "run"),
        ).toHaveLength(2);
        expect(f.requests.map(({ before }) => before)).toEqual([undefined, "4"]);
      } finally {
        f.olderAnswer.resolve();
        f.client.dispose();
      }
    });

    it("rereads the newest history when a Workspace snapshot overtakes an opening scan", async () => {
      const f = await heldOpening();
      try {
        const fresh = makeMessage(f.thread.id, "input", "Fresh question");
        f.pages.newest = {
          events: [
            agentEvent(f.workspace.id, f.thread.id, fresh.runId, "7", "message.created", {
              input: makeThreadInput(fresh),
              message: fresh,
            }),
          ],
          nextBefore: null,
        };
        f.socket.receive({
          type: "host.snapshot",
          snapshot: { ...deploymentSnapshot(f.workspace, "6"), threads: [f.thread] },
        });
        await finishOpening(f);
        expect(f.requests.map(({ before }) => before)).toEqual([undefined, "4", undefined]);
        expect(openingRows(f)).toEqual(["Fresh question"]);
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]?.nextBefore).toBeNull();
      } finally {
        f.olderAnswer.resolve();
        f.client.dispose();
      }
    });

    it("installs nothing for the previous viewer when they change during an opening scan", async () => {
      const f = await heldOpening();
      try {
        // Joins the hydration; the viewer change also fences this queued refresh.
        const joined = f.client.loadLatestTranscript(f.thread.id);
        await withTimeout(f.changeViewer(), 1000, {
          timeoutError: () => new Error("Viewer refresh did not finish."),
        });
        f.olderAnswer.resolve();
        await withTimeout(joined, 1000, {
          timeoutError: () => new Error("The old viewer's hydration did not settle."),
        });
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBeUndefined();
        expect(f.requests.map(({ before }) => before)).toEqual([undefined]);
      } finally {
        f.olderAnswer.resolve();
        f.client.dispose();
      }
    });
  });

  /*
   * History is read over HTTP while the realtime channel keeps delivering. A
   * status the Host published after the history was read must survive the
   * history replacing the Thread's summary; the Host sends no second status
   * event while the status stays the same, so a stale one would stick.
   */
  it("keeps a status the Host published while the Thread's history was loading", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    let answerHistory!: () => void;
    const historyRequested = new Promise<void>((resolve) => {
      answerHistory = resolve;
    });
    let historyAsked!: () => void;
    const askedForHistory = new Promise<void>((resolve) => {
      historyAsked = resolve;
    });
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/thread.requests.list") {
        return json({ nextCursor: null, requests: [], threadId: thread.id });
      }
      if (url.pathname === "/v1/rpc/thread.events.list") {
        historyAsked();
        await historyRequested;
        return json({
          events: [
            agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
          ],
          thread,
          threadId: thread.id,
          window: {
            byteCount: 64,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 1,
          },
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "1"), threads: [thread] },
      type: "host.snapshot",
    });
    client.activateThread(thread.id);
    await askedForHistory;
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "2", "run.completed", {
            replyMessageId: null,
            status: "completed",
          }),
          agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "idle",
          }),
        ],
        type: "host.events",
      }),
    );
    answerHistory();
    await vi.waitFor(() => expect(client.getSnapshot().transcriptWindows[thread.id]).toBeDefined());
    expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.status).toBe("idle");

    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "4", "thread.input-queue-updated", {
            paused: true,
          }),
        ],
        type: "host.events",
      }),
    );
    expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.status).toBe("idle");
    client.dispose();
  });

  /*
   * A command's answer can reach the client after realtime events committed
   * later. Its Thread is current as of the command, so it must not take back a
   * status or queue pause the Host has published since.
   */
  it("keeps a later Host status when a Thread command's answer arrives late", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let asked!: () => void;
    const commandSent = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/rpc/commands.dispatch") {
        asked();
        await answered;
        return json({
          thread: { ...thread, accessMode: "full-access" },
          type: "thread.access.update",
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "1"), threads: [thread] },
      type: "host.snapshot",
    });
    const updating = client.updateThreadAccess(thread.id, "full-access");
    await commandSent;
    const warnDbg = vi.spyOn(console, "warn");
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "idle",
          }),
        ],
        type: "host.events",
      }),
    );
    answer();
    await updating;
    expect(warnDbg).not.toHaveBeenCalled();

    const current = client.getSnapshot().threads.find(({ id }) => id === thread.id);
    expect(current?.status).toBe("idle");
    expect(current?.accessMode).toBe("full-access");
    expect(current?.askedAt).toBe(thread.createdAt);
    client.dispose();
  });

  it.each([true, false])(
    "rebuilds the transcript from durable event history when a Thread is activated (turn pages %s)",
    async (turnPages) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const runId = createId("run");
      const userMessage = makeMessage(thread.id, "input", "Do the work");
      const eventRequests: Record<string, unknown>[] = [];
      const sockets: FakeSocket[] = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.requests.list") {
          return json({ nextCursor: null, requests: [], threadId: thread.id });
        }
        if (url.pathname === "/v1/rpc/thread.events.list") {
          eventRequests.push(rpcPayload(url, init));
          return json({
            thread,
            events: [
              agentEvent(workspace.id, thread.id, runId, "1", "message.created", {
                input: makeThreadInput(userMessage),
                message: userMessage,
              }),
              agentEvent(workspace.id, thread.id, runId, "2", "run.started", { status: "running" }),
              agentEvent(workspace.id, thread.id, runId, "4", "reasoning.completed", {
                blockId: "block-1",
                text: "Weighing the options carefully.",
              }),
              agentEvent(workspace.id, thread.id, runId, "5", "tool.started", {
                arguments: { command: "pnpm test" },
                callId: "shell-1",
                tool: { name: "shell", namespace: "codex" },
              }),
              agentEvent(workspace.id, thread.id, runId, "7", "tool.completed", {
                callId: "shell-1",
                isError: false,
                output: { text: "42 passed\n" },
              }),
              agentEvent(workspace.id, thread.id, runId, "8", "assistant.message", {
                content: [{ text: "All checks pass.", type: "text" }],
                messageId: createId("message"),
              }),
              agentEvent(workspace.id, thread.id, runId, "9", "run.completed", {
                replyMessageId: null,
                status: "completed",
              }),
            ],
            threadId: thread.id,
            window: {
              byteCount: 512,
              hasMore: false,
              itemCount: 7,
              nextBefore: null,
              threadId: thread.id,
              totalItems: 7,
            },
          });
        }
        return json(bootstrap([workspace]));
      }) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        capabilities: async () => (turnPages ? ["history-turns-v1"] : []),
        fetch,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: {
          ...deploymentSnapshot(workspace, "9"),
          threads: [thread],
          threadWindow: {
            byteCount: 256,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            totalItems: 1,
          },
        },
        type: "host.snapshot",
      });

      client.activateThread(thread.id);
      await vi.waitFor(() =>
        expect(client.getSnapshot().transcripts[thread.id]?.length).toBeGreaterThan(0),
      );

      const entries = client.getSnapshot().transcripts[thread.id] ?? [];
      expect(entries.map((entry) => entry.kind)).toEqual([
        "message",
        "run",
        "reasoning",
        "tool",
        "message",
      ]);
      expect(entries[1]).toMatchObject({ kind: "run", runId, status: "completed" });
      expect(entries[2]).toMatchObject({
        id: `reasoning:${runId}:block-1`,
        kind: "reasoning",
        state: "done",
        text: "Weighing the options carefully.",
      });
      expect(entries[3]).toMatchObject({
        arguments: { command: "pnpm test" },
        id: `tool:${runId}:shell-1`,
        integration: null,
        isError: false,
        kind: "tool",
        tool: { name: "shell", namespace: "codex" },
        output: { text: "42 passed\n" },
        state: "done",
      });
      expect(entries[4]).toMatchObject({
        body: "All checks pass.",
        kind: "message",
        messageKind: "assistant",
      });
      expect(eventRequests).toEqual([{ threadId: thread.id, ...(turnPages ? { turns: 10 } : {}) }]);

      // Re-activating a hydrated Thread must not refetch the history.
      client.activateThread(thread.id);
      await Promise.resolve();
      expect(eventRequests).toHaveLength(1);
      client.dispose();
    },
  );

  it("surfaces a failed deep-link lookup and retries it on the next activation", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    let eventReads = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/v1/rpc/thread.events.list") {
        eventReads += 1;
        if (eventReads === 1) throw new Error("The Host is temporarily unavailable.");
        return json({
          thread,
          events: [agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread })],
          threadId: thread.id,
          window: {
            byteCount: 128,
            hasMore: false,
            itemCount: 1,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 1,
          },
        });
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });
    await client.load();

    client.activateThread(thread.id);
    await vi.waitFor(() => expect(client.getSnapshot().threadLookups[thread.id]).toBe("failed"));

    client.activateThread(thread.id);
    await vi.waitFor(() =>
      expect(client.getSnapshot().threads).toContainEqual(
        expect.objectContaining({ id: thread.id, title: thread.title }),
      ),
    );
    expect(client.getSnapshot().threadLookups[thread.id]).toBeUndefined();
    expect(eventReads).toBe(2);
    client.dispose();
  });

  it("keeps a historical page pinned after a failed latest read and includes live events on retry", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const historical = agentEvent(workspace.id, thread.id, runId, "1", "assistant.message", {
      content: [{ text: "Historical answer", type: "text" }],
      messageId: createId("message"),
    });
    const live = agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
      content: [{ text: "New answer", type: "text" }],
      messageId: createId("message"),
    });
    const duringRetry = agentEvent(workspace.id, thread.id, runId, "3", "assistant.message", {
      content: [{ text: "Answer during refresh", type: "text" }],
      messageId: createId("message"),
    });
    const page = (events: AgentEvent[]) => ({
      thread,
      events,
      threadId: thread.id,
      window: {
        byteCount: 256,
        hasMore: false,
        itemCount: events.length,
        nextBefore: null,
        threadId: thread.id,
        totalItems: events.length,
      },
    });
    let reads = 0;
    let finishLatest: ((response: Response) => void) | undefined;
    const pendingLatest = new Promise<Response>((resolve) => {
      finishLatest = resolve;
    });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname !== "/v1/rpc/thread.events.list") return json(bootstrap([workspace]));
        reads += 1;
        if (reads === 1) return json(page([historical]));
        if (reads === 2) throw new Error("Latest page is temporarily unavailable");
        return pendingLatest;
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    await client.loadTranscriptAround(thread.id, historical.data.messageId);
    await expect(client.loadLatestTranscript(thread.id)).rejects.toThrow();
    socket.receive(eventsFrame({ events: [live], type: "host.events" }));
    expect(
      client
        .getSnapshot()
        .transcripts[thread.id]?.flatMap((entry) => (entry.kind === "message" ? [entry.body] : [])),
    ).toEqual(["Historical answer"]);

    const restored = client.loadLatestTranscript(thread.id);
    socket.receive(eventsFrame({ events: [duringRetry], type: "host.events" }));
    finishLatest?.(json(page([historical, live])));
    await restored;
    expect(
      client
        .getSnapshot()
        .transcripts[thread.id]?.flatMap((entry) => (entry.kind === "message" ? [entry.body] : [])),
    ).toEqual(["Historical answer", "New answer", "Answer during refresh"]);
    client.dispose();
  });

  it("keeps a definitive missing deep-link lookup distinct from a transient failure", async () => {
    const workspace = makeDeployment();
    const missingThreadId = createId("thread");
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/v1/rpc/thread.events.list") {
        return json(
          { error: { code: "not_found", message: "Thread not found", retryable: false } },
          404,
        );
      }
      return json(bootstrap([workspace]));
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({ fetch });
    await client.load();

    client.activateThread(missingThreadId);
    await vi.waitFor(() =>
      expect(client.getSnapshot().threadLookups[missingThreadId]).toBe("missing"),
    );
    client.dispose();
  });

  it("keeps an unchanged Thread's identity when another Thread's work arrives", async () => {
    const workspace = makeDeployment();
    const open = makeThread(workspace.id);
    const busy = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: {
          ...deploymentSnapshot(workspace, "0"),
          threads: [open, busy],
        },
        type: "host.snapshot",
      });
      const revision = client.getSnapshot().revision;
      const before = client.getSnapshot().threads.find(({ id }) => id === open.id);
      expect(before?.unread).toBe(false);
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, busy.id, createId("run"), "1", "run.started", {
              status: "running",
            }),
          ],
          type: "host.events",
        }),
      );
      await vi.waitFor(() => expect(client.getSnapshot().revision).toBeGreaterThan(revision));
      // Screens compare Thread records by identity; a copy redraws the open conversation.
      expect(client.getSnapshot().threads.find(({ id }) => id === open.id)).toBe(before);
    } finally {
      client.dispose();
    }
  });

  it("applies a reread stream only after the durable events it follows", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const sockets: FakeSocket[] = [];
    let liveReads = 0;
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          // The Host answers with the next answer's stream, which follows the
          // completion of the first answer at sequence 2.
          return json({
            runs: [
              {
                afterSequence: "3",
                progress: {
                  items: [{ length: 4, op: "replace", stream: "assistant", text: "Beta" }],
                  runId,
                  threadId: thread.id,
                  deploymentId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
        ],
        type: "host.events",
      }),
    );
    const live = (at: number, text: string) =>
      socket.receive({
        afterSequence: sequence("1"),
        progress: {
          items: [{ at, op: "append", stream: "assistant", text }],
          runId,
          threadId: thread.id,
        },
        type: "host.live",
      });
    live(0, "Alpha ");
    // A frame went missing, so the client rereads the Thread's streams.
    live(100, "lost");
    await vi.waitFor(() => expect(liveReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const messageId = createId("message");
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
            content: [{ text: "Alpha done.", type: "text" }],
            messageId,
          }),
          agentEvent(workspace.id, thread.id, runId, "3", "run.status", { status: "running" }),
        ],
        type: "host.events",
      }),
    );
    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries).toContainEqual(expect.objectContaining({ body: "Alpha done.", id: messageId }));
    expect(entries).toContainEqual(
      expect.objectContaining({ body: "Beta", id: `stream:${runId}`, streaming: true }),
    );
    client.dispose();
  });

  it("ignores a stream reread that answers after the subscription started over", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const sockets: FakeSocket[] = [];
    let answerRead!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerRead = resolve;
    });
    let liveReads = 0;
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          await answered;
          // A read taken before the first answer completed.
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [{ length: 6, op: "replace", stream: "assistant", text: "Alpha " }],
                  runId,
                  threadId: thread.id,
                  deploymentId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 5,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    first.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
        ],
        type: "host.events",
      }),
    );
    first.receive({
      afterSequence: sequence("1"),
      progress: {
        items: [{ at: 50, op: "append", stream: "assistant", text: "gap" }],
        runId,
        threadId: thread.id,
      },
      type: "host.live",
    });
    await vi.waitFor(() => expect(liveReads).toBe(1));

    // The connection drops and resubscribes; the answer completed meanwhile.
    first.close(1006, "lost");
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const second = sockets[1]!;
    second.open();
    const messageId = createId("message");
    second.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
            content: [{ text: "Alpha done.", type: "text" }],
            messageId,
          }),
        ],
        type: "host.events",
      }),
    );
    second.receive({
      sequence: sequence("2"),
      type: "host.synchronized",
    });
    answerRead();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries.filter((entry) => entry.id === `stream:${runId}`)).toEqual([]);
    client.dispose();
  });

  it("ignores a stream reread that answers between a resubscription's snapshot and its end", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const sockets: FakeSocket[] = [];
    let answerRead!: () => void;
    const answered = new Promise<void>((resolve) => {
      answerRead = resolve;
    });
    let liveReads = 0;
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          await answered;
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [{ length: 6, op: "replace", stream: "assistant", text: "Alpha " }],
                  runId,
                  threadId: thread.id,
                  deploymentId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 5,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    first.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
        ],
        type: "host.events",
      }),
    );
    first.receive({
      afterSequence: sequence("1"),
      progress: {
        items: [{ at: 50, op: "append", stream: "assistant", text: "gap" }],
        runId,
        threadId: thread.id,
      },
      type: "host.live",
    });
    await vi.waitFor(() => expect(liveReads).toBe(1));

    // The new subscription's snapshot already holds the completed answer; the
    // old read answers before the subscription has finished synchronizing.
    first.close(1006, "lost");
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const second = sockets[1]!;
    second.open();
    second.receive({
      snapshot: { ...deploymentSnapshot(workspace, "2"), threads: [thread] },
      type: "host.snapshot",
    });
    answerRead();
    await new Promise((resolve) => setTimeout(resolve, 20));
    second.receive({
      sequence: sequence("2"),
      type: "host.synchronized",
    });

    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries.filter((entry) => entry.id === `stream:${runId}`)).toEqual([]);
    client.dispose();
  });

  it("does not redraw a stream the history it reads has already completed", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const messageId = createId("message");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/thread.requests.list") {
          return json({ nextCursor: null, requests: [], threadId: thread.id });
        }
        if (url.pathname === "/v1/rpc/thread.events.list") {
          // History answers ahead of the event stream: the answer completed.
          return json({
            events: [
              agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
              agentEvent(workspace.id, thread.id, runId, "2", "assistant.message", {
                content: [{ text: "Alpha done.", type: "text" }],
                messageId,
              }),
              agentEvent(workspace.id, thread.id, runId, "3", "run.completed", {
                replyMessageId: messageId,
                status: "completed",
              }),
            ],
            thread,
            threadId: thread.id,
            window: {
              byteCount: 256,
              hasMore: false,
              itemCount: 3,
              nextBefore: null,
              threadId: thread.id,
              totalItems: 3,
            },
          });
        }
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      type: "host.snapshot",
    });
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
        ],
        type: "host.events",
      }),
    );
    socket.receive({
      afterSequence: sequence("1"),
      progress: {
        items: [{ at: 0, op: "append", stream: "assistant", text: "Alpha " }],
        runId,
        threadId: thread.id,
      },
      type: "host.live",
    });
    client.activateThread(thread.id);
    await vi.waitFor(() =>
      expect(
        (client.getSnapshot().transcripts[thread.id] ?? []).some((entry) => entry.id === messageId),
      ).toBe(true),
    );
    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    expect(entries.filter((entry) => entry.id === `stream:${runId}`)).toEqual([]);
    client.dispose();
  });

  it("replaces a streaming assistant draft in place when the final message arrives", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const messageId = createId("message");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...deploymentSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });

    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
        ],
        type: "host.events",
      }),
    );
    socket.receive({
      afterSequence: SequenceSchema.parse("1"),
      progress: {
        items: [
          { at: 0, op: "append", stream: "assistant", text: "Working" },
          { at: 7, op: "append", stream: "assistant", text: " on it." },
        ],
        runId,
        threadId: thread.id,
      },
      type: "host.live",
    });
    expect(client.getSnapshot().transcripts[thread.id]).toContainEqual(
      expect.objectContaining({
        body: "Working on it.",
        id: `stream:${runId}`,
        kind: "message",
        messageKind: "assistant",
        streaming: true,
      }),
    );

    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "2", "tool.started", {
            arguments: { command: "ls" },
            callId: "shell-1",
            tool: { name: "shell", namespace: "codex" },
          }),
          agentEvent(workspace.id, thread.id, runId, "3", "assistant.message", {
            content: [{ text: "Working on it. Done.", type: "text" }],
            messageId,
          }),
        ],
        type: "host.events",
      }),
    );

    const entries = client.getSnapshot().transcripts[thread.id] ?? [];
    // The final message keeps the draft's slot, before the later tool entry.
    expect(entries.map((entry) => entry.id)).toEqual([
      `run:${runId}`,
      messageId,
      `tool:${runId}:shell-1`,
    ]);
    expect(entries[1]).toMatchObject({
      body: "Working on it. Done.",
      kind: "message",
      messageKind: "assistant",
    });
    expect(entries[1]).not.toHaveProperty("streaming", true);
    client.dispose();
  });

  it("reconnects with its last durable cursor and caps exponential backoff", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      random: () => 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const invalidated = vi.fn();
    const detachRemoteAccess = client.subscribePersonalRemoteAccess(invalidated);
    const connectionsChanged = vi.fn();
    const detachConnections = client.subscribeConnectionsChanged(connectionsChanged);
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({
      snapshot: deploymentSnapshot(workspace, "4"),
      type: "host.snapshot",
    });
    first.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
    });
    expect(client.getSnapshot().connection).toBe("connected");

    expect(invalidated).toHaveBeenCalledTimes(1);
    first.receive({ type: "host.personal-remote-access-changed" });
    expect(invalidated).toHaveBeenCalledTimes(2);
    // Another device approved or revoked a connected agent: told on the open
    // socket, without a reconnect.
    first.receive({ type: "host.connections-changed" });
    expect(connectionsChanged).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    first.serverClose();
    expect(client.getSnapshot().connection).toBe("connecting");
    await vi.advanceTimersByTimeAsync(8);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();

    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "4", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    sockets[1]!.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
    });
    expect(invalidated).toHaveBeenCalledTimes(3);
    detachRemoteAccess();
    sockets[1]!.receive({ type: "host.personal-remote-access-changed" });
    expect(invalidated).toHaveBeenCalledTimes(3);
    detachConnections();
    sockets[1]!.receive({ type: "host.connections-changed" });
    expect(connectionsChanged).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("projects cross-client mutations and normalized run activity without duplicate messages", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const userMessage = makeMessage(thread.id, "input", "Do the work");
    const runId = userMessage.runId!;
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    client.activateThread(thread.id);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: deploymentSnapshot(workspace, "0"),
      type: "host.snapshot",
    });
    socket.receive({
      sequence: sequence("0"),
      type: "host.synchronized",
    });

    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
          agentEvent(workspace.id, thread.id, runId, "2", "message.created", {
            input: makeThreadInput(userMessage),
            message: userMessage,
          }),
          agentEvent(workspace.id, thread.id, runId, "3", "run.queued", {
            run: {
              createdAt: now,
              id: runId,
              status: "queued",
              threadId: thread.id,
              runOrdinal: 0,
            },
          }),
          agentEvent(workspace.id, thread.id, runId, "4", "run.started", {
            status: "running",
          }),
          agentEvent(workspace.id, thread.id, runId, "5", "tool.started", {
            arguments: { path: "docs/plan.md" },
            callId: "read-1",
            tool: { name: "workspace.read_file", namespace: "test" },
          }),
          agentEvent(workspace.id, thread.id, runId, "6", "tool.completed", {
            callId: "read-1",
            isError: false,
            output: { text: "# Plan" },
          }),
          agentEvent(workspace.id, thread.id, runId, "7", "assistant.message", {
            content: [{ text: "Finished.", type: "text" }],
            messageId: createId("message"),
          }),
          agentEvent(workspace.id, thread.id, runId, "8", "run.completed", {
            replyMessageId: null,
            status: "completed",
          }),
          agentEvent(workspace.id, thread.id, null, "9", "thread.input-queue-updated", {
            paused: true,
          }),
          agentEvent(workspace.id, thread.id, null, "10", "thread.input-queue-updated", {
            paused: false,
          }),
          agentEvent(workspace.id, thread.id, null, "11", "thread.access-mode-updated", {
            accessMode: "auto",
          }),
        ],
        type: "host.events",
      }),
    );
    // Replayed duplicate sequence and message ID must be ignored.
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "2", "message.created", {
            input: makeThreadInput(userMessage),
            message: userMessage,
          }),
        ],
        type: "host.events",
      }),
    );

    const snapshot = client.getSnapshot();
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]).toMatchObject({
      accessMode: "auto",
      inputQueuePaused: false,
      status: "idle",
      title: "Do the work",
      icon: null,
    });
    expect(snapshot.runQueue).toEqual([]);
    const entries = snapshot.transcripts[thread.id] ?? [];
    expect(
      entries.filter((entry) => entry.kind === "message" && entry.id === userMessage.id),
    ).toHaveLength(1);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Finished.", kind: "message", messageKind: "assistant" }),
        expect.objectContaining({
          kind: "tool",
          state: "done",
          tool: { name: "workspace.read_file", namespace: "test" },
        }),
        expect.objectContaining({ kind: "run", status: "completed" }),
      ]),
    );
    expect(parseSent(socket, socket.sent.length - 1)).toMatchObject({
      sequence: "11",
      type: "client.ack",
    });
    client.dispose();
  });

  it("keeps a Thread running when one Run completes with a queued successor", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const firstRunId = createId("run");
    const secondRunId = createId("run");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...deploymentSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, firstRunId, "1", "run.queued", {
            run: {
              createdAt: now,
              id: firstRunId,
              status: "queued",
              threadId: thread.id,
              runOrdinal: 0,
            },
          }),
          agentEvent(workspace.id, thread.id, firstRunId, "2", "run.started", {
            status: "running",
          }),
          agentEvent(workspace.id, thread.id, secondRunId, "3", "run.queued", {
            run: {
              createdAt: now,
              id: secondRunId,
              status: "queued",
              threadId: thread.id,
              runOrdinal: 1,
            },
          }),
          agentEvent(workspace.id, thread.id, firstRunId, "4", "run.completed", {
            replyMessageId: null,
            status: "completed",
          }),
        ],
        type: "host.events",
      }),
    );

    expect(client.getSnapshot().threads[0]?.status).toBe("running");
    expect(client.getSnapshot().runQueue).toEqual([
      expect.objectContaining({ id: secondRunId, runOrdinal: 1, status: "queued" }),
    ]);
    client.dispose();
  });

  it("projects an accepted pending message without inventing a Run", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const pendingMessage = { ...makeMessage(thread.id, "input", "Queue this"), runId: null };
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      if (path === "/v1/rpc/commands.dispatch") {
        const acceptedInput = makeThreadInput(pendingMessage);
        return json(
          {
            input: { ...acceptedInput, deliveredAt: null, state: "pending" },
            message: pendingMessage,
            run: null,
            wasDuplicate: false,
          },
          202,
        );
      }
      return json({ wasDuplicate: false }, 202);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...deploymentSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });

    await client.dispatch({
      content: [{ text: "Queue this", type: "text" }],
      idempotencyKey: "message:test",
      threadId: thread.id,
      type: "thread.sendMessage",
    });

    expect(client.getSnapshot().runQueue).toEqual([]);
    expect(client.getSnapshot().transcripts[thread.id]).toContainEqual(
      expect.objectContaining({ body: "Queue this", messageKind: "input", runId: null }),
    );
    client.dispose();
  });

  /*
   * The client can miss Run admission or hold a Runner status that differs
   * from the Host while a live Request is pending. Only Host status facts
   * can keep those projections consistent across later batches.
   */
  it("retains a pending live Request's Host status when the Runner reports running", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "waiting" as const };
    const runId = createId("run");
    const request = pendingRequest({
      presentation: {
        detail: "Approve work",
        kind: "choice",
        options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
        risk: "medium",
        title: "Approval",
      },
      runId,
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => socket,
    });
    await client.load();
    socket.open();
    socket.receive({
      type: "host.snapshot",
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
    });
    socket.receive(
      eventsFrame({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "request.opened", { request }),
          agentEvent(workspace.id, thread.id, runId, "2", "run.status", { status: "running" }),
        ],
      }),
    );
    expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
    client.dispose();
  });

  it.each(["events", "snapshot"] as const)(
    "keeps Host status authoritative after %s hydration with incomplete Run facts",
    async (source) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const runId = createId("run");
      const socket = new FakeSocket();
      const client = createHttpHostClient({
        fetch: async () => json(bootstrap([workspace])),
        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        snapshot: {
          ...deploymentSnapshot(workspace, "0"),
          threads: [{ ...thread, status: source === "snapshot" ? "running" : "idle" }],
        },
        type: "host.snapshot",
      });
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, runId, "1", "run.status", { status: "running" }),
            ...(source === "events"
              ? [
                  agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
                    inputQueuePaused: false,
                    pendingRequests: 0,
                    status: "running",
                  }),
                ]
              : []),
          ],
        }),
      );
      expect(client.getSnapshot().threads[0]?.status).toBe("running");
      expect(client.getSnapshot().runQueue).toEqual([]);
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, null, "3", "thread.input-queue-updated", {
              paused: true,
            }),
          ],
        }),
      );
      // The Host remains running, so this batch contains no status change.
      expect(client.getSnapshot().threads[0]?.status).toBe("running");
      const request = pendingRequest({
        presentation: {
          detail: "Approve work",
          kind: "choice",
          options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
          risk: "medium",
          title: "Approval",
        },
        runId,
        threadId: thread.id,
        deploymentId: workspace.id,
      });
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, runId, "4", "request.opened", { request }),
            agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
              inputQueuePaused: false,
              pendingRequests: 0,
              status: "waiting",
            }),
          ],
        }),
      );
      expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, runId, "6", "run.status", { status: "running" }),
          ],
        }),
      );
      // A pending live Request keeps the Host waiting even when the Runner says running.
      expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, runId, "7", "request.cancelled", {
              requestId: request.id,
              reason: "source-closed",
            }),
            agentEvent(workspace.id, thread.id, null, "8", "thread.state-changed", {
              inputQueuePaused: false,
              pendingRequests: 0,
              status: "running",
            }),
          ],
        }),
      );
      expect(client.getSnapshot().threads[0]?.status).toBe("running");
      client.dispose();
    },
  );

  it("applies Host status across paused work, resume, and archived Threads", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const archived = { ...makeThread(workspace.id), status: "archived" as const };
    const failing = createId("run");
    const successor = createId("run");
    const archivedRun = createId("run");
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread, archived] },
      type: "host.snapshot",
    });
    const queued = (
      runId: ReturnType<typeof createId<"run">>,
      threadId: AgentEvent["threadId"],
      runOrdinal: number,
      sequence: string,
    ) =>
      agentEvent(workspace.id, threadId, runId, sequence, "run.queued", {
        run: { createdAt: now, id: runId, status: "queued", threadId, runOrdinal },
      });
    const status = (threadId: string) =>
      client.getSnapshot().threads.find(({ id }) => id === threadId)?.status;

    socket.receive(
      eventsFrame({
        events: [
          queued(failing, thread.id, 0, "1"),
          agentEvent(workspace.id, thread.id, failing, "2", "run.started", { status: "running" }),
          queued(successor, thread.id, 1, "3"),
          agentEvent(workspace.id, thread.id, null, "4", "thread.input-queue-updated", {
            paused: true,
          }),
          agentEvent(workspace.id, thread.id, failing, "5", "run.failed", {
            code: "engine_failed",
            message: "The engine stopped",
            retryable: false,
            status: "failed",
          }),
          agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "idle",
          }),
        ],
        type: "host.events",
      }),
    );
    expect(status(thread.id)).toBe("idle");

    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "7", "thread.input-queue-updated", {
            paused: false,
          }),
          agentEvent(workspace.id, thread.id, null, "8", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "running",
          }),
        ],
        type: "host.events",
      }),
    );
    expect(status(thread.id)).toBe("running");

    socket.receive(
      eventsFrame({
        events: [
          queued(archivedRun, archived.id, 0, "9"),
          agentEvent(workspace.id, archived.id, archivedRun, "10", "run.failed", {
            code: "engine_failed",
            message: "The engine stopped",
            retryable: false,
            status: "failed",
          }),
        ],
        type: "host.events",
      }),
    );
    expect(status(archived.id)).toBe("archived");
    client.dispose();
  });

  it.each(["ordinary", "snapshot", "event"])(
    "queues a follow-up and interrupts the executing Run (%s)",
    async (source) => {
      const maintenance = source !== "ordinary";
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const currentRunId = createId("run");
      const queuedRunId = createId("run");
      const queuedMessage = makeMessage(thread.id, "input", "Follow up next");
      const sockets: FakeSocket[] = [];
      const requestedTypes: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
        const type = requiredString(
          JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>,
          "type",
        );
        requestedTypes.push(type);
        if (type === "thread.sendMessage") {
          return json(
            {
              input: makeThreadInput({ ...queuedMessage, runId: queuedRunId }),
              message: { ...queuedMessage, runId: queuedRunId },
              run: {
                teamRequestId: null,
                accessMode: thread.accessMode,
                activationInputId: queuedMessage.id,
                assignmentId: null,
                causalChainId: createId("causalChain"),
                completedAt: null,
                createdAt: now,
                environmentId: thread.environmentId,
                failure: null,
                harnessInstanceId: thread.harnessInstanceId,
                id: queuedRunId,
                providerSessionId: createId("providerSession"),
                modelSelection: thread.modelSelection,
                requestedBy: ownerId,
                replyTarget: null,
                runOrdinal: 1,
                startedAt: null,
                status: "queued",
                threadId: thread.id,
                seedInputId: queuedMessage.id,
              },
              wasDuplicate: false,
            },
            202,
          );
        }
        return json({ wasDuplicate: false }, 202);
      }) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        fetch,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({
        snapshot: {
          ...deploymentSnapshot(workspace, "1"),
          runQueue: [
            {
              createdAt: now,
              id: currentRunId,
              status: "running",
              maintenance: maintenance
                ? {
                    kind: "claude-compaction",
                    reason: "idle",
                    sourceRunId: createId("run"),
                    providerSessionId: createId("providerSession"),
                  }
                : undefined,
              threadId: thread.id,
              runOrdinal: 0,
            },
          ],
          threads: [{ ...thread, status: maintenance ? "idle" : "running" }],
        },
        type: "host.snapshot",
      });

      if (source === "event") {
        socket.receive({
          type: "host.events",
          throughSequence: sequence("3"),
          events: [
            agentEvent(workspace.id, thread.id, currentRunId, "2", "run.queued", {
              run: {
                id: currentRunId,
                threadId: thread.id,
                runOrdinal: 0,
                status: "queued",
                createdAt: now,
                maintenance: {
                  kind: "claude-compaction",
                  reason: "idle",
                  sourceRunId: createId("run"),
                  providerSessionId: createId("providerSession"),
                },
              },
            }),
            agentEvent(workspace.id, thread.id, currentRunId, "3", "run.started", {
              status: "running",
            }),
          ],
        });
      }
      expect(
        threadActivity({
          thread: client.getSnapshot().threads[0]!,
          runQueue: client.getSnapshot().runQueue,
          entries: [],
        }),
      ).toBe(maintenance ? "idle" : "working");
      await client.stopRun(thread.id);

      await client.dispatch({
        content: [{ text: "Follow up next", type: "text" }],
        idempotencyKey: "message:test",
        threadId: thread.id,
        type: "thread.sendMessage",
      });

      expect(client.getSnapshot().runQueue.map(({ id, status }) => [id, status])).toEqual([
        [currentRunId, "running"],
        [queuedRunId, "queued"],
      ]);
      expect(requestedTypes).toEqual(["run.interrupt", "thread.sendMessage"]);
      client.dispose();
    },
  );

  it("does not let a slower queued HTTP acknowledgement overwrite realtime starting state", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const message = makeMessage(thread.id, "input", "Start this next");
    const sockets: FakeSocket[] = [];
    let resolveMessage!: (response: Response) => void;
    const messageResponse = new Promise<Response>((resolve) => {
      resolveMessage = resolve;
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      if (path === "/v1/rpc/commands.dispatch") return messageResponse;
      return json({}, 202);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: {
        ...deploymentSnapshot(workspace, "0"),
        threads: [thread],
      },
      type: "host.snapshot",
    });

    const sending = client.dispatch({
      content: [{ text: "Start this next", type: "text" }],
      idempotencyKey: "message:test",
      threadId: thread.id,
      type: "thread.sendMessage",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "1", "run.queued", {
            run: {
              createdAt: now,
              id: runId,
              status: "queued",
              threadId: thread.id,
              runOrdinal: 0,
            },
          }),
          agentEvent(workspace.id, thread.id, runId, "2", "run.status", {
            status: "starting",
          }),
          agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "running",
          }),
        ],
        type: "host.events",
      }),
    );
    resolveMessage(
      json(
        {
          input: makeThreadInput({ ...message, runId }),
          message: { ...message, runId },
          run: {
            teamRequestId: null,
            accessMode: thread.accessMode,
            activationInputId: message.id,
            assignmentId: null,
            causalChainId: createId("causalChain"),
            completedAt: null,
            createdAt: now,
            environmentId: thread.environmentId,
            failure: null,
            harnessInstanceId: thread.harnessInstanceId,
            id: runId,
            providerSessionId: createId("providerSession"),
            modelSelection: thread.modelSelection,
            requestedBy: ownerId,
            replyTarget: null,
            runOrdinal: 0,
            startedAt: null,
            status: "queued",
            threadId: thread.id,
            seedInputId: message.id,
          },
          wasDuplicate: false,
        },
        202,
      ),
    );
    await sending;

    expect(client.getSnapshot().runQueue).toEqual([
      expect.objectContaining({ id: runId, status: "starting" }),
    ]);
    expect(client.getSnapshot().threads[0]?.status).toBe("running");
    client.dispose();
  });

  it("projects parent Threads and sends all Request responses through one Host route", async () => {
    const workspace = makeDeployment();
    const parentThread = makeThread(workspace.id);
    const thread = { ...makeThread(workspace.id), parentThreadId: parentThread.id };
    const runId = createId("run");
    const approval = pendingRequest({
      presentation: {
        detail: "Publish the release",
        kind: "choice",
        options: [
          { hint: "reject-once", id: "reject", label: "Not now" },
          { hint: "confirm", id: "allow", label: "Publish" },
        ],
        risk: "high",
        title: "Publish externally",
      },
      runId,
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const requests: unknown[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
      expect(path).toBe("/v1/rpc/commands.dispatch");
      requests.push(JSON.parse(String(init?.body)));
      return json({}, 202);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      snapshot: deploymentSnapshot(workspace, "0"),
      type: "host.snapshot",
    });
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
          agentEvent(workspace.id, thread.id, runId, "2", "request.opened", {
            request: approval,
          }),
          agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "waiting",
          }),
        ],
        type: "host.events",
      }),
    );

    expect(client.getSnapshot().threads[0]?.parentThreadId).toBe(parentThread.id);
    expect(client.getSnapshot().requests[thread.id]).toEqual([
      expect.objectContaining({ id: approval.id, originatingRunId: runId }),
    ]);
    await client.dispatch({
      idempotencyKey: `request-${approval.id}:test`,
      requestId: approval.id,
      response: { kind: "choice", optionId: "reject" },
      type: "request.respond",
    });

    const secret = pendingRequest({
      presentation: {
        fields: [
          {
            custom: false,
            id: "token",
            multiSelect: false,
            prompt: "Enter the release token",
            secret: true,
          },
        ],
        kind: "form",
        title: "Token needed",
      },
      runId,
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "4", "request.resolved", {
            request: {
              ...approval,
              resolvedAt: now,
              resolvedBy: ownerId,
              response: { kind: "choice", optionId: "reject" },
              status: "declined",
            },
          }),
          agentEvent(workspace.id, thread.id, runId, "5", "request.opened", {
            request: secret,
          }),
        ],
        type: "host.events",
      }),
    );
    await client.dispatch({
      idempotencyKey: `request-${secret.id}:test`,
      requestId: secret.id,
      response: { answers: { token: ["do-not-retain"] }, kind: "form" },
      type: "request.respond",
    });

    expect(requests).toEqual([
      {
        idempotencyKey: expect.stringMatching(/^request-/),
        requestId: approval.id,
        response: { kind: "choice", optionId: "reject" },
        type: "request.respond",
      },
      {
        idempotencyKey: expect.stringMatching(/^request-/),
        requestId: secret.id,
        response: { answers: { token: ["do-not-retain"] }, kind: "form" },
        type: "request.respond",
      },
    ]);
    expect(JSON.stringify(client.getSnapshot())).not.toContain("do-not-retain");
    expect(client.getSnapshot().threads[0]?.status).toBe("waiting");
    client.dispose();
  });

  it("resets an expired cursor and requests a fresh snapshot", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      random: () => 0,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 20,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]?.open();
    sockets[0]?.receive({
      reason: "cursor-expired",
      type: "host.resync-required",
    });
    await vi.advanceTimersByTimeAsync(4);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({ cursor: { afterSequence: "0" } });
    client.dispose();
  });
});

describe("HttpHostClient input queue", () => {
  it("an older queue read cannot undo a newer edit and lease event", async () => {
    const host = await queueHost(true);
    try {
      host.client.activateThread(host.thread.id);
      await vi.waitFor(
        () =>
          expect(
            host.client.getSnapshot().inputQueues[host.thread.id],
            "Initial queue never loaded",
          ).toBeDefined(),
        { timeout: 1000 },
      );
      host.holdReads();
      const loading = host.client.loadThreadInputQueue(host.thread.id);
      await vi.waitFor(() => expect(host.reads(), "Older queue read never started").toBe(2), {
        timeout: 1000,
      });
      const edit = { revision: 1, editedAt: now, ownerEdited: true as const };
      const message = {
        ...host.queued,
        content: [{ type: "text" as const, text: "Edited on phone" }],
        edit,
      };
      const lease = { leaseId: "other-device", deviceLabel: "Phone", expiresAt: now };
      host.items = [{ ...host.items[0]!, message, lease }];
      host.socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(host.workspace.id, host.thread.id, null, "1", "message.updated", {
              message,
              edit,
              input: pendingInput(message),
            }),
            agentEvent(host.workspace.id, host.thread.id, null, "2", "thread-input.lease-changed", {
              messageId: message.id,
              lease,
            }),
          ],
        }),
      );
      const current = () => host.client.getSnapshot().inputQueues[host.thread.id]!.items[0]!;
      expect(current()).toMatchObject({ message, lease });
      const seen: ThreadInputQueue["items"][number][] = [];
      const stop = host.client.subscribe(() => seen.push(current()));
      try {
        host.releaseReads();
        await loading;
        expect(current()).toMatchObject({ message, lease });
        await vi.waitFor(() => expect(host.reads(), "Fresh queue read never started").toBe(3), {
          timeout: 1000,
        });
        await host.client.loadThreadInputQueue(host.thread.id);
        expect(seen.length).toBeGreaterThan(0);
        expect(
          seen.every(
            (item) => item.message.edit?.revision === 1 && item.lease?.leaseId === lease.leaseId,
          ),
        ).toBe(true);
      } finally {
        stop();
      }
    } finally {
      host.releaseReads();
      host.client.dispose();
    }
  });
  it("keeps a fresh-context send unsteerable while the confirming queue read waits", async () => {
    const host = await queueHost();
    try {
      host.items = [];
      host.client.activateThread(host.thread.id);
      await vi.waitFor(
        () =>
          expect(
            host.client.getSnapshot().inputQueues[host.thread.id],
            "The initial queue never loaded",
          ).toBeDefined(),
        { timeout: 2_000 },
      );
      host.holdReads();
      const message = { ...makeMessage(host.thread.id, "input", "Independent check"), runId: null };
      host.answerWith(() =>
        json(
          {
            input: { ...pendingInput(message), freshContext: true },
            message,
            run: null,
            wasDuplicate: false,
          },
          202,
        ),
      );
      await host.client.dispatch({
        content: message.content,
        freshContext: true,
        idempotencyKey: "fresh-send",
        threadId: host.thread.id,
        type: "thread.sendMessage",
      });
      expect(host.client.getSnapshot().inputQueues[host.thread.id]?.items).toMatchObject([
        { canSteer: false, input: { freshContext: true, messageId: message.id } },
      ]);
    } finally {
      host.releaseReads();
      host.client.dispose();
    }
  });
  it("reads the queue when a Thread is activated and reuses a read in flight", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    expect(host.reads()).toBe(1);
    expect(host.client.getSnapshot().inputQueues[host.thread.id]).toMatchObject({
      items: [
        {
          canCancel: true,
          canSteer: true,
          input: expect.objectContaining({ messageId: host.queued.id, state: "pending" }),
          message: expect.objectContaining({ id: host.queued.id }),
        },
      ],
      paused: false,
      steerRunId: host.runId,
    });

    // A queue already read is kept fresh by events, not by activation.
    host.client.activateThread(host.thread.id);
    await Promise.resolve();
    expect(host.reads()).toBe(1);
    host.client.dispose();
  });

  it("reads a loaded queue again after every event that can change it", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const queuedRunId = createId("run");
    const later = { ...makeMessage(host.thread.id, "input", "And after that"), runId: null };
    host.items = [queueItem(host.queued, true), queueItem(later, true)];
    async function afterEvent(agent: AgentEvent): Promise<void> {
      const before = host.reads();
      host.socket.receive(eventsFrame({ events: [agent], type: "host.events" }));
      await vi.waitFor(() => expect(host.reads()).toBe(before + 1));
    }

    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, null, "1", "message.created", {
        input: pendingInput(later),
        message: later,
      }),
    );
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]?.items).toHaveLength(2),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, host.runId, "2", "run.status", {
        status: "waiting",
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, host.runId, "3", "run.started", {
        status: "running",
      }),
    );
    host.paused = true;
    const before = host.reads();
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, null, "4", "thread.input-queue-updated", {
            paused: true,
          }),
        ],
        type: "host.events",
      }),
    );
    // The pause is the event's own fact and lands before the read confirms it.
    expect(host.client.getSnapshot().inputQueues[host.thread.id]?.paused).toBe(true);
    await vi.waitFor(() => expect(host.reads()).toBe(before + 1));
    host.paused = false;
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, null, "5", "thread.input-queue-updated", {
        paused: false,
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, host.runId, "6", "run.completed", {
        replyMessageId: null,
        status: "completed",
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, queuedRunId, "7", "run.queued", {
        run: {
          createdAt: now,
          id: queuedRunId,
          runOrdinal: 1,
          status: "queued",
          threadId: host.thread.id,
        },
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, queuedRunId, "8", "run.failed", {
        code: "engine",
        message: "The engine stopped.",
        retryable: false,
        status: "failed",
      }),
    );
    await afterEvent(
      agentEvent(host.workspace.id, host.thread.id, createId("run"), "9", "run.interrupted", {
        status: "interrupted",
      }),
    );

    // Not every event is about the queue, and a burst is one read.
    const settled = host.reads();
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, null, "10", "thread.access-mode-updated", {
            accessMode: "auto",
          }),
        ],
        type: "host.events",
      }),
    );
    await Promise.resolve();
    expect(host.reads()).toBe(settled);
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, host.runId, "11", "run.started", {
            status: "running",
          }),
          agentEvent(host.workspace.id, host.thread.id, null, "12", "thread.input-queue-updated", {
            paused: false,
          }),
        ],
        type: "host.events",
      }),
    );
    await vi.waitFor(() => expect(host.reads()).toBe(settled + 1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.reads()).toBe(settled + 1);
    host.client.dispose();
  });

  it("drops an input that left pending at once and answers a mid-read event with one more read", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const later = { ...makeMessage(host.thread.id, "input", "And after that"), runId: null };
    host.items = [queueItem(host.queued, true), queueItem(later, true)];
    await host.client.loadThreadInputQueue(host.thread.id);
    const queuedIds = () =>
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id);
    expect(queuedIds()).toEqual([host.queued.id, later.id]);

    host.items = [queueItem(later, true)];
    host.holdReads();
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, host.runId, "1", "thread-input.updated", {
            input: { ...pendingInput(host.queued), runId: host.runId, state: "claimed" },
          }),
        ],
        type: "host.events",
      }),
    );
    // The tray stops offering a claimed message before the read confirms it.
    expect(queuedIds()).toEqual([later.id]);
    await vi.waitFor(() => expect(host.reads()).toBe(3));

    // Events that land while a read is in flight do not join it: the read may
    // predate them, so they earn exactly one more read once it settles.
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, host.runId, "2", "run.started", {
            status: "running",
          }),
        ],
        type: "host.events",
      }),
    );
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, null, "3", "thread.input-queue-updated", {
            paused: false,
          }),
        ],
        type: "host.events",
      }),
    );
    await Promise.resolve();
    expect(host.reads()).toBe(3);
    host.releaseReads();
    await vi.waitFor(() => expect(host.reads()).toBe(4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.reads()).toBe(4);
    expect(queuedIds()).toEqual([later.id]);
    host.client.dispose();
  });

  it("queues an acknowledged send behind the running turn only when the Host started no Run", async () => {
    const host = await queueHost();
    host.items = [];
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );

    const held = { ...makeMessage(host.thread.id, "input", "Then rename the branch"), runId: null };
    host.answerWith(() =>
      json({ input: pendingInput(held), message: held, run: null, wasDuplicate: false }, 202),
    );
    // What the Host lists once it holds the message: the acknowledgement's
    // optimistic row is confirmed by a read, never left to stand on its own.
    host.items = [queueItem(held, true)];
    const send = {
      content: [{ text: "Then rename the branch", type: "text" as const }],
      idempotencyKey: "message:held",
      threadId: host.thread.id,
      type: "thread.sendMessage" as const,
    };
    const readsBefore = host.reads();
    await host.client.dispatch(send);
    await vi.waitFor(() => expect(host.reads()).toBe(readsBefore + 1));
    const queue = host.client.getSnapshot().inputQueues[host.thread.id] ?? null;
    expect(queue?.items).toEqual([
      {
        canCancel: true,
        canEdit: true,
        canMove: true,
        canSteer: true,
        lease: null,
        input: expect.objectContaining({ messageId: held.id, state: "pending" }),
        message: expect.objectContaining({ id: held.id }),
      },
    ]);
    // The message is in the transcript, as every send is, and the queue is
    // what keeps it out of the conversation until a Run takes it.
    const transcript = host.client.getSnapshot().transcripts[host.thread.id] ?? [];
    expect(transcript).toContainEqual(expect.objectContaining({ id: held.id }));
    expect(visibleTranscript(transcript, queue)).not.toContainEqual(
      expect.objectContaining({ id: held.id }),
    );

    // The same acknowledgement again adds nothing.
    await host.client.dispatch(send);
    expect(host.client.getSnapshot().inputQueues[host.thread.id]?.items).toHaveLength(1);

    // A send the Host started a Run for belongs to the conversation.
    const started = makeMessage(host.thread.id, "input", "Start now");
    host.answerWith(() =>
      json(
        {
          input: makeThreadInput(started),
          message: started,
          run: {
            teamRequestId: null,
            accessMode: host.thread.accessMode,
            activationInputId: started.id,
            assignmentId: null,
            causalChainId: createId("causalChain"),
            completedAt: null,
            createdAt: now,
            environmentId: host.thread.environmentId,
            failure: null,
            harnessInstanceId: host.thread.harnessInstanceId,
            id: started.runId,
            providerSessionId: createId("providerSession"),
            modelSelection: host.thread.modelSelection,
            requestedBy: ownerId,
            replyTarget: null,
            runOrdinal: 1,
            seedInputId: started.id,
            startedAt: null,
            status: "queued",
            threadId: host.thread.id,
          },
          wasDuplicate: false,
        },
        202,
      ),
    );
    await host.client.dispatch({
      content: [{ text: "Start now", type: "text" }],
      idempotencyKey: "message:started",
      threadId: host.thread.id,
      type: "thread.sendMessage",
    });
    expect(
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id),
    ).toEqual([held.id]);
    host.client.dispose();
  });

  it("steers under one key until the Host answers, and under a new one after", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const queuedIds = () =>
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id);
    const keys = () => host.dispatched.map((command) => String(command.idempotencyKey));
    const claimed = () =>
      json({ input: { ...pendingInput(host.queued), runId: host.runId, state: "claimed" } }, 202);

    // A lost answer keeps the key and rereads the queue; nothing is dropped.
    host.answerWith(() => {
      throw new Error("Socket hung up");
    });
    await expect(host.client.steerThreadInput(host.thread.id, host.queued.id)).rejects.toThrow();
    await vi.waitFor(() => expect(host.reads()).toBe(2));
    await host.client.loadThreadInputQueue(host.thread.id);
    expect(queuedIds()).toEqual([host.queued.id]);

    host.answerWith(claimed);
    await host.client.steerThreadInput(host.thread.id, host.queued.id);
    expect(host.dispatched.map((command) => command.type)).toEqual([
      "thread.input.steer",
      "thread.input.steer",
    ]);
    expect(host.dispatched[1]).toMatchObject({
      expectedRunId: host.runId,
      messageId: host.queued.id,
      threadId: host.thread.id,
    });
    expect(keys()[0]).toMatch(/^input-steer:/);
    expect(keys()[1]).toBe(keys()[0]);
    expect(queuedIds()).toEqual([]);

    // The Host restored the message after a refusal: promoting it again is a
    // new mutation, not a replay of the one it answered.
    await host.client.loadThreadInputQueue(host.thread.id);
    expect(queuedIds()).toEqual([host.queued.id]);
    await host.client.steerThreadInput(host.thread.id, host.queued.id);
    expect(keys()[2]).not.toBe(keys()[1]);

    // A refusal the Host states settles the attempt just as an acceptance does.
    await host.client.loadThreadInputQueue(host.thread.id);
    host.answerWith(() =>
      json({ error: { code: "conflict", message: "The Run moved on.", retryable: false } }, 409),
    );
    await expect(
      host.client.steerThreadInput(host.thread.id, host.queued.id),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(queuedIds()).toEqual([host.queued.id]);
    host.answerWith(claimed);
    await host.client.steerThreadInput(host.thread.id, host.queued.id);
    expect(keys()[4]).not.toBe(keys()[3]);

    // Without a Run the queue names as steerable there is nothing to send.
    host.steerRunId = null;
    await host.client.loadThreadInputQueue(host.thread.id);
    await expect(host.client.steerThreadInput(host.thread.id, host.queued.id)).rejects.toThrow(
      "This message cannot be steered right now.",
    );
    expect(host.dispatched).toHaveLength(5);
    host.client.dispose();
  });

  it("stops offering Steer into a Run the moment the stream says it ended", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]?.steerRunId).toBe(host.runId),
    );
    // The read that follows is held back: what the tray offers in between is
    // the projection's alone.
    host.holdReads();
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, host.runId, "1", "run.completed", {
            replyMessageId: null,
            status: "completed",
          }),
        ],
        type: "host.events",
      }),
    );
    expect(host.client.getSnapshot().inputQueues[host.thread.id]?.steerRunId).toBeNull();
    host.steerRunId = null;
    host.releaseReads();
    await vi.waitFor(() => expect(host.reads()).toBe(2));
    host.client.dispose();
  });

  it("lets go of a Thread's queue the reader has left rather than reading it per event", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    expect(host.reads()).toBe(1);

    // Another Thread on screen: its own first read is not this queue's.
    host.client.activateThread(createId("thread"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = host.reads();
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, null, "1", "thread.input-queue-updated", {
            paused: true,
          }),
        ],
        type: "host.events",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeUndefined();
    expect(host.reads()).toBe(before);

    // Coming back reads it afresh.
    host.paused = true;
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]?.paused).toBe(true),
    );
    expect(host.reads()).toBe(before + 1);
    host.client.dispose();
  });

  it("withdraws a queued message from the queue and the conversation together", async () => {
    const host = await queueHost();
    host.client.activateThread(host.thread.id);
    await vi.waitFor(() =>
      expect(host.client.getSnapshot().inputQueues[host.thread.id]).toBeDefined(),
    );
    const transcript = () => host.client.getSnapshot().transcripts[host.thread.id] ?? [];
    const queuedIds = () =>
      host.client.getSnapshot().inputQueues[host.thread.id]?.items.map((item) => item.message.id);

    // The message reached the conversation through the stream, as every send does.
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, null, "1", "message.created", {
            input: pendingInput(host.queued),
            message: host.queued,
          }),
        ],
        type: "host.events",
      }),
    );
    expect(transcript()).toContainEqual(expect.objectContaining({ id: host.queued.id }));
    await vi.waitFor(() => expect(host.reads()).toBe(2));
    await host.client.loadThreadInputQueue(host.thread.id);

    // A lost answer is retried under the same key, never as a second withdrawal.
    host.answerWith(() => {
      throw new Error("Socket hung up");
    });
    await expect(host.client.cancelThreadInput(host.thread.id, host.queued.id)).rejects.toThrow();
    await vi.waitFor(() => expect(host.reads()).toBe(3));
    await host.client.loadThreadInputQueue(host.thread.id);
    expect(queuedIds()).toEqual([host.queued.id]);

    host.items = [];
    host.answerWith(() =>
      json(
        { input: { ...pendingInput(host.queued), cancelReason: "withdrawn", state: "cancelled" } },
        202,
      ),
    );
    await host.client.cancelThreadInput(host.thread.id, host.queued.id);
    expect(host.dispatched.map((command) => command.type)).toEqual([
      "thread.input.cancel",
      "thread.input.cancel",
    ]);
    expect(host.dispatched[1]).toMatchObject({
      idempotencyKey: host.dispatched[0]?.idempotencyKey,
      messageId: host.queued.id,
      threadId: host.thread.id,
    });
    expect(String(host.dispatched[0]?.idempotencyKey)).toMatch(/^input-cancel:/);
    expect(queuedIds()).toEqual([]);
    const withdrawn = () => transcript().filter((entry) => entry.id === host.queued.id);
    expect(withdrawn()).toEqual([expect.objectContaining({ kind: "withdrawn" })]);
    expect(visibleTranscript(transcript(), null)).not.toContainEqual(
      expect.objectContaining({ id: host.queued.id }),
    );

    // The stream's confirmation changes nothing.
    host.socket.receive(
      eventsFrame({
        events: [
          agentEvent(host.workspace.id, host.thread.id, null, "2", "thread-input.updated", {
            input: { ...pendingInput(host.queued), cancelReason: "withdrawn", state: "cancelled" },
          }),
        ],
        type: "host.events",
      }),
    );
    await vi.waitFor(() => expect(host.reads()).toBe(4));
    expect(withdrawn()).toEqual([expect.objectContaining({ kind: "withdrawn" })]);
    expect(queuedIds()).toEqual([]);
    host.client.dispose();
  });
});

/**
 * A Host with one Thread mid-Run and one message waiting behind it. The
 * queue it answers with is whatever the test last said it holds, so a test
 * moves the Host's truth and watches the client follow.
 */
async function queueHost(captureBeforeGate = false) {
  const workspace = makeDeployment();
  const thread = makeThread(workspace.id);
  const runId = createId("run");
  const queued = { ...makeMessage(thread.id, "input", "Then rename the branch"), runId: null };
  const dispatched: Record<string, unknown>[] = [];
  const sockets: FakeSocket[] = [];
  let reads = 0;
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  let answer: (body: Record<string, unknown>) => Response = () => json({}, 202);
  const state = {
    items: [queueItem(queued, true)] as ReturnType<typeof queueItem>[],
    paused: false,
    steerRunId: runId as string | null,
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname;
    switch (path) {
      case "/v1/rpc/thread.inputQueue.get": {
        const read = JSON.parse(url.searchParams.get("input") ?? "{}") as { threadId?: string };
        if (read.threadId !== thread.id) {
          return json(
            {
              error: { code: "not_found", message: "Thread not found", retryable: false },
              ok: false,
            },
            404,
          );
        }
        reads += 1;
        const response = () =>
          json({
            items: state.items,
            paused: state.paused,
            steerRunId: state.steerRunId,
            threadId: thread.id,
          });
        const captured = captureBeforeGate ? response() : null;
        if (gate) await gate;
        return captured ?? response();
      }
      case "/v1/rpc/thread.events.list":
        return json({
          thread,
          events: [],
          threadId: thread.id,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 0,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 0,
          },
        });
      case "/v1/rpc/thread.requests.list":
        return json({
          requests: [],
          threadId: thread.id,
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        });
      case "/v1/rpc/commands.dispatch": {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        dispatched.push(body);
        return answer(body);
      }
      default:
        return json(bootstrap([workspace]));
    }
  }) as unknown as typeof globalThis.fetch;
  const client = createHttpHostClient({
    fetch,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await client.load();
  const socket = sockets[0]!;
  socket.open();
  socket.receive({
    snapshot: {
      ...deploymentSnapshot(workspace, "0"),
      runQueue: [
        { createdAt: now, id: runId, runOrdinal: 0, status: "running", threadId: thread.id },
      ],
      threads: [{ ...thread, status: "running" }],
    },
    type: "host.snapshot",
  });
  return {
    answerWith: (next: (body: Record<string, unknown>) => Response) => {
      answer = next;
    },
    client,
    dispatched,
    holdReads: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    get items() {
      return state.items;
    },
    set items(items: ReturnType<typeof queueItem>[]) {
      state.items = items;
    },
    get paused() {
      return state.paused;
    },
    set paused(paused: boolean) {
      state.paused = paused;
    },
    queued,
    reads: () => reads,
    releaseReads: () => {
      gate = null;
      release?.();
      release = null;
    },
    runId,
    socket,
    get steerRunId() {
      return state.steerRunId;
    },
    set steerRunId(steerRunId: string | null) {
      state.steerRunId = steerRunId;
    },
    thread,
    workspace,
  };
}

function pendingInput(message: Message) {
  return { ...makeThreadInput(message), deliveredAt: null, runId: null, state: "pending" as const };
}

function queueItem(message: Message, canSteer: boolean): ThreadInputQueue["items"][number] {
  return {
    canCancel: true,
    canEdit: true,
    canMove: true,
    canSteer,
    input: pendingInput(message),
    lease: null,
    message,
  };
}

describe("HttpHostClient browser profiles", () => {
  it("keeps pending erasure from delete receipts and bootstrap until completion, including older Hosts", async () => {
    const profileId = createId("browserProfile");
    const computerId = createId("runner");
    const deletion = { profileId, computerId, state: "pending-computer" as const };
    let browser: BrowserWireBootstrap = {
      available: false,
      placements: [],
      profiles: [{ homeRunnerId: null, id: profileId, name: "Work" }],
    };
    const client = createHttpHostClient({
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([makeDeployment()], browser));
        if (path === "/v1/rpc/commands.dispatch")
          return json({ type: "browser.profile.delete", deletion });
        throw new Error(`Unexpected request ${path}`);
      },
    });
    try {
      await client.load();
      expect(client.getSnapshot().browserProfileDeletions).toBeUndefined();
      await client.dispatch({
        type: "browser.profile.delete",
        profileId,
        idempotencyKey: "delete-native-profile",
      });
      expect(client.getSnapshot().browserProfiles).toEqual([]);
      expect(client.getSnapshot().browserProfileDeletions).toEqual([deletion]);
      browser = {
        ...browser,
        profiles: [],
        profileDeletions: [{ ...deletion, state: "pending-restart" }],
      };
      await client.refresh();
      expect(client.getSnapshot().browserProfileDeletions).toEqual(browser.profileDeletions);
      browser = { ...browser, profileDeletions: [] };
      await client.refresh();
      expect(client.getSnapshot().browserProfileDeletions).toEqual([]);
      delete browser.profileDeletions;
      await client.refresh();
      expect(client.getSnapshot().browserProfileDeletions).toBeUndefined();
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient attachment discovery", () => {
  it("does not poll discovery and reverifies only when explicitly asked", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    const capabilities = vi.fn(async () => ["thread-titles-v1"] as const);
    const client = createHttpHostClient({
      capabilities,
      fetch: async () => json(bootstrap([workspace])),
      reconnectBaseDelayMs: 10,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(capabilities).toHaveBeenCalledTimes(1);
      expect(capabilities).not.toHaveBeenCalledWith({ revalidate: true });
      await client.refresh({ retryConnection: true });
      expect(capabilities).toHaveBeenCalledWith({ revalidate: true });
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().threadRenameAvailable).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("reverifies discovery on refresh while a notice bootstrap is still running", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const capabilities = vi.fn(async () => [] as const);
    let held: ReturnType<typeof Promise.withResolvers<Response>> | null = null;
    let bootstraps = 0;
    const client = createHttpHostClient({
      capabilities,
      fetch: async () => {
        bootstraps += 1;
        if (bootstraps === 2) {
          held = Promise.withResolvers<Response>();
          return held.promise;
        }
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => new FakeSocket(),
    });
    try {
      await client.load();
      const notice = client.load();
      await vi.advanceTimersByTimeAsync(0);
      expect(held).not.toBeNull();
      const refreshed = client.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(capabilities).toHaveBeenCalledWith({ revalidate: true });
      held!.resolve(json(bootstrap([workspace])));
      await refreshed;
      await notice;
    } finally {
      client.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["unauthorized", "unsupported-version"] as const)(
    "reverifies discovery on an RPC %s refusal",
    async (refusal) => {
      const capabilities = vi.fn(async () => []);
      let refuse = false;
      const client = createHttpHostClient({
        capabilities,
        taskReads: "observed",
        fetch: async () =>
          refuse
            ? json(
                {
                  ok: false,
                  error: {
                    code: refusal === "unauthorized" ? "unauthorized" : "bad_request",
                    reason: refusal,
                    message: "Refused",
                    retryable: false,
                  },
                },
                refusal === "unauthorized" ? 401 : 400,
              )
            : json(bootstrap([])),
      });
      try {
        await client.load();
        refuse = true;
        await client.rpc["tasks.list"]({ limit: 10 });
        await vi.waitFor(() => expect(capabilities).toHaveBeenCalledWith({ revalidate: true }));
      } finally {
        client.dispose();
      }
    },
  );
});

describe("HttpHostClient voice capability", () => {
  it("shows voice only while the Host advertises calls with an agent Run", async () => {
    let enabled = false;
    const client = createHttpHostClient({
      capabilities: async () => (enabled ? ["voice-run-v1"] : []),
      webSocketFactory: () => new FakeSocket(),
      fetch: async () => json(bootstrap([])),
    });
    try {
      await client.load();
      expect(client.getSnapshot().voiceAvailable).toBe(false);
      enabled = true;
      await client.refresh();
      expect(client.getSnapshot().voiceAvailable).toBe(true);
      enabled = false;
      await client.refresh();
      expect(client.getSnapshot().voiceAvailable).toBe(false);
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient title capability", () => {
  it("refreshes capability evidence and refuses unavailable or invalid renames", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    let available = false;
    const commands: Readonly<Record<string, unknown>>[] = [];
    const client = createHttpHostClient({
      capabilities: async () => (available ? ["thread-titles-v1"] : []),
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/rpc/commands.dispatch") {
          const command = rpcPayload(url, init);
          commands.push(command);
          if (command.type === "execution.preferences.remember")
            return json({ preferences: emptyExecutionPreferences });
          return json({
            thread: { ...thread, title: command.title },
            asOfSequence: "10",
            wasDuplicate: false,
          });
        }
        return json(bootstrap([workspace]));
      },
    });
    try {
      await client.load();
      expect(client.getSnapshot().threadRenameAvailable).toBe(false);
      await expect(client.renameThread(thread.id, "Title")).rejects.toThrow("does not support");
      const creation = {
        accessMode: thread.accessMode,
        environmentId,
        harnessInstanceId,
        modelSelection: thread.modelSelection,
        deploymentId: workspace.id,
        title: "Seed",
        generateTitle: true as const,
      };
      await client.createThread(creation);
      expect(commands.find((command) => command.type === "thread.create")).toHaveProperty(
        "generateTitle",
        true,
      );
      available = true;
      await client.refresh();
      expect(client.getSnapshot().threadRenameAvailable).toBe(true);
      await client.createThread(creation);
      expect(commands.filter((command) => command.type === "thread.create").at(-1)).toMatchObject({
        generateTitle: true,
      });
      await expect(client.renameThread(thread.id, "  ")).rejects.toThrow();
      await expect(client.renameThread(thread.id, "x".repeat(241))).rejects.toThrow();
      await client.renameThread(thread.id, "  Trimmed name  ");
      expect(commands.filter((command) => command.type === "thread.rename")).toEqual([
        expect.objectContaining({ title: "Trimmed name", idempotencyKey: expect.any(String) }),
      ]);
      available = false;
      await client.refresh();
      expect(client.getSnapshot().threadRenameAvailable).toBe(false);
      await expect(client.renameThread(thread.id, "Another title")).rejects.toThrow(
        "does not support",
      );
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient Thread state reconciliation", () => {
  async function delayedRead(options: {
    readonly freshHistory?: unknown;
    readonly loaded?: boolean;
    readonly path: string;
    readonly response: unknown;
    readonly responseStatus?: number;
    readonly thread: Thread;
    readonly workspace: PersonalFixture;
  }) {
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const socket = new FakeSocket();
    let reads = 0;
    const reread = vi.fn();
    const client = createHttpHostClient({
      capabilities: ["thread-titles-v1", "task-marks-v1"],
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === options.path && reads++ === 0) {
          asked.resolve();
          await answer.promise;
          return json(options.response, options.responseStatus);
        }
        if (path === "/v1/rpc/thread.events.list" && options.freshHistory) {
          reread();
          return json(options.freshHistory);
        }
        if (path === options.path) return json(options.response);
        return json(bootstrap([options.workspace]));
      },
      webSocketFactory: () => socket,
    });
    await client.load();
    socket.open();
    socket.receive({
      snapshot: {
        ...deploymentSnapshot(options.workspace, "0"),
        threads: options.loaded === false ? [] : [options.thread],
        threadWindow: {
          byteCount: 2,
          hasMore: true,
          itemCount: options.loaded === false ? 0 : 1,
          nextBefore: "older_threads",
          totalItems: 2,
        },
      },
      type: "host.snapshot",
    });
    return { answer: answer.resolve, asked: asked.promise, client, reread, socket };
  }

  function historyPage(thread: Thread, asOfSequence = "0", events: AgentEvent[] = []) {
    return {
      events,
      asOfSequence,
      thread,
      threadId: thread.id,
      window: {
        byteCount: 2,
        hasMore: false,
        itemCount: events.length,
        nextBefore: null,
        threadId: thread.id,
        totalItems: events.length,
      },
    };
  }

  function stateEvents(workspace: PersonalFixture, thread: Thread): AgentEvent[] {
    const request = pendingRequest({
      presentation: {
        detail: "Continue the work",
        kind: "choice",
        options: [{ hint: "confirm", id: "allow", label: "Continue" }],
        risk: "low",
        title: "Continue?",
      },
      runId: createId("run"),
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    return [
      agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
        status: "waiting",
        inputQueuePaused: false,
        pendingRequests: 0,
      }),
      agentEvent(workspace.id, thread.id, null, "3", "thread.input-queue-updated", {
        paused: true,
      }),
      agentEvent(workspace.id, thread.id, request.originatingRunId, "4", "request.opened", {
        request,
      }),
      agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
        status: "waiting",
        inputQueuePaused: true,
        pendingRequests: 1,
        title: "Current title",
      }),
    ];
  }

  it.each(["history", "command", "history page"] as const)(
    "keeps a newer title across delayed %s and legacy state events",
    async (source) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const path =
        source === "command" ? "/v1/rpc/commands.dispatch" : "/v1/rpc/thread.events.list";
      const { answer, asked, client, socket } = await delayedRead({
        path,
        response: source === "command" ? { thread } : historyPage(thread),
        thread,
        workspace,
      });
      try {
        const reading =
          source === "history"
            ? client.loadLatestTranscript(thread.id)
            : source === "command"
              ? client.dispatch({
                  type: "thread.rename",
                  threadId: thread.id,
                  title: "Earlier rename",
                  idempotencyKey: "earlier-title",
                })
              : client.loadEarlierTranscript(thread.id);
        await asked;
        socket.receive(
          eventsFrame({
            type: "host.events",
            events: [
              agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
                status: "idle",
                inputQueuePaused: false,
                pendingRequests: 0,
                title: "Current title",
              }),
              agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
                status: "idle",
                inputQueuePaused: false,
                pendingRequests: 0,
              }),
            ],
          }),
        );
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.title).toBe(
          "Current title",
        );
        answer();
        await reading;
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.title).toBe(
          "Current title",
        );
      } finally {
        client.dispose();
      }
    },
  );

  it.each(["history", "older response", "failure"] as const)(
    "keeps a newer icon across delayed %s, legacy events and stale snapshots",
    async (source) => {
      const workspace = makeDeployment();
      const thread = {
        ...makeThread(workspace.id),
        icon: "hotel" as const,
        color: "blue" as const,
      };
      const { answer, asked, client, socket } = await delayedRead({
        path: source === "history" ? "/v1/rpc/thread.events.list" : "/v1/rpc/commands.dispatch",
        response:
          source === "history"
            ? historyPage(thread)
            : source === "failure"
              ? { error: { code: "bad_request", message: "Icon refused", retryable: false } }
              : { thread: { ...thread, icon: "plane" }, asOfSequence: "2" },
        ...(source === "failure" ? { responseStatus: 400 } : {}),
        thread,
        workspace,
      });
      try {
        const pending =
          source === "history"
            ? client.loadLatestTranscript(thread.id)
            : client.dispatch({
                type: "thread.icon.set",
                threadId: thread.id,
                icon: "plane",
                idempotencyKey: "older-icon",
              });
        const settled = pending.then(
          () => null,
          (error: unknown) => error,
        );
        if (source !== "history") {
          expect(client.getSnapshot().threads[0]).toMatchObject({
            icon: "plane",
            title: thread.title,
            updatedAt: thread.updatedAt,
          });
        }
        await asked;
        socket.receive(
          eventsFrame({
            type: "host.events",
            events: [
              agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
                status: "idle",
                inputQueuePaused: false,
                pendingRequests: 0,
                title: thread.title,
                icon: "gift",
              }),
              agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
                status: "idle",
                inputQueuePaused: false,
                pendingRequests: 0,
              }),
            ],
          }),
        );
        answer();
        const error = await settled;
        if (source === "failure") expect(error).toMatchObject({ message: "Icon refused" });
        else expect(error).toBeNull();
        expect(client.getSnapshot().threads[0]).toMatchObject({ icon: "gift", color: "blue" });
        socket.receive({
          type: "host.snapshot",
          snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
        });
        expect(client.getSnapshot().threads[0]?.icon).toBe("gift");
      } finally {
        answer();
        client.dispose();
      }
    },
  );

  it("rolls back an icon failure without a newer event and refuses mark commands on an old Host", async () => {
    const workspace = { ...makeDeployment(), kind: "project" as const, color: "green" as const };
    const thread = { ...makeThread(workspace.id), icon: "hotel" as const };
    const { answer, asked, client } = await delayedRead({
      path: "/v1/rpc/commands.dispatch",
      response: { error: { code: "bad_request", message: "Icon refused", retryable: false } },
      responseStatus: 400,
      thread,
      workspace,
    });
    try {
      const setting = client.dispatch({
        type: "thread.icon.set",
        threadId: thread.id,
        icon: null,
        idempotencyKey: "default-icon",
      });
      const refused = expect(setting).rejects.toThrow("Icon refused");
      expect(client.getSnapshot().threads[0]?.icon).toBe("document");
      await asked;
      answer();
      await refused;
      expect(client.getSnapshot().threads[0]?.icon).toBe("hotel");
    } finally {
      answer();
      client.dispose();
    }
    const old = createHttpHostClient({
      capabilities: [],
      webSocketFactory: () => new FakeSocket(),
      fetch: async () => json(bootstrap([workspace])),
    });
    try {
      await old.load();
      expect(old.getSnapshot().taskMarksAvailable).toBe(false);
      await expect(
        old.dispatch({
          type: "thread.icon.set",
          threadId: thread.id,
          icon: "plane",
          idempotencyKey: "old-icon",
        }),
      ).rejects.toThrow("does not support");
    } finally {
      old.dispose();
    }
  });

  it.each([
    ["absent", undefined],
    ["listed without devices-v1", ["task-marks-v1"]],
  ] as const)(
    "offers device switches only to a Host that says devices-v1 (capabilities %s)",
    async (_label, capabilities) => {
      const workspace = makeDeployment();
      const dispatched: string[] = [];
      const client = createHttpHostClient({
        ...(capabilities ? { capabilities: [...capabilities] } : {}),
        webSocketFactory: () => new FakeSocket(),
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/v1/rpc/commands.dispatch")
            dispatched.push(String(rpcPayload(url, init).type));
          return json(bootstrap([workspace]));
        },
      });
      try {
        await client.load();
        expect(client.getSnapshot().devicesAvailable).toBe(false);
        await expect(
          client.updateMachineAccess({
            runnerId: "rnr_33333333-3333-4333-8333-333333333333",
            expectedRevision: 1,
            policy: { reach: "owner", commands: true, forwarding: true, shares: [], apps: false },
          }),
        ).rejects.toThrow("Update this Opensteer");
        expect(dispatched).toEqual([]);
      } finally {
        client.dispose();
      }
    },
  );

  it("remembers a hydrated title when a legacy state event arrived before the Thread was loaded", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const { answer, asked, client, socket } = await delayedRead({
      loaded: false,
      path: "/v1/rpc/thread.events.list",
      response: historyPage({ ...thread, title: "Known title" }, "5"),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
              status: "idle",
              inputQueuePaused: false,
              pendingRequests: 0,
            }),
          ],
        }),
      );
      answer();
      await reading;
      expect(client.getSnapshot().threads[0]?.title).toBe("Known title");
      socket.receive({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
      });
      expect(client.getSnapshot().threads[0]?.title).toBe("Known title");
    } finally {
      client.dispose();
    }
  });

  it.each([false, true])(
    "rolls an optimistic rename back to the latest authoritative title (new event: %s)",
    async (newer) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/commands.dispatch",
        response: { error: { code: "bad_request", message: "Rename refused", retryable: false } },
        responseStatus: 400,
        thread,
        workspace,
      });
      try {
        const renaming = client.renameThread(thread.id, "  Optimistic name  ");
        const refused = expect(renaming).rejects.toThrow("Rename refused");
        expect(client.getSnapshot().threads[0]?.title).toBe("Optimistic name");
        await asked;
        if (newer)
          socket.receive(
            eventsFrame({
              type: "host.events",
              events: [
                agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
                  status: "idle",
                  inputQueuePaused: false,
                  pendingRequests: 0,
                  title: "New authoritative name",
                }),
              ],
            }),
          );
        answer();
        await refused;
        expect(client.getSnapshot().threads[0]?.title).toBe(
          newer ? "New authoritative name" : thread.title,
        );
      } finally {
        client.dispose();
      }
    },
  );

  it("does not restore a cancelled pending Request from delayed Thread history", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), pendingRequests: 1 };
    const { answer, asked, client, socket } = await delayedRead({
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, null, "1", "request.cancelled", {
              reason: "source-closed",
              requestId: createId("request"),
            }),
            agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
              status: "idle",
              inputQueuePaused: false,
              pendingRequests: 0,
            }),
          ],
          type: "host.events",
        }),
      );
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
      answer();
      await reading;
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
    } finally {
      client.dispose();
    }
  });

  it.each(["thread.access.update", "thread.execution.update", "thread.inputQueue.resume"] as const)(
    "does not restore a cancelled pending Request from a delayed %s answer",
    async (type) => {
      const workspace = makeDeployment();
      const thread = { ...makeThread(workspace.id), pendingRequests: 1 };
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/commands.dispatch",
        response: { thread: { ...thread, title: "Command answer" } },
        thread,
        workspace,
      });
      try {
        const common = { idempotencyKey: "state-update", threadId: thread.id };
        const updating = client.dispatch(
          type === "thread.access.update"
            ? { ...common, accessMode: "full-access", type }
            : type === "thread.execution.update"
              ? { ...common, harnessInstanceId, modelSelection: thread.modelSelection, type }
              : { ...common, type },
        );
        await asked;
        socket.receive(
          eventsFrame({
            events: [
              agentEvent(workspace.id, thread.id, null, "1", "request.cancelled", {
                reason: "source-closed",
                requestId: createId("request"),
              }),
              agentEvent(workspace.id, thread.id, null, "2", "thread.state-changed", {
                status: "idle",
                inputQueuePaused: false,
                pendingRequests: 0,
                title: "Current title",
              }),
            ],
            type: "host.events",
          }),
        );
        expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
        answer();
        await updating;
        expect(client.getSnapshot().threads[0]).toMatchObject({
          pendingRequests: 0,
          title: "Current title",
        });
      } finally {
        client.dispose();
      }
    },
  );

  it.each([true, false])(
    "keeps realtime Thread state and transcript across a late create answer (created event: %s)",
    async (createdEvent) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const message = makeMessage(thread.id, "assistant", "Already here");
      const { answer, asked, client, socket } = await delayedRead({
        loaded: false,
        path: "/v1/rpc/commands.dispatch",
        response: { thread: { ...thread, title: "Command answer" }, wasDuplicate: false },
        thread,
        workspace,
      });
      try {
        const creating = client.dispatch({
          accessMode: thread.accessMode,
          environmentId,
          harnessInstanceId,
          idempotencyKey: "state-create",
          modelSelection: thread.modelSelection,
          title: thread.title,
          type: "thread.create",
        });
        await asked;
        client.activateThread(thread.id);
        socket.receive(
          eventsFrame({
            events: [
              ...(createdEvent
                ? [agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread })]
                : []),
              ...stateEvents(workspace, thread),
              agentEvent(workspace.id, thread.id, message.runId, "6", "message.created", {
                input: null,
                message,
              }),
            ],
            type: "host.events",
          }),
        );
        const transcript = client.getSnapshot().transcripts[thread.id];
        expect(transcript).toEqual(
          expect.arrayContaining([expect.objectContaining({ body: "Already here" })]),
        );
        answer();
        await creating;
        expect(client.getSnapshot().threads).toEqual([
          expect.objectContaining({
            id: thread.id,
            inputQueuePaused: true,
            pendingRequests: 1,
            status: "waiting",
            title: "Current title",
          }),
        ]);
        expect(client.getSnapshot().transcripts[thread.id]).toEqual(transcript);
      } finally {
        client.dispose();
      }
    },
  );

  it.each(["1", "4"])(
    "reconciles history at its sequence cut %s even when the last history event is older",
    async (asOfSequence) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const pageThread = {
        ...thread,
        ...(asOfSequence === "4"
          ? { inputQueuePaused: true, pendingRequests: 1, status: "waiting" as const }
          : {}),
      };
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/thread.events.list",
        response: historyPage(pageThread, asOfSequence, [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
        ]),
        thread,
        workspace,
      });
      try {
        socket.receive(
          eventsFrame({ events: stateEvents(workspace, thread), type: "host.events" }),
        );
        const reading = client.loadLatestTranscript(thread.id);
        await asked;
        answer();
        await reading;
        expect(client.getSnapshot().threads[0]).toMatchObject({
          inputQueuePaused: true,
          pendingRequests: 1,
          status: "waiting",
        });
      } finally {
        client.dispose();
      }
    },
  );

  it("applies absolute state once while Request events leave the count unchanged", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const opened = stateEvents(workspace, thread).find((event) => event.type === "request.opened")!;
    if (opened.type !== "request.opened") throw new Error("Expected a Request event");
    const { answer, asked, client, socket } = await delayedRead({
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      const events = [
        agentEvent(workspace.id, thread.id, null, "1", "request.cancelled", {
          reason: "source-closed",
          requestId: createId("request"),
        }),
        agentEvent(workspace.id, thread.id, null, "2", "request.resolved", {
          request: {
            ...opened.data.request,
            resolvedAt: now,
            resolvedBy: ownerId,
            response: { kind: "choice", optionId: "allow" },
            status: "fulfilled",
          },
        }),
        opened,
      ];
      socket.receive(eventsFrame({ events, type: "host.events" }));
      socket.receive(eventsFrame({ events, type: "host.events" }));
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
              status: "waiting",
              inputQueuePaused: false,
              pendingRequests: 1,
            }),
          ],
          type: "host.events",
        }),
      );
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
      answer();
      await reading;
      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    } finally {
      client.dispose();
    }
  });

  it(
    "preserves loaded state after the unloaded state map evicts older Threads",
    { timeout: 30_000 },
    async () => {
      const workspace = makeDeployment();
      const thread = { ...makeThread(workspace.id), pendingRequests: 2 };
      const loadedChange = "2026-08-09T20:01:00.000Z";
      const lastChange = "2026-08-09T20:02:00.000Z";
      const { answer, asked, client, socket } = await delayedRead({
        path: "/v1/rpc/thread.events.list",
        response: historyPage(thread),
        thread,
        workspace,
      });
      try {
        socket.receive(
          eventsFrame({
            events: stateEvents(workspace, thread).map((event) =>
              event.sequence === "5" ? { ...event, createdAt: loadedChange } : event,
            ),
            type: "host.events",
          }),
        );
        const transcripts = client.getSnapshot().transcripts;
        expect(Object.keys(transcripts)).toEqual([thread.id]);
        for (let sequence = 6; sequence < 4103; sequence += 1) {
          socket.receive(
            eventsFrame({
              events: [
                {
                  ...agentEvent(
                    workspace.id,
                    createId("thread"),
                    null,
                    String(sequence),
                    "thread.state-changed",
                    {
                      status: "running",
                      inputQueuePaused: false,
                      pendingRequests: 0,
                    },
                  ),
                  createdAt: sequence === 4102 ? lastChange : now,
                },
              ],
              type: "host.events",
            }),
          );
        }
        // State is not transcript: an unloaded Thread's state change creates no
        // transcript, and copying the map for each one made this traffic quadratic.
        const evicted = client.getSnapshot();
        expect(Object.keys(evicted.transcripts)).toEqual([thread.id]);
        expect(evicted.transcripts).toBe(transcripts);
        expect(evicted.threads[0]?.updatedAt).toBe(loadedChange);
        expect(parseSent(socket, socket.sent.length - 1)).toMatchObject({
          sequence: "4102",
          type: "client.ack",
        });
        const reading = client.loadLatestTranscript(thread.id);
        await asked;
        answer();
        await reading;
        expect(client.getSnapshot().threads[0]).toMatchObject({
          inputQueuePaused: true,
          pendingRequests: 1,
          status: "waiting",
        });
      } finally {
        client.dispose();
      }
    },
  );

  it("keeps an HTTP history page ahead of websocket state", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const current = {
      ...thread,
      pendingRequests: 1,
      inputQueuePaused: true,
      status: "waiting" as const,
    };
    const { answer, asked, client, socket } = await delayedRead({
      loaded: true,
      path: "/v1/rpc/thread.events.list",
      response: historyPage(current, "10"),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      answer();
      await reading;
      socket.receive(eventsFrame({ events: stateEvents(workspace, thread), type: "host.events" }));
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, null, "6", "thread.state-changed", {
              inputQueuePaused: false,
              pendingRequests: 0,
              status: "running",
            }),
          ],
          type: "host.events",
        }),
      );
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: true,
        pendingRequests: 1,
        status: "waiting",
      });
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, null, "11", "thread.state-changed", {
              inputQueuePaused: false,
              pendingRequests: 0,
              status: "running",
            }),
          ],
          type: "host.events",
        }),
      );
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: false,
        pendingRequests: 0,
        status: "running",
      });
    } finally {
      client.dispose();
    }
  });

  it("keeps a reconnect snapshot newer than outstanding history", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const { answer, asked, client, reread, socket } = await delayedRead({
      freshHistory: historyPage(
        { ...thread, status: "waiting", pendingRequests: 1, inputQueuePaused: true },
        "10",
      ),
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread, "1"),
      thread,
      workspace,
    });
    try {
      const reading = client.loadLatestTranscript(thread.id);
      await asked;
      socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...deploymentSnapshot(workspace, "10"),
          threads: [{ ...thread, status: "waiting", pendingRequests: 1, inputQueuePaused: true }],
        },
      });
      answer();
      await reading;
      expect(reread).toHaveBeenCalledOnce();
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: true,
        pendingRequests: 1,
        status: "waiting",
      });
    } finally {
      client.dispose();
    }
  });

  it("rereads outstanding history for an observed Thread omitted by a reconnect snapshot", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const current = {
      ...thread,
      status: "waiting" as const,
      pendingRequests: 1,
      inputQueuePaused: true,
    };
    const { answer, asked, client, reread, socket } = await delayedRead({
      freshHistory: historyPage(current, "10"),
      loaded: false,
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread, "1"),
      thread,
      workspace,
    });
    const installed: ThreadSummary[] = [];
    client.subscribe(() => {
      const summary = client.getSnapshot().threads.find(({ id }) => id === thread.id);
      if (summary) installed.push(summary);
    });
    const stopObserving = client.observeThread(thread.id);
    try {
      await asked;
      socket.receive({ type: "host.snapshot", snapshot: deploymentSnapshot(workspace, "10") });
      answer();
      await vi.waitFor(() => {
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)).toMatchObject({
          status: "waiting",
          inputQueuePaused: true,
          pendingRequests: 1,
        });
      });
      expect(reread).toHaveBeenCalledOnce();
      expect(
        installed.every(
          (summary) =>
            summary.status === "waiting" &&
            summary.inputQueuePaused &&
            summary.pendingRequests === 1,
        ),
      ).toBe(true);
    } finally {
      stopObserving();
      client.dispose();
    }
  });

  it("rereads retained state below the reconnect floor even when newer than history", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const current = {
      ...thread,
      status: "waiting" as const,
      pendingRequests: 1,
      inputQueuePaused: true,
    };
    const { answer, asked, client, reread, socket } = await delayedRead({
      freshHistory: historyPage(current, "10"),
      path: "/v1/rpc/thread.events.list",
      response: historyPage(thread, "1"),
      thread,
      workspace,
    });
    socket.receive({
      type: "host.snapshot",
      snapshot: { ...deploymentSnapshot(workspace, "2"), threads: [thread] },
    });
    const stop = client.observeThread(thread.id);
    try {
      await asked;
      socket.receive({ type: "host.snapshot", snapshot: deploymentSnapshot(workspace, "10") });
      answer();
      await vi.waitFor(() => expect(reread).toHaveBeenCalledOnce());
      expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)).toMatchObject({
        status: current.status,
        pendingRequests: current.pendingRequests,
        inputQueuePaused: current.inputQueuePaused,
      });
    } finally {
      stop();
      client.dispose();
    }
  });

  it.each(["history", "command"] as const)(
    "caps %s rereads while coverage keeps advancing",
    async (source) => {
      const workspace = makeDeployment();
      const thread = { ...makeThread(workspace.id), status: "running" as const };
      const socket = new FakeSocket();
      let reads = 0;
      const client = createHttpHostClient({
        fetch: async (input) => {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
          if (path === "/v1/rpc/commands.dispatch")
            return json({
              type: "thread.create",
              thread,
              asOfSequence: "1",
              wasDuplicate: false,
            });
          if (path === "/v1/rpc/thread.events.list") {
            reads += 1;
            if (reads > 5) throw new Error("uncapped Thread history reread");
            socket.receive({
              type: "host.snapshot",
              snapshot: deploymentSnapshot(workspace, String(10 + reads)),
            });
            return json(
              historyPage(
                { ...thread, status: "waiting", pendingRequests: reads, inputQueuePaused: true },
                String(1 + reads),
              ),
            );
          }
          throw new Error(`Unexpected request ${path}`);
        },
        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...deploymentSnapshot(workspace, "10"),
          threads: [],
          threadWindow: {
            byteCount: 2,
            hasMore: true,
            itemCount: 0,
            nextBefore: "older_threads",
            totalItems: 2,
          },
        },
      });
      try {
        if (source === "history") {
          await expect(client.loadLatestTranscript(thread.id)).rejects.toThrow(
            "connection changed",
          );
          expect(reads).toBe(4);
          expect(client.getSnapshot().threads.some(({ id }) => id === thread.id)).toBe(false);
          return;
        } else
          await client.dispatch({
            type: "thread.create",

            environmentId,
            harnessInstanceId,
            modelSelection: thread.modelSelection,
            title: thread.title,
            idempotencyKey: "reread-cap",
          });
        expect(reads).toBe(3);
        expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)).toMatchObject({
          status: "waiting",
          pendingRequests: reads,
          inputQueuePaused: true,
        });
      } finally {
        client.dispose();
      }
    },
  );

  it("does not replay a Request already represented by an unloaded creation answer", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const { answer, asked, client, socket } = await delayedRead({
      loaded: false,
      path: "/v1/rpc/commands.dispatch",
      response: {
        asOfSequence: "10",
        thread: { ...thread, status: "waiting", inputQueuePaused: true, pendingRequests: 1 },
        wasDuplicate: true,
      },
      thread,
      workspace,
    });
    try {
      const creating = client.dispatch({
        type: "thread.create",
        idempotencyKey: "duplicate-cut",
        accessMode: thread.accessMode,
        environmentId,
        harnessInstanceId,
        modelSelection: thread.modelSelection,
        title: thread.title,
      });
      await asked;
      socket.receive(eventsFrame({ type: "host.events", events: stateEvents(workspace, thread) }));
      answer();
      await creating;
      expect(client.getSnapshot().threads[0]).toMatchObject({
        inputQueuePaused: true,
        pendingRequests: 1,
        status: "waiting",
      });
    } finally {
      client.dispose();
    }
  });

  it("keeps the visible order and transcript after a late creation answer", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const { answer, asked, client, socket } = await delayedRead({
      loaded: false,
      path: "/v1/rpc/commands.dispatch",
      response: { asOfSequence: "1", thread, wasDuplicate: false },
      thread,
      workspace,
    });
    try {
      const creating = client.dispatch({
        type: "thread.create",
        idempotencyKey: "late-order",
        accessMode: thread.accessMode,
        environmentId,
        harnessInstanceId,
        modelSelection: thread.modelSelection,
        title: thread.title,
      });
      await asked;
      const other = { ...makeThread(workspace.id), updatedAt: "2090-01-01T00:00:00.000Z" };
      const latest = { ...thread, updatedAt: "2091-01-01T00:00:00.000Z" };
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, other.id, null, "1", "thread.created", { thread: other }),
            agentEvent(workspace.id, thread.id, null, "2", "thread.created", { thread: latest }),
            {
              ...agentEvent(workspace.id, thread.id, null, "3", "message.created", {
                input: null,
                message: makeMessage(thread.id, "assistant", "Keep this"),
              }),
              createdAt: latest.updatedAt,
            },
          ],
        }),
      );
      const before = client.getSnapshot();
      const order = (threads: typeof before.threads) =>
        [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id }) => id);
      answer();
      await creating;
      expect(order(client.getSnapshot().threads)).toEqual(order(before.threads));
      expect(client.getSnapshot().threads.map(({ id }) => id)).toEqual(
        before.threads.map(({ id }) => id),
      );
      expect(client.getSnapshot().transcripts[thread.id]).toEqual(before.transcripts[thread.id]);
      expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.updatedAt).toBe(
        before.threads.find(({ id }) => id === thread.id)?.updatedAt,
      );
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient lifecycle", () => {
  it("avoids polling and pauses reconnect backoff while backgrounded", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    let bootstrapCalls = 0;
    const client = createHttpHostClient({
      fetch: async () => {
        bootstrapCalls += 1;
        return json(bootstrap([workspace]));
      },
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]?.open();
    sockets[0]?.receive({ type: "host.synchronized", sequence: sequence("0") });
    await vi.advanceTimersByTimeAsync(2_500);
    const polledWhileVisible = bootstrapCalls;
    expect(polledWhileVisible).toBe(1);

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bootstrapCalls).toBe(polledWhileVisible);
    // The socket stays: the operating system decides whether it survives.
    expect(sockets[0]?.closeEvents).toEqual([]);

    // A socket lost while hidden waits for the return rather than backing off.
    sockets[0]?.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    client.dispose();
  });

  it("keeps reconnecting while hidden when it shows the person's notifications", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]?.open();
    const unsubscribe = client.subscribeNotifications(() => undefined);

    platform.enterBackground();
    // Hidden is when a notification is worth showing, so a lost socket returns.
    sockets[0]?.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBeGreaterThan(1);
    const reopened = sockets.length;
    sockets.at(-1)?.open();

    // A network handover replaces it while hidden, too.
    platform.changeNetwork("online");
    expect(sockets.length).toBe(reopened + 1);

    // With nobody listening, hidden sockets wait for the return again.
    unsubscribe();
    sockets.at(-1)?.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBe(reopened + 1);

    // A listener that arrives while hidden reopens what was left closed.
    client.subscribeNotifications(() => undefined);
    expect(sockets.length).toBe(reopened + 2);
    client.dispose();
  });

  describe("what a person is told about the connection", () => {
    function connected(
      workspaces = [makeDeployment()],
      options: {
        readonly fetch?: () => Promise<Response>;
      } = {},
    ) {
      vi.useFakeTimers();
      const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
      const sockets: FakeSocket[] = [];
      const client = createHttpHostClient({
        fetch: options.fetch ?? (async () => json(bootstrap(workspaces))),
        lifecycle: platform.lifecycle,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      const synchronize = (socket: FakeSocket, workspace = workspaces[0]!) => {
        socket.open();
        socket.receive({ snapshot: deploymentSnapshot(workspace, "4"), type: "host.snapshot" });
        socket.receive({
          sequence: sequence("4"),
          type: "host.synchronized",
        });
      };
      const label = () => describeHostConnection(client.getSnapshot()).label;
      return { client, label, platform, sockets, synchronize };
    }

    it("keeps a socket that answers after a notification for the path it is on", async () => {
      const host = connected();
      await host.client.load();
      host.synchronize(host.sockets[0]!);

      host.platform.changeNetwork("online", "same");
      host.sockets[0]!.receive({ nonce: sentPingNonce(host.sockets[0]!)!, type: "host.pong" });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(host.sockets).toHaveLength(1);
      expect(host.client.getSnapshot().connection).toBe("connected");
      host.client.dispose();
    });

    it("follows a move it could not see when the socket stops answering", async () => {
      const host = connected();
      await host.client.load();
      host.synchronize(host.sockets[0]!);
      const events: string[] = [];
      host.client.subscribeLifecycle?.((event) => events.push(event));

      host.platform.changeNetwork("online", "same");
      expect(host.sockets).toHaveLength(1);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(socketProbeDeadlineMs);

      // Every other socket on the path goes too: only this one could be asked.
      expect(events).toEqual(["network"]);
      expect(host.sockets).toHaveLength(2);
      host.client.dispose();
    });

    it("follows that move through a probe already in the air", async () => {
      const host = connected();
      await host.client.load();
      host.synchronize(host.sockets[0]!);
      const events: string[] = [];
      host.client.subscribeLifecycle?.((event) => events.push(event));

      await vi.advanceTimersByTimeAsync(realtimeIdleProbeMs + realtimeIdleProbeDeadlineMs / 2);
      expect(sentPingNonce(host.sockets[0]!)).toBeTruthy();
      console.log(
        "PROBE before",
        host.client.connection.getSnapshot().phase,
        host.client.connection.getSnapshot().epoch,
        host.client.connection.getSnapshot().pathRevision,
      );
      host.platform.changeNetwork("online", "same");
      await vi.advanceTimersByTimeAsync(realtimeIdleProbeDeadlineMs);

      console.log(
        "PROBE after",
        host.client.connection.getSnapshot().phase,
        host.client.connection.getSnapshot().epoch,
        host.client.connection.getSnapshot().pathRevision,
        host.sockets.length,
      );
      expect(events).toEqual(["network"]);
      expect(host.sockets).toHaveLength(2);
      host.client.dispose();
    });

    it("says nothing about a reconnect that finishes inside the hold", async () => {
      const host = connected();
      await host.client.load();
      host.synchronize(host.sockets[0]!);
      const seen = new Set<string>();
      host.client.subscribe(() => seen.add(host.label()));

      host.sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs - 1);
      expect(host.client.getSnapshot().connection).toBe("connecting");
      host.synchronize(host.sockets.at(-1)!);
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs);

      expect(seen).toEqual(new Set(["Connected"]));
      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      host.client.dispose();
    });

    it("says so once the hold passes, and stops when the connection is back", async () => {
      const host = connected();
      await host.client.load();
      host.synchronize(host.sockets[0]!);

      host.sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs);
      expect(host.client.connection.getSnapshot().trying).toBe(true);

      for (const socket of host.sockets.slice(1)) if (socket.readyState === 0) socket.open();
      host.synchronize(host.sockets.at(-1)!);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      expect(host.label()).toBe("Connected");
      host.client.dispose();
    });

    it("counts no time while hidden, so a frozen timer cannot fire on the way back", async () => {
      const host = connected();
      await host.client.load();
      host.synchronize(host.sockets[0]!);

      host.sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(true);

      host.platform.enterBackground();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      host.platform.enterForeground();

      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs - 1);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(true);
      host.client.dispose();
    });

    it("still says a Host that never answered when the app comes back", async () => {
      const host = connected([], {
        fetch: async () => {
          throw new TypeError("Network request failed");
        },
      });
      await expect(host.client.load()).rejects.toThrow();
      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(true);
      host.platform.enterBackground();
      host.platform.enterForeground();
      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(true);
      host.client.dispose();
    });

    it("holds through a moment with no network in the middle of a handover", async () => {
      const host = connected();
      await host.client.load();
      host.synchronize(host.sockets[0]!);

      host.platform.changeNetwork("offline");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      host.platform.changeNetwork("online");
      host.synchronize(host.sockets.at(-1)!);
      await vi.advanceTimersByTimeAsync(connectionInterruptionHoldMs);

      expect(host.client.getSnapshot().connectionInterrupted).toBe(false);
      host.client.dispose();
    });

    it("reads one way through an outage and tries again when asked", async () => {
      const workspace = makeDeployment();
      let up = true;
      const host = connected([workspace], {
        fetch: async () => {
          if (!up) throw new TypeError("Network request failed");
          return json(bootstrap([workspace]));
        },
      });
      await host.client.load();
      host.synchronize(host.sockets[0]!);
      up = false;
      host.sockets[0]!.serverClose();

      const labels = new Set<string>();
      let settled = false;
      host.client.subscribe(() => {
        if (settled) labels.add(host.label());
      });
      for (let elapsed = 0; elapsed < 90_000; elapsed += 1_000) {
        await vi.advanceTimersByTimeAsync(1_000);
        settled = elapsed >= 16_000;
        const socket = host.sockets.at(-1)!;
        if (socket.readyState === 0) socket.serverClose();
      }
      expect(host.client.connection.getSnapshot().showInterruption).toBe(true);
      expect(host.client.connection.getSnapshot().phase).toBe("recovering");

      // A new network is worth hoping for, with the pill already up.
      host.platform.changeNetwork("online");
      expect(host.client.connection.getSnapshot().trying).toBe(true);

      up = true;
      const retried = host.client.refresh({ retryConnection: true });
      expect(host.client.connection.getSnapshot().trying).toBe(true);
      await retried;
      host.synchronize(host.sockets.at(-1)!);
      expect(host.label()).toBe("Connected");
      host.client.dispose();
    });
  });

  it("keeps a briefly backgrounded socket that answers its correlated probe", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: deploymentSnapshot(workspace, "4"), type: "host.snapshot" });
    socket.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
    });

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(5_000);
    platform.enterForeground();

    const nonce = sentPingNonce(socket);
    expect(nonce).toBeTruthy();
    socket.receive({ nonce: nonce!, type: "host.pong" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets).toHaveLength(1);
    expect(socket.closeEvents).toEqual([]);
    expect(client.getSnapshot().connection).toBe("connected");
    client.dispose();
  });

  it("replaces a socket that never answers its probe and resumes from its cursor", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const dead = sockets[0]!;
    dead.open();
    dead.receive({ snapshot: deploymentSnapshot(workspace, "7"), type: "host.snapshot" });
    dead.receive({ sequence: sequence("7"), type: "host.synchronized" });

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(5_000);
    platform.enterForeground();
    expect(sentPingNonce(dead)).toBeTruthy();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(dead.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "7", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    client.dispose();
  });

  it("replaces a silent lease and backs off an unsynchronized replacement before resuming", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment(),
      sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      realtimeLiveness: { idleMs: 1000, deadlineMs: 1000 },
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 4000,
      random: () => 1,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      const first = sockets[0]!;
      first.open();
      first.receive({ snapshot: deploymentSnapshot(workspace, "7"), type: "host.snapshot" });
      first.receive({ sequence: sequence("7"), type: "host.synchronized" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(first.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(2000);
      expect(sockets[1]!.closeEvents).toEqual([{ code: 1000, reason: "Realtime channel silent" }]);
      await vi.advanceTimersByTimeAsync(1999);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(3);
      const healthy = sockets[2]!;
      healthy.open();
      expect(parseSent(healthy, 0)).toMatchObject({
        type: "client.subscribe",
        cursor: { afterSequence: "7" },
      });
      healthy.receive({ sequence: sequence("7"), type: "host.synchronized" });
      expect(client.connection.getSnapshot()).toMatchObject({ phase: "ready", readyRevision: 2 });
      await vi.advanceTimersByTimeAsync(1500);
      healthy.receive({ nonce: sentPingNonce(healthy)!, type: "host.pong" });
      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(3);
      expect(healthy.closeEvents).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it("keeps a probed channel whose subscription delivers before the answer does", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      realtimeLiveness: { deadlineMs: 1_000, idleMs: 1_000 },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: deploymentSnapshot(workspace, "4"), type: "host.snapshot" });
    socket.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sentPingNonce(socket)).toBeTruthy();
    // A slow route can hold the answer behind frames that prove the socket works.
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "running",
          }),
        ],
        type: "host.events",
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sockets).toHaveLength(1);
    expect(socket.closeEvents).toEqual([]);
    client.dispose();
  });

  it("watches retained sockets again when a listener arrives while hidden", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      realtimeLiveness: { deadlineMs: 1_000, idleMs: 1_000 },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: deploymentSnapshot(workspace, "4"), type: "host.snapshot" });
    socket.receive({
      sequence: sequence("4"),
      type: "host.synchronized",
    });

    // Hidden with nobody listening, nothing is judged and the socket is kept.
    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sentPingNonce(socket)).toBeUndefined();

    // A listener makes the hidden socket worth keeping alive, so it is watched again.
    client.subscribeNotifications(() => undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentPingNonce(socket)).toBeTruthy();
    expect(socket.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(sockets).toHaveLength(2);
    client.dispose();
  });

  it("replaces every socket without probing when the background outlived the trust window", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const stale = sockets[0]!;
    stale.open();
    stale.receive({ snapshot: deploymentSnapshot(workspace, "9"), type: "host.snapshot" });
    stale.receive({
      sequence: sequence("9"),
      type: "host.synchronized",
    });

    platform.enterBackground();
    await vi.advanceTimersByTimeAsync(10_000);
    platform.enterForeground();

    expect(sentPingNonce(stale)).toBeUndefined();
    expect(stale.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "9", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    client.dispose();
  });

  it("replaces sockets on a network handover and waits out an offline interface", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({ snapshot: deploymentSnapshot(workspace, "3"), type: "host.snapshot" });
    first.receive({
      sequence: sequence("3"),
      type: "host.synchronized",
    });

    platform.changeNetwork("offline");
    expect(first.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(client.getSnapshot().connection).toBe("offline");
    expect(client.getSnapshot().network).toBe("offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);

    platform.changeNetwork("online");
    expect(sockets).toHaveLength(2);
    expect(client.getSnapshot().network).toBe("online");
    expect(client.getSnapshot().connection).toBe("connecting");
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "3", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    client.dispose();
  });

  it("replaces sockets on a handover that never leaves the online state", async () => {
    const workspace = makeDeployment();
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const wifi = sockets[0]!;
    wifi.open();
    wifi.receive({ snapshot: deploymentSnapshot(workspace, "5"), type: "host.snapshot" });
    wifi.receive({ sequence: sequence("5"), type: "host.synchronized" });

    // Wi-Fi to cellular reports "online" on both sides of the move, and the
    // interface it left never reports the socket dead.
    platform.changeNetwork("online");

    expect(wifi.closeEvents).toEqual([{ code: 1000, reason: "Client closed" }]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "5", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    client.dispose();
  });

  it("opens no socket for a bootstrap that lands after the app was hidden", async () => {
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const sockets: FakeSocket[] = [];
    const gate: Array<() => void> = [];
    let gated = true;
    const client = createHttpHostClient({
      fetch: async () => {
        if (gated) {
          gated = false;
          await new Promise<void>((resolve) => gate.push(resolve));
        }
        return json(bootstrap([workspace]));
      },
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const loaded = client.load();
    platform.enterBackground();
    gate[0]?.();
    await loaded;

    // The Workspace channel exists and holds its cursor; only the socket waits.
    expect(sockets).toEqual([]);
    platform.enterForeground();
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(parseSent(sockets[0]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "0", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    client.dispose();
  });

  it("opens no socket for a refresh that lands while the device is offline", async () => {
    const workspace = makeDeployment();
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const first = sockets[0]!;
    first.open();
    first.receive({ snapshot: deploymentSnapshot(workspace, "2"), type: "host.snapshot" });
    first.receive({
      sequence: sequence("2"),
      type: "host.synchronized",
    });

    platform.changeNetwork("offline");
    await client.refresh();
    expect(sockets).toHaveLength(1);

    platform.changeNetwork("online");
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "2", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    client.dispose();
  });

  it("releases its platform listeners when it is disposed", async () => {
    const workspace = makeDeployment();
    const platform = fakeLifecycle();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      lifecycle: platform.lifecycle,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();
    expect(platform.listenerCount()).toBe(3);
    client.dispose();
    expect(platform.listenerCount()).toBe(0);
  });

  it("surfaces a Host channel error through the connection state", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      random: () => 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 40,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const retried = sockets[0]!;
    retried.open();
    retried.receive({ snapshot: deploymentSnapshot(workspace, "1"), type: "host.snapshot" });
    retried.receive({
      sequence: sequence("1"),
      type: "host.synchronized",
    });

    retried.receive({
      error: { code: "internal", message: "The Workspace stream faulted.", retryable: true },
      type: "host.error",
    });
    expect(client.getSnapshot().connection).toBe("connecting");
    await vi.advanceTimersByTimeAsync(40);
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    sockets[1]!.receive({
      error: { code: "bad_message", message: "This Workspace is not yours.", retryable: false },
      type: "host.error",
    });
    expect(client.getSnapshot().connection).toBe("offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    client.dispose();
  });
});

describe("HttpHostClient notifications", () => {
  function replyNotification(_deploymentId: string): NotificationView {
    return {
      body: "Your flight moved to 8 pm.",
      id: createId("notification"),
      kind: "reply-published",
      messageId: createId("message"),
      occurredAt: now,
      requestId: null,
      runId: createId("run"),
      threadId: createId("thread"),
      title: "Opensteer",
    };
  }

  it("delivers a notification once when the Deployment socket repeats it, and never to a later viewer", async () => {
    const home = makeDeployment("Main");
    const other = makeDeployment("Research");
    const sockets: FakeSocket[] = [];
    let signedIn = true;
    const client = createHttpHostClient({
      fetch: async () =>
        signedIn
          ? json(bootstrap([home, other]))
          : json({ error: { code: "unauthorized", message: "Sign in again." } }, 401),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const delivered: NotificationView[] = [];
    client.subscribeNotifications((notification) => delivered.push(notification));
    const failing = client.subscribeNotifications(() => {
      throw new Error("A listener's own fault.");
    });
    await client.load();

    expect(sockets).toHaveLength(1);
    for (const socket of sockets) socket.open();

    const reply = replyNotification(home.id);
    const raised = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(() => undefined);
    for (let repeat = 0; repeat < 2; repeat += 1)
      sockets[0]!.receive({ notification: reply, type: "host.notification" });
    const raisedCount = raised.mock.calls.length;
    raised.mockRestore();
    expect(delivered).toEqual([reply]);
    // Neither the frame, which names no Workspace of the socket's, nor the
    // failing listener costs a socket the Host will not replay it on.
    expect(raisedCount).toBe(1);
    expect(sockets.flatMap((socket) => socket.closeEvents)).toEqual([]);
    failing();

    signedIn = false;
    await expect(client.refresh()).rejects.toThrow();
    sockets[0]!.receive({
      notification: replyNotification(other.id),
      type: "host.notification",
    });
    expect(delivered).toEqual([reply]);
    client.dispose();
  });

  it("reports the viewer's time zone once per zone, again after a lost answer, never after a refusal", async () => {
    const workspace = makeDeployment();
    let zone: string | undefined = "America/New_York";
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return {
        ...resolvedOptions.call(this),
        timeZone: zone,
      } as Intl.ResolvedDateTimeFormatOptions;
    });
    const reports: unknown[] = [];
    let answer: "lost" | "refused" | "accepted" = "lost";
    const client = createHttpHostClient({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname !== "/v1/rpc/commands.dispatch") return json(bootstrap([workspace]));
        const command = rpcPayload(url, init);
        reports.push(command.timeZone);
        if (answer === "lost") return json({ error: { code: "internal", message: "Lost" } }, 500);
        if (answer === "refused")
          return json({ error: { code: "bad_request", message: "Unknown zone" } }, 400);
        return json({ timeZone: command.timeZone });
      },
      timeZoneReports: "observed",
      webSocketFactory: () => new FakeSocket(),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    await client.load();
    await settle();
    expect(reports).toEqual(["America/New_York"]);
    answer = "accepted";
    await client.refresh();
    await settle();
    await client.refresh();
    await settle();
    expect(reports).toEqual(["America/New_York", "America/New_York"]);

    zone = "Europe/Paris";
    answer = "refused";
    await client.refresh();
    await settle();
    await client.refresh();
    await settle();
    expect(reports).toEqual(["America/New_York", "America/New_York", "Europe/Paris"]);

    for (const unreadable of [undefined, "Not/AZone"]) {
      zone = unreadable;
      await client.refresh();
      await settle();
    }
    expect(reports).toHaveLength(3);
    vi.restoreAllMocks();
    client.dispose();
  });

  it.each([true, false])(
    "states a message's app, device and send-time zone only to a Host that reads them (%s)",
    async (reads) => {
      const workspace = makeDeployment();
      let zone = "America/New_York";
      const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
      vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
        this: Intl.DateTimeFormat,
      ) {
        return { ...resolvedOptions.call(this), timeZone: zone };
      });
      const commands: Record<string, unknown>[] = [];
      const client = createHttpHostClient({
        capabilities: reads ? ["message-origin-v1"] : [],
        origin: { app: "ios", device: "phone" },
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (url.pathname !== "/v1/rpc/commands.dispatch") return json(bootstrap([workspace]));
          commands.push(rpcPayload(url, init));
          return json({ error: { code: "bad_request", message: "Recorded" } }, 400);
        },
        timeZoneReports: "observed",
        webSocketFactory: () => new FakeSocket(),
      });
      await client.load();
      zone = "Asia/Tokyo";
      await client
        .dispatch({
          content: [{ text: "Remind me at 9", type: "text" }],
          idempotencyKey: "send-1",
          threadId: createId("thread"),
          type: "thread.sendMessage",
        })
        .catch(() => undefined);
      const sent = commands.find((command) => command.type === "thread.sendMessage");
      expect(sent?.origin).toEqual(
        reads ? { app: "ios", device: "phone", timeZone: "Asia/Tokyo" } : undefined,
      );
      expect(commands.some((command) => command.type === "viewer.timeZone.update")).toBe(!reads);
      vi.restoreAllMocks();
      client.dispose();
    },
  );
});

describe("HttpHostClient Run activity and live streams", () => {
  function emptyWindow() {
    return { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  }

  function historyPage(thread: Thread, events: AgentEvent[] = []) {
    return {
      events,
      thread,
      threadId: thread.id,
      window: { ...emptyWindow(), itemCount: events.length, threadId: thread.id },
    };
  }

  function activityOf(client: HttpHostClient, threadId: string) {
    const snapshot = client.getSnapshot();
    const thread = snapshot.threads.find(({ id }) => id === threadId);
    if (!thread) throw new Error("Thread not projected.");
    return {
      activity: threadActivity({
        entries: snapshot.transcripts[threadId] ?? [],
        runQueue: snapshot.runQueue,
        thread,
      }),
      stop: threadStopTarget({ runQueue: snapshot.runQueue, thread })?.id ?? null,
    };
  }

  function liveFrame(
    _deploymentId: string,
    threadId: Thread["id"],
    runId: NonNullable<AgentEvent["runId"]>,
    afterSequence: string,
    items: Extract<HostToClientMessage, { type: "host.live" }>["progress"]["items"],
  ): HostToClientMessage {
    return {
      afterSequence: sequence(afterSequence),
      progress: { items, runId, threadId },
      type: "host.live",
    };
  }

  it("derives one activity and Stop target from Host state, the Run queue and a requested Stop", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const interrupted: string[] = [];
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/rpc/commands.dispatch") {
          interrupted.push(requiredString(rpcPayload(url, init), "runId"));
          return json({ wasDuplicate: false }, 202);
        }
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => socket,
    });
    const state = (
      at: string,
      status: Thread["status"],
      pendingRequests = 0,
      inputQueuePaused = false,
    ) =>
      agentEvent(workspace.id, thread.id, null, at, "thread.state-changed", {
        inputQueuePaused,
        pendingRequests,
        status,
      });
    try {
      await client.load();
      client.activateThread(thread.id);
      socket.open();
      socket.receive({
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      expect(activityOf(client, thread.id)).toEqual({ activity: "idle", stop: null });

      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "1", "run.queued", {
              run: {
                createdAt: now,
                id: runId,
                runOrdinal: 0,
                status: "queued",
                threadId: thread.id,
              },
            }),
            state("2", "running"),
          ],
          type: "host.events",
        }),
      );
      // A Run can wait minutes for its computer or AI account; Stop reaches it there.
      expect(activityOf(client, thread.id)).toEqual({ activity: "queued", stop: runId });
      // Behind a paused queue it is already held for the person.
      socket.receive(
        eventsFrame({ events: [state("3", "running", 0, true)], type: "host.events" }),
      );
      expect(activityOf(client, thread.id)).toEqual({ activity: "queued", stop: null });
      socket.receive(eventsFrame({ events: [state("4", "running")], type: "host.events" }));
      expect(activityOf(client, thread.id)).toEqual({ activity: "queued", stop: runId });

      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "5", "run.started", { status: "running" }),
          ],
          type: "host.events",
        }),
      );
      expect(activityOf(client, thread.id)).toEqual({ activity: "working", stop: runId });

      const request = pendingRequest({
        presentation: {
          detail: "Publish the release",
          kind: "choice",
          options: [{ hint: "confirm", id: "allow", label: "Publish" }],
          risk: "high",
          title: "Publish externally",
        },
        runId,
        threadId: thread.id,
        deploymentId: workspace.id,
      });
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "6", "request.opened", { request }),
            state("7", "waiting", 1),
          ],
          type: "host.events",
        }),
      );
      expect(activityOf(client, thread.id)).toEqual({ activity: "waiting_for_you", stop: runId });

      await client.stopRun(thread.id);
      expect(interrupted).toEqual([runId]);
      expect(activityOf(client, thread.id)).toEqual({ activity: "stopping", stop: runId });
      // The Runner may still report the turn while the interrupt reaches it.
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "8", "run.status", { status: "running" }),
          ],
          type: "host.events",
        }),
      );
      expect(activityOf(client, thread.id)).toEqual({ activity: "stopping", stop: runId });

      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "9", "run.interrupted", {
              status: "interrupted",
            }),
            state("10", "idle"),
          ],
          type: "host.events",
        }),
      );
      expect(activityOf(client, thread.id)).toEqual({ activity: "idle", stop: null });
    } finally {
      client.dispose();
    }
  });

  it("forgets what the previous viewer was streaming when the session ends", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const collaborator = {
      ...authenticatedSession().user,
      displayName: "Sam",
      email: "sam@example.com",
      id: createId("user"),
    };
    let viewer: "collaborator" | "owner" | "signed-out" = "owner";
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/rpc/auth.config") return json(bootstrap([workspace]).identityConfig);
        if (viewer === "signed-out") return json({ error: unauthorizedError() }, 401);
        if (path === "/v1/rpc/thread.events.list")
          return json({
            ...historyPage(thread),
            asOfSequence: SequenceSchema.parse("1"),
          });
        return json(
          viewer === "owner"
            ? bootstrap([workspace])
            : { ...bootstrap([workspace]), user: collaborator },
        );
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      client.activateThread(thread.id);
      sockets[0]!.open();
      sockets[0]!.receive({
        snapshot: { ...deploymentSnapshot(workspace, "1"), threads: [thread] },
        type: "host.snapshot",
      });
      sockets[0]!.receive(
        liveFrame(workspace.id, thread.id, runId, "1", [
          { at: 0, op: "append", stream: "assistant", text: "Owner's draft" },
        ]),
      );
      expect(client.getSnapshot().transcripts[thread.id]).toContainEqual(
        expect.objectContaining({ body: "Owner's draft", id: `stream:${runId}` }),
      );

      viewer = "signed-out";
      await client.refresh();
      expect(client.getSnapshot().session).toBe("authentication-required");

      viewer = "collaborator";
      await client.reauthenticate();
      expect(client.getSnapshot().user?.id).toBe(collaborator.id);
      const second = sockets.at(-1)!;
      expect(second).not.toBe(sockets[0]);
      second.open();
      second.receive({
        snapshot: { ...deploymentSnapshot(workspace, "1"), threads: [thread] },
        type: "host.snapshot",
      });
      client.activateThread(thread.id);
      await vi.waitFor(() =>
        expect(client.getSnapshot().transcriptWindows[thread.id]).toBeDefined(),
      );

      expect(
        (client.getSnapshot().transcripts[thread.id] ?? []).filter(
          (entry) => entry.id === `stream:${runId}`,
        ),
      ).toEqual([]);
    } finally {
      client.dispose();
    }
  });

  it("drops a drawn stream the resubscribed connection no longer carries", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const answer = { length: 11, op: "replace", stream: "assistant", text: "Alpha beta." } as const;
    let liveReads = 0;
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          // What the Host still has open: the answer, which went on while the
          // connection was down. The reasoning block it was showing is not.
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [answer],
                  runId,
                  threadId: thread.id,
                  deploymentId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 5,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    try {
      await client.load();
      client.activateThread(thread.id);
      const first = sockets[0]!;
      first.open();
      first.receive({
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      first.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
          ],
          type: "host.events",
        }),
      );
      first.receive(
        liveFrame(workspace.id, thread.id, runId, "1", [
          { at: 0, blockId: "plan", op: "append", stream: "reasoning", text: "Weighing it" },
          { at: 0, op: "append", stream: "assistant", text: "Alpha" },
        ]),
      );
      expect((client.getSnapshot().transcripts[thread.id] ?? []).map(({ id }) => id)).toEqual([
        `run:${runId}`,
        `reasoning:${runId}:plan`,
        `stream:${runId}`,
      ]);

      first.close(1006, "lost");
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      const second = sockets[1]!;
      second.open();
      second.receive({
        sequence: sequence("1"),
        type: "host.synchronized",
      });
      // Going live, the Host sends each stream it still has open, whole.
      second.receive(liveFrame(workspace.id, thread.id, runId, "1", [answer]));
      await vi.waitFor(() => expect(liveReads).toBe(1));
      await vi.waitFor(() =>
        expect((client.getSnapshot().transcripts[thread.id] ?? []).map(({ id }) => id)).toEqual([
          `run:${runId}`,
          `stream:${runId}`,
        ]),
      );
      expect(client.getSnapshot().transcripts[thread.id]?.[1]).toMatchObject({
        body: "Alpha beta.",
        streaming: true,
      });
    } finally {
      client.dispose();
    }
  });

  it("rereads again when a frame goes missing while a reread is in flight", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const firstAnswer = Promise.withResolvers<void>();
    const whole = "Alpha beta gamma delta epsilon zeta";
    let liveReads = 0;
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/rpc/thread.live.get") {
          liveReads += 1;
          const read = liveReads;
          if (read === 1) await firstAnswer.promise;
          // The first read was taken before the second frame went missing.
          const text = read === 1 ? "Alpha beta" : whole;
          return json({
            runs: [
              {
                afterSequence: "1",
                progress: {
                  items: [{ length: text.length, op: "replace", stream: "assistant", text }],
                  runId,
                  threadId: thread.id,
                  deploymentId: workspace.id,
                },
              },
            ],
            threadId: thread.id,
          });
        }
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => socket,
    });
    const append = (at: number, text: string) =>
      socket.receive(
        liveFrame(workspace.id, thread.id, runId, "1", [
          { at, op: "append", stream: "assistant", text },
        ]),
      );
    const drawn = () =>
      (client.getSnapshot().transcripts[thread.id] ?? []).find(
        (entry) => entry.id === `stream:${runId}`,
      );
    try {
      await client.load();
      client.activateThread(thread.id);
      socket.open();
      socket.receive({
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
          ],
          type: "host.events",
        }),
      );
      append(0, "Alpha ");
      append(17, "gamma ");
      await vi.waitFor(() => expect(liveReads).toBe(1));
      append(29, "epsilon ");
      firstAnswer.resolve();

      await vi.waitFor(() => expect(drawn()).toMatchObject({ body: whole }));
      expect(liveReads).toBe(2);
    } finally {
      client.dispose();
    }
  });

  it("reads a Thread's Requests once per Host count while the count lags the list", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), status: "running" as const };
    const runId = createId("run");
    const request = pendingRequest({
      presentation: {
        detail: "Publish the release",
        kind: "choice",
        options: [{ hint: "confirm", id: "allow", label: "Publish" }],
        risk: "high",
        title: "Publish externally",
      },
      runId,
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    let requestReads = 0;
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/rpc/thread.requests.list") {
          requestReads += 1;
          return json({ requests: [request], threadId: thread.id, window: emptyWindow() });
        }
        if (path === "/v1/rpc/thread.events.list") return json(historyPage(thread));
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => socket,
    });
    const state = (at: string, pendingRequests: number) =>
      agentEvent(workspace.id, thread.id, null, at, "thread.state-changed", {
        inputQueuePaused: false,
        pendingRequests,
        status: "waiting",
      });
    try {
      await client.load();
      socket.open();
      socket.receive({
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      client.activateThread(thread.id);
      // The Host counts a second Request its list does not return yet.
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, runId, "1", "request.opened", { request }),
            state("2", 2),
          ],
          type: "host.events",
        }),
      );
      await vi.waitFor(() => expect(client.getSnapshot().requests[thread.id]).toHaveLength(1));
      expect(requestReads).toBe(1);
      for (let at = 3; at < 9; at += 1) {
        socket.receive(
          eventsFrame({
            events: [
              agentEvent(workspace.id, thread.id, runId, String(at), "tool.started", {
                arguments: {},
                callId: `call-${at}`,
                tool: { name: "shell", namespace: "codex" },
              }),
            ],
            type: "host.events",
          }),
        );
      }
      expect(requestReads).toBe(1);

      // A new count is a new question.
      socket.receive(eventsFrame({ events: [state("9", 3)], type: "host.events" }));
      await vi.waitFor(() => expect(requestReads).toBe(2));
    } finally {
      client.dispose();
    }
  });

  it("retains selection state live and after reload without adding conversation rows", async () => {
    const workspace = makeDeployment();
    const thread = { ...makeThread(workspace.id), providerSessionId: createId("providerSession") };
    const switched = {
      ...thread,
      providerSessionId: createId("providerSession"),
      continuationIdentity: null,
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: { effort: "high" },
        providerId: "openai",
      }),
    };
    const event = agentEvent(workspace.id, thread.id, null, "1", "thread.execution-updated", {
      thread: switched,
    });
    let history: AgentEvent[] = [];
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/v1/rpc/thread.events.list") {
          return json(historyPage(history.length > 0 ? switched : thread, history));
        }
        return json(bootstrap([workspace]));
      },
      webSocketFactory: () => socket,
    });
    const markers = () =>
      (client.getSnapshot().transcripts[thread.id] ?? []).filter(
        (entry) => entry.kind === "selection",
      );
    try {
      await client.load();
      client.activateThread(thread.id);
      socket.open();
      socket.receive({
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread] },
        type: "host.snapshot",
      });
      await client.loadLatestTranscript(thread.id);

      socket.receive(eventsFrame({ events: [event], type: "host.events" }));
      const live = markers();
      expect(live).toEqual([
        expect.objectContaining({
          harnessInstanceId: switched.harnessInstanceId,
          id: event.eventId,
          modelSelection: switched.modelSelection,
          providerSessionId: switched.providerSessionId,
        }),
      ]);
      expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)).toMatchObject({
        modelSelection: switched.modelSelection,
        providerSessionId: switched.providerSessionId,
        continuationIdentity: null,
      });
      expect(visibleTranscript(client.getSnapshot().transcripts[thread.id] ?? [], null)).toEqual(
        [],
      );

      history = [event];
      await client.loadLatestTranscript(thread.id);
      expect(markers()).toEqual(live);
      expect(
        client.getSnapshot().threads.find(({ id }) => id === thread.id)?.providerSessionId,
      ).toBe(switched.providerSessionId);
      expect(visibleTranscript(client.getSnapshot().transcripts[thread.id] ?? [], null)).toEqual(
        [],
      );
    } finally {
      client.dispose();
    }
  });
});

describe("HttpHostClient owner views", () => {
  /** A real view and the machine that holds it, as the mock Host answers them. */
  async function ownerViewWorld() {
    const mock = new MockHostClient({ latencyMs: 0 });
    await mock.load();
    const app = (await mock.listApprovedComputerApps()).find(
      (candidate) => candidate.target.kind === "app",
    )!;
    if (app.target.kind !== "app") throw new Error("Expected a Mac app");
    const tab = await mock.openTab({
      kind: "window",
      computerId: DeviceIdSchema.parse(app.machineId),
      bundleId: app.target.app.bundleId,
    });
    const viewer = await mock.activateTab(tab.tabId);
    if (viewer.kind !== "window") throw new Error("Expected a window view");
    const { view } = viewer;
    const machine = mock
      .getSnapshot()
      .machines.find((candidate) => candidate.id === app.machineId)!;
    mock.dispose();
    return { app, machine, view };
  }

  function ownerViewHost(
    machines: () => readonly unknown[],
    answer: (command: Readonly<Record<string, unknown>>) => Promise<Response>,
  ) {
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    const commands: Readonly<Record<string, unknown>>[] = [];
    const host = {
      commandReplies: 0,
      /** What the bootstrap lists; a view's tab is listed when a case activates it. */
      tabs: emptyTabs,
      bootstrap: async (): Promise<Response> =>
        json({ ...bootstrap([workspace], undefined, host.tabs), machines: machines() }),
    };
    const client = createHttpHostClient({
      capabilities: ["ownerViewWindows"],
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/commands.dispatch")) {
          const payload = rpcPayload(url, init);
          if (payload.type === "browser.history.clear" || payload.type === "browser.history.remove")
            return json({ type: payload.type });
          if (
            typeof payload.type === "string" &&
            (payload.type.startsWith("computer.view.") || payload.type === "tab.activate")
          ) {
            commands.push(payload);
            const response = await answer(payload);
            host.commandReplies++;
            return response;
          }
        }
        return host.bootstrap();
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        const send = socket.send.bind(socket);
        socket.send = (raw) => {
          send(raw);
          const frame = JSON.parse(raw) as { type: string; nonce?: string };
          if (frame.type === "client.ping")
            queueMicrotask(() => socket.receive({ type: "host.pong", nonce: frame.nonce! }));
        };
        sockets.push(socket);
        return socket;
      },
    });
    /** The newest socket opens and catches up, as a reconnect does. */
    const connect = () => {
      const socket = sockets.at(-1)!;
      socket.open();
      socket.receive({
        sequence: sequence("1"),
        type: "host.synchronized",
      });
      return socket;
    };
    return { client, commands, connect, host, sockets, workspace };
  }
  const renewals = (commands: readonly Readonly<Record<string, unknown>>[]) =>
    commands.filter((command) => command.type === "computer.view.renew").length;

  it.each(["ready", "renewed", "reopened", "closed", "expired"] as const)(
    "preserves a %s view update over an in-flight refresh",
    async (change) => {
      const { machine, view } = await ownerViewWorld();
      const initial = change === "ready" ? { ...view, state: "opening" as const } : view;
      const updated = ComputerViewSchema.parse({
        ...view,
        generation: view.generation + (change === "reopened" ? 1 : 0),
        expiresAt:
          change === "renewed"
            ? new Date(Date.parse(view.expiresAt) + 30_000).toISOString()
            : view.expiresAt,
        state: change === "closed" || change === "expired" ? change : "ready",
        unavailableReason: change === "closed" || change === "expired" ? change : null,
      });
      const host = ownerViewHost(
        () => [{ ...machine, computerUse: { ...machine.computerUse!, ownerViews: [initial] } }],
        async () => json({ view: updated }),
      );
      try {
        await host.client.load();
        const socket = host.connect();
        const bootstrapAnswer = host.host.bootstrap;
        const reading = deferred<void>();
        const release = deferred<void>();
        host.host.bootstrap = async () => {
          const response = await bootstrapAnswer();
          reading.resolve();
          await release.promise;
          return response;
        };
        const refreshing = host.client.refresh();
        await reading.promise;
        socket.receive({ type: "host.computer-view.changed", view: updated });
        release.resolve();
        await refreshing;
        expect(
          host.client.getSnapshot().machines.find((candidate) => candidate.id === machine.id)
            ?.computerUse?.ownerViews,
        ).toEqual([updated]);
      } finally {
        host.client.dispose();
      }
    },
  );

  it("keeps a watched view renewed through failed renewals and a dropped connection, and stops on a terminal refusal", async () => {
    const { machine, view } = await ownerViewWorld();
    let refusal: "none" | "gateway" | "ended" = "none";
    const host = ownerViewHost(
      () => [machine],
      async () =>
        refusal === "gateway"
          ? json({ error: { code: "unavailable", message: "Bad gateway", retryable: true } }, 502)
          : refusal === "ended"
            ? json(
                {
                  error: {
                    code: "conflict",
                    message: "This view ended.",
                    reason: "computer-view-ended",
                  },
                },
                409,
              )
            : json({ view }),
    );
    await host.client.load();
    const socket = host.connect();
    expect(host.client.getSnapshot().connection).toBe("connected");
    vi.useFakeTimers();
    const held = host.client.retainComputerView(view.viewId, view.generation);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals(host.commands)).toBe(1);

    // A failed renewal is retried soon, not given up.
    refusal = "gateway";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals(host.commands)).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(renewals(host.commands)).toBeGreaterThanOrEqual(3);
    refusal = "none";
    await vi.advanceTimersByTimeAsync(30_000);
    const recovered = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewals(host.commands)).toBe(recovered + 1);

    // Disconnected it waits; reconnected it renews at once, without waiting out a period.
    socket.serverClose();
    expect(host.client.getSnapshot().connection).not.toBe("connected");
    const offline = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renewals(host.commands)).toBe(offline);
    host.connect();
    expect(host.client.getSnapshot().connection).toBe("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(renewals(host.commands)).toBe(offline + 1);

    // Hidden it renews nothing; shown again it renews at once.
    held.setVisible(false);
    const hidden = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(renewals(host.commands)).toBe(hidden);
    held.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(renewals(host.commands)).toBe(hidden + 1);

    // An ended view is not asked for again.
    refusal = "ended";
    await vi.advanceTimersByTimeAsync(30_000);
    const ended = renewals(host.commands);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renewals(host.commands)).toBe(ended);
    held.release();
    host.client.dispose();
  });

  it("lets go of every view when the signed-in viewer changes", async () => {
    const { machine, view } = await ownerViewWorld();
    let signedIn = true;
    const host = ownerViewHost(
      () => [machine],
      async () => json({ view }),
    );
    const bootstrapAnswer = host.host.bootstrap;
    host.host.bootstrap = async () =>
      signedIn
        ? bootstrapAnswer()
        : json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
    await host.client.load();
    host.connect();
    vi.useFakeTimers();
    host.client.retainComputerView(view.viewId, view.generation);
    signedIn = false;
    await expect(host.client.refresh()).rejects.toThrow();
    signedIn = true;
    await host.client.load();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renewals(host.commands)).toBe(0);
    host.client.dispose();
  });

  /** A listed tab of `kind` on the view's machine, which the Host activates into `view`. */
  function viewTab(
    host: ReturnType<typeof ownerViewHost>,
    kind: "window" | "phone",
    view: { readonly machineId: string },
  ) {
    const tab = tabFixture({
      tabId: BrowserSurfaceIdSchema.parse(`${kind}-tab`),
      kind,
      computer: { computerId: DeviceIdSchema.parse(view.machineId), name: "Mac" },
    });
    host.host.tabs = {
      tabs: [tab],
      layout: { revision: 1, items: [{ kind: "tab", tabId: tab.tabId }] },
      complete: true,
    };
    return tab;
  }

  it("arms a phone's one-shot wake only for the person's explicit Open", async () => {
    const { machine, view: app } = await ownerViewWorld();
    const view = ComputerViewSchema.parse({
      ...app,
      target: { kind: "phone", display: "main" },
      window: null,
    });
    let tab!: Tab;
    const host = ownerViewHost(
      () => [{ ...machine, kind: "agent-phone" }],
      async () => json({ tab, viewer: { kind: "phone", view } }),
    );
    tab = viewTab(host, "phone", view);
    try {
      await host.client.load();
      const arm = vi.spyOn(sharedDisplayStreams(host.client), "armAutoWake");
      // A reactivation is accepted and shown, but never wakes the phone.
      expect(await host.client.activateTab(tab.tabId)).toEqual({ kind: "phone", view });
      expect(host.client.tabViewer(tab.tabId)).toEqual({ kind: "phone", view });
      expect(arm).not.toHaveBeenCalled();
      await host.client.activateTab(tab.tabId, { wake: true });
      expect(arm).toHaveBeenCalledExactlyOnceWith({
        kind: "owner-view",
        viewId: view.viewId,
        generation: view.generation,
      });
    } finally {
      host.client.dispose();
    }
  });

  it("never brings back a view the Host removed while its tab's activation was answering", async () => {
    const { machine, view } = await ownerViewWorld();
    const without = { ...machine, computerUse: { ...machine.computerUse!, ownerViews: [] } };
    let listed: readonly unknown[] = [without];
    const answering = deferred<void>();
    let tab!: Tab;
    const host = ownerViewHost(
      () => listed,
      async () => {
        await answering.promise;
        return json({ tab, viewer: { kind: "window", view } });
      },
    );
    tab = viewTab(host, "window", view);
    const shown = () =>
      host.client
        .getSnapshot()
        .machines.flatMap((candidate) => candidate.computerUse?.ownerViews ?? [])
        .filter((candidate) => candidate.viewId === view.viewId);
    try {
      await host.client.load();
      const socket = host.connect();
      const activation = host.client.activateTab(tab.tabId);
      // Another device closed it; that notice arrives before this device's answer.
      socket.receive({
        type: "host.computer-view.removed",
        viewId: view.viewId,
        generation: view.generation,
        machineId: DeviceIdSchema.parse(machine.id),
        reason: "closed",
      } as HostToClientMessage);
      answering.resolve();
      await activation;
      expect(shown()).toEqual([]);
      // The tab has no viewer then, so selecting it again acquires a fresh view.
      expect(host.client.tabViewer(tab.tabId)).toBeNull();
      // Nor does a reread that left before the removal.
      listed = [machine];
      await host.client.refresh();
      expect(shown()).toEqual([]);
      // A newer generation of the same view is a new open, and is shown.
      const reopened = { ...view, generation: view.generation + 1 };
      socket.receive({ type: "host.computer-view.changed", view: reopened });
      expect(shown()).toEqual([reopened]);
      expect(host.client.tabViewer(tab.tabId)).toEqual({ kind: "window", view: reopened });
    } finally {
      host.client.dispose();
    }
  });

  it("follows the tab's owner view as the Host changes it, and binds only the newest activation", async () => {
    const { machine, view } = await ownerViewWorld();
    const answers: ReturnType<typeof deferred<Response>>[] = [];
    let tab!: Tab;
    const host = ownerViewHost(
      () => [machine],
      () => {
        const answer = deferred<Response>();
        answers.push(answer);
        return answer.promise;
      },
    );
    tab = viewTab(host, "window", view);
    const newer = { ...view, viewId: ComputerViewIdSchema.parse(`cvw_${crypto.randomUUID()}`) };
    try {
      await host.client.load();
      const socket = host.connect();
      const older = host.client.activateTab(tab.tabId);
      const newest = host.client.activateTab(tab.tabId);
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]!.resolve(json({ tab, viewer: { kind: "window", view: newer } }));
      await newest;
      answers[0]!.resolve(json({ tab, viewer: { kind: "window", view } }));
      await older;
      expect(host.client.tabViewer(tab.tabId)).toMatchObject({ view: { viewId: newer.viewId } });
      // The lease lapsing shows as the same tab's viewer, ended, never as it was answered.
      const expired = {
        ...newer,
        state: "expired" as const,
        unavailableReason: "expired" as const,
      };
      socket.receive({ type: "host.computer-view.changed", view: expired });
      expect(host.client.tabViewer(tab.tabId)).toEqual({ kind: "window", view: expired });
      // And the same object while nothing changed, so a selector stays still.
      expect(host.client.tabViewer(tab.tabId)).toBe(host.client.tabViewer(tab.tabId));
      socket.receive({
        type: "host.computer-view.removed",
        viewId: newer.viewId,
        generation: newer.generation,
        machineId: DeviceIdSchema.parse(machine.id),
        reason: "expired",
      } as HostToClientMessage);
      expect(host.client.tabViewer(tab.tabId)).toBeNull();
    } finally {
      host.client.dispose();
    }
  });
});

function fakeLifecycle(
  initial: ClientLifecycleSnapshot = { network: "unknown", visibility: "foreground" },
) {
  let snapshot = initial;
  const background = new Set<() => void>();
  const foreground = new Set<() => void>();
  const network = new Set<(state: ClientNetworkState, path: ClientNetworkPath) => void>();
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => snapshot,
    onBackground: (listener) => {
      background.add(listener);
      return () => void background.delete(listener);
    },
    onForeground: (listener) => {
      foreground.add(listener);
      return () => void foreground.delete(listener);
    },
    onNetworkChange: (listener) => {
      network.add(listener);
      return () => void network.delete(listener);
    },
  };
  return {
    changeNetwork: (state: ClientNetworkState, path: ClientNetworkPath = "changed") => {
      snapshot = { ...snapshot, network: state };
      for (const listener of network) listener(state, path);
    },
    enterBackground: () => {
      snapshot = { ...snapshot, visibility: "background" };
      for (const listener of background) listener();
    },
    enterForeground: () => {
      snapshot = { ...snapshot, visibility: "foreground" };
      for (const listener of foreground) listener();
    },
    lifecycle,
    listenerCount: () => background.size + foreground.size + network.size,
  };
}

function sentPingNonce(socket: FakeSocket): string | undefined {
  for (const raw of socket.sent) {
    const frame = JSON.parse(raw) as { readonly nonce?: string; readonly type?: string };
    if (frame.type === "client.ping") return frame.nonce;
  }
  return undefined;
}

describe("realtime review regressions", () => {
  async function fixture(options: Partial<TestHostClientOptions> = {}) {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      ...options,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]!.open();
    return { client, sockets, workspace, thread };
  }

  async function evidence(name: string, f: Awaited<ReturnType<typeof fixture>>) {
    await writeRealtimeEvidence(
      {
        name,
        connection: f.client.getSnapshot().connection,
        threads: f.client.getSnapshot().threads.map(({ id, status }) => ({ id, status })),
        sockets: f.sockets.map((socket) => ({
          closes: socket.closeEvents,
          positions: socket.sent
            .map(
              (raw) =>
                JSON.parse(raw) as { type: string; afterSequence?: string; sequence?: string },
            )
            .map(({ type, afterSequence, sequence }) => ({ type, afterSequence, sequence })),
        })),
      },
      `review-${name}.json`,
    );
  }

  it("F1 preserves understood snapshot siblings when one Thread has a future status", async () => {
    const f = await fixture();
    try {
      const future = { ...makeThread(f.workspace.id), status: "future-status" };
      f.sockets[0]!.receiveRaw({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(f.workspace, "10"), threads: [f.thread, future] },
      });
      f.sockets[0]!.receiveRaw({
        type: "host.synchronized",

        sequence: "10",
      });
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).toContain(f.thread.id);
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).not.toContain(future.id);
      expect(f.client.getSnapshot().connection).toBe("connected");
      expect(f.sockets[0]!.closeEvents).toEqual([]);
      expect(f.sockets[0]!.sent.map((raw) => JSON.parse(raw))).toContainEqual({
        type: "client.ack",

        sequence: "10",
      });
    } finally {
      await evidence("f1-snapshot", f);
      f.client.dispose();
    }
  });

  it("F1 keeps resync control behavior for an added reason and normal server close", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      f.sockets[0]!.receiveRaw({
        type: "host.synchronized",

        sequence: "10",
      });
      f.sockets[0]!.receiveRaw({
        type: "host.resync-required",

        reason: "future-reason",
      });
      f.sockets[0]!.serverClose(1000, "normal");
      await vi.advanceTimersByTimeAsync(20);
      expect(f.sockets).toHaveLength(2);
      f.sockets[1]!.open();
      expect(JSON.parse(f.sockets[1]!.sent[0]!)).toMatchObject({
        cursor: { afterSequence: "0", apiVersion: hostApiVersion },
        type: "client.subscribe",
      });
      f.sockets[1]!.receiveRaw({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(f.workspace, "10"), threads: [f.thread] },
      });
      f.sockets[1]!.receiveRaw({
        type: "host.synchronized",

        sequence: "10",
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(f.sockets).toHaveLength(2);
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).toContain(f.thread.id);
      expect(f.client.getSnapshot().connection).toBe("connected");
    } finally {
      await evidence("f1-resync", f);
      f.client.dispose();
    }
  });

  it("F1 refuses malformed known snapshot members instead of silently dropping the snapshot", async () => {
    const f = await fixture();
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      f.sockets[0]!.receiveRaw({
        type: "host.snapshot",
        snapshot: {
          ...deploymentSnapshot(f.workspace, "10"),
          threadWindow: "invalid",
          threads: [f.thread],
        },
      });
      expect(f.client.getSnapshot().connection).toBe("connecting");
      expect(f.sockets[0]!.closeEvents).toEqual([
        { code: 4002, reason: "Invalid Host protocol frame" },
      ]);
      expect(f.client.getSnapshot().threads.map(({ id }) => id)).not.toContain(f.thread.id);
      expect(JSON.parse(diagnostics.mock.calls[0]![0] as string)).toMatchObject({
        event: "host.realtime.frame-rejected",
        issuePaths: ["snapshot.threadWindow"],
      });
    } finally {
      f.client.dispose();
    }
  });

  it.each(["events", "synchronized"] as const)(
    "F3 reconnects after %s acknowledgement send failure with applied progress retained",
    async (kind) => {
      vi.useFakeTimers();
      const f = await fixture();
      const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const first = f.sockets[0]!;
        const send = first.send.bind(first);
        vi.spyOn(first, "send").mockImplementation((raw) => {
          if ((JSON.parse(raw) as { type: string }).type === "client.ack")
            throw new Error("transport lost while acknowledging");
          send(raw);
        });
        if (kind === "events")
          first.receiveRaw(
            eventsFrame({
              type: "host.events",
              events: [
                agentEvent(f.workspace.id, f.thread.id, null, "1", "thread.created", {
                  thread: f.thread,
                }),
              ],
            }),
          );
        else {
          first.receiveRaw({
            type: "host.snapshot",
            snapshot: { ...deploymentSnapshot(f.workspace, "1"), threads: [f.thread] },
          });
          first.receiveRaw({
            type: "host.synchronized",

            sequence: "1",
          });
        }
        expect(f.client.getSnapshot().threads.map(({ id }) => id)).toContain(f.thread.id);
        expect(f.client.getSnapshot().connection).toBe("connecting");
        expect(first.closeEvents).toEqual([
          { code: 1000, reason: "Realtime transport interrupted" },
        ]);
        expect(diagnostics).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(20);
        expect(f.sockets).toHaveLength(2);
        f.sockets[1]!.open();
        expect(JSON.parse(f.sockets[1]!.sent[0]!)).toMatchObject({
          cursor: { afterSequence: "1", apiVersion: hostApiVersion },
          type: "client.subscribe",
        });
        f.sockets[1]!.receiveRaw({
          type: "host.synchronized",

          sequence: "1",
        });
        expect(f.client.getSnapshot().connection).toBe("connected");
      } finally {
        await evidence(`f3-${kind}-ack`, f);
        f.client.dispose();
      }
    },
  );

  it("F4 preserves terminal refusal through automatic rereads, foreground and network changes until person Retry", async () => {
    vi.useFakeTimers();
    const platform = fakeLifecycle();
    const f = await fixture({ lifecycle: platform.lifecycle });
    try {
      f.sockets[0]!.receiveRaw({
        type: "host.error",
        error: { code: "bad_message", message: "Not on this channel.", retryable: false },
      });
      expect(f.client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(30);
      expect(f.sockets).toHaveLength(1);
      platform.enterBackground();
      platform.enterForeground();
      await vi.advanceTimersByTimeAsync(30);
      expect(f.sockets).toHaveLength(1);
      platform.changeNetwork("offline");
      platform.changeNetwork("online");
      await f.client.refresh();
      await vi.advanceTimersByTimeAsync(30);
      expect(f.sockets).toHaveLength(1);
      expect(f.client.getSnapshot().connection).toBe("offline");
      await f.client.refresh({ retryConnection: true });
      expect(f.sockets).toHaveLength(2);
      f.sockets[1]!.open();
      f.sockets[1]!.receiveRaw({
        type: "host.synchronized",

        sequence: "0",
      });
      expect(f.client.getSnapshot().connection).toBe("connected");
    } finally {
      await evidence("f4-person-retry", f);
      f.client.dispose();
    }
  });
});

describe("realtime protocol recovery journey", () => {
  it("reads additive kinds in a replay without reopening or losing the next durable event", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const trace: unknown[] = [];
    const frames = [
      { type: "host.future-notice", privateValue: "FRAME-CONTENT-SENTINEL" },
      eventsFrame({
        type: "host.events",
        futureField: "FRAME-CONTENT-SENTINEL",
        events: [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
          {
            ...agentEvent(workspace.id, thread.id, null, "2", "run.started", { status: "running" }),
            type: "future.event",
            data: { secret: "FRAME-CONTENT-SENTINEL" },
          },
          {
            ...agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
              inputQueuePaused: false,
              pendingRequests: 0,
              status: "running",
            }),
            data: { inputQueuePaused: false, pendingRequests: 0, status: "future-status" },
          },
          agentEvent(workspace.id, thread.id, null, "4", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 0,
            status: "waiting",
          }),
        ],
      }),
      { type: "host.synchronized", sequence: "4" },
    ];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        setTimeout(() => {
          socket.open();
          for (const frame of frames) {
            trace.push({
              socket: sockets.indexOf(socket) + 1,
              type: frame.type,
              bytes: new TextEncoder().encode(JSON.stringify(frame)).byteLength,
              closesBefore: socket.closeEvents.length,
            });
            socket.receiveRaw(frame);
          }
        }, 0);
        return socket;
      },
    });
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let outcome = "failed";
    try {
      await client.load();
      await vi.advanceTimersByTimeAsync(50);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.closeEvents).toEqual([]);
      expect(client.getSnapshot().connection).toBe("connected");
      expect(client.getSnapshot().threads.find(({ id }) => id === thread.id)?.status).toBe(
        "waiting",
      );
      expect(sockets[0]!.sent.map((frame) => JSON.parse(frame))).toContainEqual({
        type: "client.ack",
        sequence: "4",
      });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("FRAME-CONTENT-SENTINEL");
      outcome = "passed";
    } finally {
      await writeRealtimeEvidence({
        outcome,
        trace,
        sockets: sockets.map((socket) => ({
          closes: socket.closeEvents,
          acknowledgements: socket.sent
            .map((frame) => JSON.parse(frame))
            .filter((frame: { type: string }) => frame.type === "client.ack")
            .map((frame: { sequence: string }) => frame.sequence),
        })),
        diagnostics: diagnostics.mock.calls,
      });
      client.dispose();
    }
  });

  async function synchronizedClient({
    hostBrowser,
    reads = {},
    ...options
  }: Partial<TestHostClientOptions> & {
    readonly hostBrowser?: (workspace: PersonalFixture) => BrowserWireBootstrap;
    readonly reads?: Readonly<
      Record<string, (input: Readonly<Record<string, unknown>>) => unknown>
    >;
  } = {}) {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    let bootstrapReads = 0;
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createHttpHostClient({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const name = url.pathname.split("/").at(-1)!;
        if (name === "bootstrap.get") bootstrapReads += 1;
        const answer = reads[name]?.(rpcPayload(url, init));
        if (answer instanceof Response) return answer;
        return json(answer ?? bootstrap([workspace], hostBrowser?.(workspace)));
      },
      random: () => 1,
      reconnectBaseDelayMs: 10,
      ...options,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]!.open();
    sockets[0]!.receiveRaw({
      type: "host.snapshot",
      snapshot: { ...deploymentSnapshot(workspace, "10"), threads: [thread] },
    });
    sockets[0]!.receiveRaw({
      type: "host.synchronized",
      sequence: "10",
    });
    await vi.advanceTimersByTimeAsync(0);
    return {
      acknowledged: () =>
        sockets.flatMap((socket) =>
          socket.sent
            .map((sent) => JSON.parse(sent) as { type: string; sequence?: string })
            .filter(({ type }) => type === "client.ack")
            .map(({ sequence }) => sequence),
        ),
      bootstrapReads: () => bootstrapReads,
      client,
      diagnostics,
      records: () =>
        diagnostics.mock.calls.map(
          ([record]) => JSON.parse(record as string) as RealtimeFrameDiagnostic,
        ),
      sockets,
      thread,
      workspace,
    };
  }

  type Synchronized = Awaited<ReturnType<typeof synchronizedClient>>;

  /** The socket that opens exactly `delayMs` from now, and the cursor it asked to resume from. */
  async function reconnectAfter(f: Synchronized, delayMs: number) {
    const opened = f.sockets.length;
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(f.sockets).toHaveLength(opened);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sockets).toHaveLength(opened + 1);
    const socket = f.sockets.at(-1)!;
    socket.open();
    const {
      cursor: { afterSequence },
    } = JSON.parse(socket.sent[0]!) as { cursor: { afterSequence: string } };
    return { afterSequence, socket };
  }

  const stateEvent = (f: Synchronized, sequence: string, status: Thread["status"]) =>
    agentEvent(f.workspace.id, f.thread.id, null, sequence, "thread.state-changed", {
      inputQueuePaused: false,
      pendingRequests: 0,
      status,
    });

  const unreadableEvents = (f: Synchronized, sequence: string) =>
    eventsFrame({
      type: "host.events",
      events: [
        {
          ...stateEvent(f, sequence, "running"),
          data: {
            inputQueuePaused: "os_secret_DO_NOT_LOG",
            pendingRequests: -1,
            status: "running",
            "PRIVATE-FIELD-SENTINEL": "PRIVATE-VALUE-SENTINEL",
          },
        },
      ],
    });

  const unreadableSnapshot = (f: Synchronized) => ({
    type: "host.snapshot",
    snapshot: { ...deploymentSnapshot(f.workspace, "12"), threadWindow: "invalid" },
  });

  /** Fails three times at one position, which leaves the fourth socket asking for a snapshot. */
  async function exhaustReplay(f: Synchronized) {
    const frame = unreadableEvents(f, "11");
    f.sockets[0]!.receiveRaw(frame);
    (await reconnectAfter(f, 10)).socket.receiveRaw(frame);
    (await reconnectAfter(f, 20)).socket.receiveRaw(frame);
    return reconnectAfter(f, 40);
  }

  function readableSnapshot(f: Synchronized, socket: FakeSocket, sequence: string) {
    socket.receiveRaw({
      type: "host.snapshot",
      snapshot: {
        ...deploymentSnapshot(f.workspace, sequence),
        threads: [{ ...f.thread, status: "running" }],
      },
    });
    socket.receiveRaw({ type: "host.synchronized", sequence });
  }

  it("backs off from the same cursor on malformed replay without acknowledging it, and logs only envelope metadata and schema paths", async () => {
    const reported: RealtimeFrameDiagnostic[] = [];
    const f = await synchronizedClient({
      reportRealtimeFrame: (record) => reported.push(record),
    });
    try {
      const socket = f.sockets[0]!;
      const frame = unreadableEvents(f, "11");
      socket.receiveRaw(frame);
      expect(socket.closeEvents).toEqual([{ code: 4002, reason: "Invalid Host protocol frame" }]);
      expect(f.client.getSnapshot().connection).toBe("connecting");
      expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith(expect.any(String));
      const [record] = f.records();
      expect(record).toMatchObject({
        event: "host.realtime.frame-rejected",
        envelopeType: "host.events",
        apiEpoch: hostApiVersion,
        bytes: new TextEncoder().encode(JSON.stringify(frame)).byteLength,
        issuePaths: ["events.[].data.inputQueuePaused", "events.[].data.pendingRequests"],
      });
      expect(JSON.stringify(record)).not.toMatch(
        /DO_NOT_LOG|PRIVATE-FIELD|PRIVATE-VALUE|os_secret/,
      );
      expect(reported).toEqual([record]);

      const second = await reconnectAfter(f, 10);
      expect(second.afterSequence).toBe("10");
      second.socket.receiveRaw(frame);
      // A socket opening proved nothing, so the next wait is longer, not reset.
      const third = await reconnectAfter(f, 20);
      expect(third.afterSequence).toBe("10");
      expect(f.acknowledged()).toEqual(["10"]);
      expect(f.client.getSnapshot().threads.find(({ id }) => id === f.thread.id)?.status).toBe(
        "idle",
      );
    } finally {
      f.client.dispose();
    }
  });

  it("lets no diagnostic failure decide what becomes of an unreadable frame", async () => {
    const f = await synchronizedClient({
      reportRealtimeFrame: () => {
        throw new Error("The log is gone.");
      },
    });
    try {
      f.sockets[0]!.receiveRaw(unreadableEvents(f, "11"));
      expect(f.sockets[0]!.closeEvents).toEqual([
        { code: 4002, reason: "Invalid Host protocol frame" },
      ]);
      expect((await reconnectAfter(f, 10)).afterSequence).toBe("10");
    } finally {
      f.client.dispose();
    }
  });

  it("keeps growing the wait when the network dies after an unreadable frame", async () => {
    const f = await synchronizedClient();
    try {
      f.sockets[0]!.receiveRaw(unreadableEvents(f, "11"));
      (await reconnectAfter(f, 10)).socket.serverClose();
      (await reconnectAfter(f, 20)).socket.serverClose();
      (await reconnectAfter(f, 40)).socket.serverClose();
      expect((await reconnectAfter(f, 80)).afterSequence).toBe("10");
    } finally {
      f.client.dispose();
    }
  });

  it("recovers by itself once the replay is readable, and only then forgets its failures", async () => {
    const f = await synchronizedClient();
    try {
      f.sockets[0]!.receiveRaw(unreadableEvents(f, "11"));
      const { socket } = await reconnectAfter(f, 10);
      socket.receiveRaw(
        eventsFrame({ type: "host.events", events: [stateEvent(f, "11", "running")] }),
      );
      socket.receiveRaw({
        type: "host.synchronized",
        sequence: "11",
      });
      expect(f.client.getSnapshot().connection).toBe("connected");
      expect(f.client.getSnapshot().threads.find(({ id }) => id === f.thread.id)?.status).toBe(
        "running",
      );
      expect(f.acknowledged()).toEqual(["10", "11", "11"]);
      socket.receiveRaw(unreadableEvents(f, "12"));
      expect((await reconnectAfter(f, 10)).afterSequence).toBe("11");
    } finally {
      f.client.dispose();
    }
  });

  it("starts over from a snapshot when one position keeps failing, past the event it cannot read", async () => {
    const f = await synchronizedClient();
    try {
      const { afterSequence, socket } = await exhaustReplay(f);
      expect(afterSequence).toBe("0");
      expect(f.client.getSnapshot().connection).toBe("connecting");
      readableSnapshot(f, socket, "12");
      expect(f.client.getSnapshot().connection).toBe("connected");
      expect(f.client.getSnapshot().threads.find(({ id }) => id === f.thread.id)?.status).toBe(
        "running",
      );
      expect(f.acknowledged().at(-1)).toBe("12");
      expect(socket.closeEvents).toEqual([]);
    } finally {
      f.client.dispose();
    }
  });

  it("retries a snapshot it cannot read at a capped pace, showing the problem, until a later Host recovers it", async () => {
    const f = await synchronizedClient();
    try {
      const { socket } = await exhaustReplay(f);
      socket.receiveRaw(unreadableSnapshot(f));
      expect(f.client.connection.getSnapshot()).toMatchObject({
        phase: "recovering",
        showInterruption: false,
      });
      // Ten milliseconds doubled fifteen times has passed five minutes.
      for (let failures = 4; failures < 16; failures += 1) {
        const next = await reconnectAfter(f, 10 * 2 ** (failures - 1));
        next.socket.receiveRaw(unreadableSnapshot(f));
        expect(f.client.getSnapshot().connection).toBe("offline");
      }
      const later = await reconnectAfter(f, 5 * 60_000);
      expect(later.afterSequence).toBe("0");
      expect(f.client.getSnapshot().connection).toBe("offline");
      readableSnapshot(f, later.socket, "12");
      expect(f.client.getSnapshot().connection).toBe("connected");
    } finally {
      f.client.dispose();
    }
  });

  it("Retry tries at once instead of waiting out the backoff, which a plain refresh does not", async () => {
    const f = await synchronizedClient();
    try {
      const { socket } = await exhaustReplay(f);
      socket.receiveRaw(unreadableSnapshot(f));
      const opened = f.sockets.length;
      await f.client.refresh();
      expect(f.sockets).toHaveLength(opened);
      await f.client.refresh({ retryConnection: true });
      expect(f.sockets).toHaveLength(opened + 1);
      f.sockets.at(-1)!.open();
      readableSnapshot(f, f.sockets.at(-1)!, "12");
      expect(f.client.getSnapshot().connection).toBe("connected");
    } finally {
      f.client.dispose();
    }
  });

  it.each([
    ["host.live", { progress: {}, afterSequence: "10" }],
    ["host.notification", { notification: {} }],
    ["host.pong", { nonce: "x".repeat(256) }],
  ])("drops an unreadable %s with nothing to reread", async (type, fields) => {
    const f = await synchronizedClient();
    try {
      const reads = f.bootstrapReads();
      f.sockets[0]!.receiveRaw({ type, deploymentId: f.workspace.id, ...fields });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.bootstrapReads()).toBe(reads);
      expect(f.sockets[0]!.closeEvents).toEqual([]);
      expect(f.client.getSnapshot().connection).toBe("connected");
      expect(f.records()).toMatchObject([{ event: "host.realtime.frame-ignored" }]);
    } finally {
      f.client.dispose();
    }
  });

  it("skips one unreadable Thread in a snapshot, naming its field and masking a peer's record key", async () => {
    const f = await synchronizedClient();
    try {
      const socket = f.sockets[0]!;
      const sibling = makeThread(f.workspace.id);
      const unreadable = { ...makeThread(f.workspace.id), inputQueuePaused: "invalid" };
      const peerKeyed = {
        ...makeThread(f.workspace.id),
        modelSelection: {
          ...f.thread.modelSelection,
          options: { "private.sentinel": { nested: "PRIVATE-VALUE" } },
        },
      };
      socket.receiveRaw({
        type: "host.snapshot",
        snapshot: {
          ...deploymentSnapshot(f.workspace, "11"),
          threads: [sibling, unreadable, peerKeyed],
        },
      });
      socket.receiveRaw({
        type: "host.synchronized",
        sequence: "11",
      });
      const shown = f.client.getSnapshot().threads.map(({ id }) => id);
      expect(shown).toContain(sibling.id);
      expect(shown).not.toContain(unreadable.id);
      expect(shown).not.toContain(peerKeyed.id);
      expect(f.client.getSnapshot().connection).toBe("connected");
      expect(socket.closeEvents).toEqual([]);
      const [record] = f.records();
      expect(record).toMatchObject({
        envelopeType: "host.snapshot",
        event: "host.realtime.frame-ignored",
        issuePaths: [
          "snapshot.threads.[].inputQueuePaused",
          "snapshot.threads.[].modelSelection.options.*",
        ],
      });
      expect(JSON.stringify(record)).not.toMatch(/sentinel|PRIVATE/);
    } finally {
      f.client.dispose();
    }
  });

  it("replays a malformed update to a Thread it holds instead of acknowledging past it", async () => {
    const f = await synchronizedClient();
    try {
      const update = (thread: unknown) =>
        eventsFrame({
          type: "host.events",
          events: [
            {
              ...agentEvent(f.workspace.id, f.thread.id, null, "11", "thread.execution-updated", {
                thread: f.thread,
              }),
              data: { thread },
            },
          ],
        });
      f.sockets[0]!.receiveRaw(update({ ...f.thread, inputQueuePaused: "invalid" }));
      expect(f.sockets[0]!.closeEvents).toEqual([
        { code: 4002, reason: "Invalid Host protocol frame" },
      ]);
      expect(f.acknowledged()).toEqual(["10"]);
      expect(f.records()).toMatchObject([
        {
          event: "host.realtime.frame-rejected",
          issuePaths: ["events.[].data.thread.inputQueuePaused"],
        },
      ]);
      const { afterSequence, socket } = await reconnectAfter(f, 10);
      expect(afterSequence).toBe("10");
      socket.receiveRaw(update({ ...f.thread, status: "running" }));
      expect(f.client.getSnapshot().threads.find(({ id }) => id === f.thread.id)?.status).toBe(
        "running",
      );
      expect(f.acknowledged().at(-1)).toBe("11");
    } finally {
      f.client.dispose();
    }
  });

  it("skips only a Thread event whose status this build does not know, keeping its batch and position", async () => {
    const f = await synchronizedClient();
    try {
      const socket = f.sockets[0]!;
      const sibling = makeThread(f.workspace.id);
      const future = { ...makeThread(f.workspace.id), status: "future-status" };
      socket.receiveRaw(
        eventsFrame({
          type: "host.events",
          events: [
            {
              ...agentEvent(f.workspace.id, future.id, null, "11", "thread.listed", {
                thread: makeThread(f.workspace.id),
              }),
              data: { thread: future },
            },
            agentEvent(f.workspace.id, sibling.id, null, "12", "thread.created", {
              thread: sibling,
            }),
          ],
        }),
      );
      const shown = f.client.getSnapshot().threads.map(({ id }) => id);
      expect(shown).toContain(sibling.id);
      expect(shown).not.toContain(future.id);
      expect(f.acknowledged().at(-1)).toBe("12");
      expect(socket.closeEvents).toEqual([]);
    } finally {
      f.client.dispose();
    }
  });

  describe("lifecycle signals during protocol backoff", () => {
    async function inBackoff() {
      const platform = fakeLifecycle();
      const f = await synchronizedClient({ lifecycle: platform.lifecycle });
      const { socket } = await exhaustReplay(f);
      socket.receiveRaw(unreadableSnapshot(f));
      return { f, opened: f.sockets.length, platform };
    }

    it("keeps the retry deadline however many times the network reports itself", async () => {
      const { f, opened, platform } = await inBackoff();
      try {
        await vi.advanceTimersByTimeAsync(30);
        for (let notice = 0; notice < 5; notice += 1) {
          platform.changeNetwork("online");
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(f.sockets).toHaveLength(opened);
        expect((await reconnectAfter(f, 45)).afterSequence).toBe("0");
        expect(f.sockets).toHaveLength(opened + 1);
      } finally {
        f.client.dispose();
      }
    });

    it("keeps the deadline through a trip to the background, and honours one that passed there", async () => {
      const { f, opened, platform } = await inBackoff();
      try {
        platform.enterBackground();
        await vi.advanceTimersByTimeAsync(30);
        platform.enterForeground();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.sockets).toHaveLength(opened);
        const { socket } = await reconnectAfter(f, 50);
        socket.receiveRaw(unreadableSnapshot(f));
        platform.enterBackground();
        await vi.advanceTimersByTimeAsync(1_000);
        platform.enterForeground();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.sockets).toHaveLength(opened + 2);
      } finally {
        f.client.dispose();
      }
    });

    it("does not restart an attempt in flight, which may be mid-snapshot on a slow link", async () => {
      const { f, opened, platform } = await inBackoff();
      try {
        await reconnectAfter(f, 80);
        platform.changeNetwork("online", "same");
        await vi.advanceTimersByTimeAsync(0);
        expect(f.sockets).toHaveLength(opened + 1);
        await vi.advanceTimersByTimeAsync(160);
        expect(f.sockets).toHaveLength(opened + 1);
        f.sockets.at(-1)!.serverClose();
        await reconnectAfter(f, 160);
      } finally {
        f.client.dispose();
      }
    });

    it("rereads after recovering, whatever a signal did to the attempt count", async () => {
      const { f, platform } = await inBackoff();
      try {
        platform.changeNetwork("online");
        const { socket } = await reconnectAfter(f, 80);
        const reads = f.bootstrapReads();
        readableSnapshot(f, socket, "12");
        await vi.advanceTimersByTimeAsync(0);
        expect(f.client.getSnapshot().connection).toBe("connected");
        expect(f.bootstrapReads()).toBeGreaterThan(reads);
      } finally {
        f.client.dispose();
      }
    });
  });

  describe("repairing what a lost notice leaves stale", () => {
    const sessionId = createBrowserSessionId();
    it("rereads every browser history it holds, since the notice cannot say which changed", async () => {
      const held = [createId("browserProfile"), createId("browserProfile")];
      let title = "Before";
      const f = await synchronizedClient({
        reads: {
          "browser.history.get": () => ({
            entries: [
              {
                lastVisitAt: now,
                title,
                typedCount: 0,
                url: "https://example.com/",
                visitCount: 1,
              },
            ],
            icons: [],
          }),
        },
      });
      try {
        f.client.browserHistory.subscribe(() => undefined);
        await Promise.all(held.map((id) => f.client.browserHistory.load(id)));
        title = "After";
        f.sockets[0]!.receiveRaw({ type: "host.browser-history-changed", profileId: "unreadable" });
        await vi.advanceTimersByTimeAsync(0);
        for (const id of held)
          expect(f.client.browserHistory.entries(id).map((entry) => entry.title)).toEqual([
            "After",
          ]);
        expect(f.sockets[0]!.closeEvents).toEqual([]);
      } finally {
        f.client.dispose();
      }
    });

    describe("notices lost faster than a bootstrap may run", () => {
      const lost = {
        type: "host.computer-presence",
        sessions: "unreadable",
      };

      async function losing(reads: Parameters<typeof synchronizedClient>[0] = {}) {
        const f = await synchronizedClient(reads);
        f.sockets[0]!.receiveRaw(lost);
        await vi.advanceTimersByTimeAsync(0);
        f.sockets[0]!.receiveRaw(lost);
        f.sockets[0]!.receiveRaw(lost);
        await vi.advanceTimersByTimeAsync(0);
        return f;
      }

      it("owes one read at the end of the window for all of them, with no poll to fall back on", async () => {
        const f = await losing();
        try {
          const reads = f.bootstrapReads();
          await vi.advanceTimersByTimeAsync(14_999);
          expect(f.bootstrapReads()).toBe(reads);
          await vi.advanceTimersByTimeAsync(1);
          expect(f.bootstrapReads()).toBe(reads + 1);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(f.bootstrapReads()).toBe(reads + 1);
        } finally {
          f.client.dispose();
        }
      });

      it("reads for nobody once the client is disposed", async () => {
        const f = await losing();
        f.client.dispose();
        expect(vi.getTimerCount()).toBe(0);
      });

      it("still repairs the next viewer's lost notices after a Deployment change", async () => {
        let moved: unknown;
        const f = await losing({ reads: { "bootstrap.get": () => moved } });
        try {
          moved = {
            ...bootstrap([f.workspace]),
            deploymentId: "dep_00000000-0000-4000-8000-000000000002",
          };
          await f.client.refresh();
          await vi.advanceTimersByTimeAsync(60_000);
          const socket = f.sockets.at(-1)!;
          socket.open();
          const reads = f.bootstrapReads();
          socket.receiveRaw(lost);
          await vi.advanceTimersByTimeAsync(0);
          expect(f.bootstrapReads()).toBe(reads + 1);
        } finally {
          f.client.dispose();
        }
      });

      it.each([
        [
          "the viewer is signed out",
          () => json({ error: { code: "unauthorized", message: "Signed out" } }, 401),
        ],
        [
          "the Deployment changes",
          (workspace: PersonalFixture) => ({
            ...bootstrap([workspace]),
            deploymentId: "dep_00000000-0000-4000-8000-000000000002",
          }),
        ],
      ])("reads for nobody once %s", async (_name, answer) => {
        let moved: unknown;
        const f = await losing({
          reads: {
            "auth.config": () => ({ methods: [] }),
            "bootstrap.get": () => moved,
          },
        });
        try {
          moved = answer(f.workspace);
          await f.client.refresh().catch(() => undefined);
          await vi.advanceTimersByTimeAsync(0);
          moved = undefined;
          const reads = f.bootstrapReads();
          await vi.advanceTimersByTimeAsync(60_000);
          expect(f.bootstrapReads()).toBe(reads);
        } finally {
          f.client.dispose();
        }
      });
    });

    it("rereads a shown conversation's browser usage whole, since the notice cannot name it", async () => {
      let used = false;
      const f = await synchronizedClient({
        browserUsageReads: "observed",
        reads: {
          "thread.browserUsage.get": ({ threadId }) => ({
            threadId,
            uses: used
              ? [
                  {
                    firstUsedAt: now,
                    lastUsedAt: now,
                    runId: null,
                    sessionId,
                    tabId: null,
                    threadId,
                  },
                ]
              : [],
          }),
        },
      });
      try {
        f.client.activateThread(f.thread.id);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.client.getSnapshot().browserUses ?? []).toEqual([]);
        used = true;
        f.sockets[0]!.receiveRaw({
          type: "host.browser-usage-changed",
          threadIds: ["unreadable"],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.client.getSnapshot().browserUses?.map((use) => use.threadId)).toEqual([
          f.thread.id,
        ]);
      } finally {
        f.client.dispose();
      }
    });

    it("replays an unreadable visit page, which no reread would bring back", async () => {
      const f = await synchronizedClient();
      try {
        const socket = f.sockets[0]!;
        socket.receiveRaw({
          type: "host.thread-visits",

          visits: [{ lastVisitedAt: "2026-01-02T00:00:00.000Z", threadId: "unreadable" }],
        });
        expect(socket.closeEvents).toEqual([{ code: 4002, reason: "Invalid Host protocol frame" }]);
        const next = await reconnectAfter(f, 10);
        expect(next.afterSequence).toBe("10");
        next.socket.receiveRaw({
          type: "host.thread-visits",

          visits: [{ lastVisitedAt: "2026-01-02T00:00:00.000Z", threadId: f.thread.id }],
        });
        next.socket.receiveRaw({
          type: "host.synchronized",
          sequence: "10",
        });
        expect(f.client.getSnapshot().threadVisits[f.thread.id]).toBe("2026-01-02T00:00:00.000Z");
        expect(f.client.getSnapshot().connection).toBe("connected");
      } finally {
        f.client.dispose();
      }
    });

    it("merges many reconnect visit pages and checkpoints them once, at synchronization", async () => {
      const commits: PersonalStreamCheckpoint[] = [];
      const f = await synchronizedClient({
        streamCache: {
          load: async () => null,
          remove: async () => {},
          commit: async (checkpoint) => {
            commits.push(checkpoint);
          },
        },
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        f.sockets[0]!.serverClose();
        const next = await reconnectAfter(f, 10);
        const before = commits.length;
        const pages = Array.from({ length: 50 }, () =>
          Array.from({ length: 100 }, () => ({
            threadId: createId("thread"),
            lastVisitedAt: "2026-01-02T00:00:00.000Z",
          })),
        );
        for (const visits of pages) next.socket.receiveRaw({ type: "host.thread-visits", visits });
        const merged = f.client.getSnapshot().threadVisits;
        next.socket.receiveRaw({ type: "host.thread-visits", visits: pages[0] });
        expect(f.client.getSnapshot().threadVisits).toBe(merged);
        await vi.advanceTimersByTimeAsync(0);
        expect(commits).toHaveLength(before);
        next.socket.receiveRaw({ type: "host.synchronized", sequence: "10" });
        await vi.advanceTimersByTimeAsync(0);
        expect(commits).toHaveLength(before + 1);
        expect(Object.keys(commits.at(-1)!.snapshot.threadVisits)).toHaveLength(5000);
      } finally {
        f.client.dispose();
      }
    });

    it("still honours a resync it could not read, which the Host will not ask for twice", async () => {
      const f = await synchronizedClient();
      try {
        f.sockets[0]!.receiveRaw({ type: "host.resync-required" });
        expect(f.sockets[0]!.closeEvents).toEqual([
          { code: 4002, reason: "Invalid Host protocol frame" },
        ]);
        expect((await reconnectAfter(f, 10)).afterSequence).toBe("0");
      } finally {
        f.client.dispose();
      }
    });

    it.each([
      [
        "host.machine.access.session.started",
        "machineRevision",
        { runnerId: "unreadable", session: {} },
      ],
      ["host.machine.access.session.ended", "machineRevision", { session: {} }],
      ["host.triggers-changed", "triggerRevision", { deploymentId: "unreadable" }],
    ] as const)("tells screens keyed on %s to read again", async (type, revision, fields) => {
      const f = await synchronizedClient();
      try {
        const before = f.client.getSnapshot()[revision];
        f.sockets[0]!.receiveRaw({ type, ...fields });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.client.getSnapshot()[revision]).toBe(before + 1);
      } finally {
        f.client.dispose();
      }
    });

    const tabId = BrowserSurfaceIdSchema.parse("page-1");
    const activity = (runId: string, seq: number) => ({
      at: 1_000,
      expiresAt: 2_000,
      generation: 1,
      geometryRevision: 1,

      order: seq,
      tabId,
      pointer: { x: 0.5, y: 0.5 },
      runId,
      seq,
      threadId: createId("thread"),
    });

    it.each([
      ["host.place-activity-cleared", { tabId: 7 }],
      ["host.place-activity", { activity: { tabId: 7 } }],
    ])("leaves no agent behind when %s cannot be read", async (type, fields) => {
      const f = await synchronizedClient();
      try {
        const socket = f.sockets[0]!;
        const runId = createId("run");
        const key = tabId;
        socket.receiveRaw({ type: "host.place-activity", activity: activity(runId, 1) });
        expect(f.client.placeActivity(key)).toHaveLength(1);
        socket.receiveRaw({ type, ...fields });
        expect(f.client.placeActivity(key)).toEqual([]);
        expect(socket.closeEvents).toEqual([]);
        expect(f.client.getSnapshot().connection).toBe("connected");
        // An agent still at work comes back with its next record.
        socket.receiveRaw({ type: "host.place-activity", activity: activity(runId, 1) });
        expect(f.client.placeActivity(key)).toHaveLength(1);
      } finally {
        f.client.dispose();
      }
    });
  });
});

async function writeRealtimeEvidence(
  report: unknown,
  filename = "frame-trace.redacted.json",
): Promise<void> {
  // Tests leave a replay artifact; the production package still compiles with
  // no Node type surface. Runtime-only test imports keep that portability check.
  const filesystemModule = "node:fs/promises";
  const osModule = "node:os";
  const processModule = "node:process";
  const filesystem: {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(path: string, data: string): Promise<void>;
  } = await import(filesystemModule);
  const os: { tmpdir(): string } = await import(osModule);
  const runtime: { env: Record<string, string | undefined> } = await import(processModule);
  const directory =
    runtime.env.OPENSTEER_REALTIME_EVIDENCE_DIR ?? `${os.tmpdir()}/opensteer-realtime-diagnostics`;
  await filesystem.mkdir(directory, { recursive: true });
  await filesystem.writeFile(`${directory}/${filename}`, JSON.stringify(report, null, 2));
  console.info(`Realtime evidence: ${directory}`);
}

class FakeSocket implements WebSocketClient {
  binaryType: BinaryType = "blob";
  readonly closeEvents: Array<{ code: number; reason: string }> = [];
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  readonly sent: string[] = [];
  readyState = 0;

  addEventListener<Type extends "close" | "error" | "message" | "open">(
    type: Type,
    listener: (event: never) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeEvents.push({ code, reason });
    this.emit("close", { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message: HostToClientMessage): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  receiveBinary(message: ArrayBuffer): void {
    this.emit("message", { data: message });
  }

  receiveRaw(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  serverClose(code = 1006, reason = "Abnormal closure"): void {
    this.close(code, reason);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

/** A page tab the Host lists, which it binds to a browser session when this device activates it. */
function pageTabHost(workspace: PersonalFixture, browser?: BrowserWireBootstrap) {
  const sessionId = createBrowserSessionId();
  const tabId = BrowserSurfaceIdSchema.parse("tab");
  const tab = tabFixture({
    tabId,
    computer: { computerId: DeviceIdSchema.parse(runnerId), name: "Example computer" },
  });
  let tabs: TabBootstrap = {
    tabs: [tab],
    layout: { revision: 1, items: [{ kind: "tab", tabId }] },
    complete: true,
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const payload = rpcPayload(url, init);
    if (url.pathname.endsWith("/commands.dispatch") && payload.type === "tab.activate")
      return json({ tab, viewer: { kind: "page", sessionId, surfaceId: tabId } });
    return json(bootstrap([workspace], browser, tabs));
  });
  return {
    fetch,
    sessionId,
    tab,
    tabId,
    workspace,
    /** What the next bootstrap read lists. */
    list(next: TabBootstrap) {
      tabs = next;
    },
  };
}

/** The Host's tab stream on the carrier: a whole fresh generation of these rows and layout. */
function publishTabs(
  socket: FakeSocket,
  tabs: readonly Tab[],
  layout: TabLayout,
  generation = "g1",
) {
  const records = new Map(tabs.map((tab) => [tab.tabId as string, tab]));
  const publisher = new KeyedStreamPublisher({
    key: "tabId",
    generation,
    ids: () => records.keys(),
    read: (id) => records.get(id),
    meta: () => ({ layout }),
    targetBytes: 16 * 1024,
    envelopeBytes: 200,
  });
  for (let frame = publisher.next(); frame; frame = publisher.next()) {
    socket.receiveRaw({ type: "host.tabs", stream: frame });
    publisher.settled(frame, true);
  }
}

const emptyTabs: TabBootstrap = { tabs: [], layout: { revision: 0, items: [] }, complete: true };
const bootstrapFixtures = new Map<string, { browser: BrowserWireBootstrap; tabs: TabBootstrap }>();
function bootstrap(
  workspaces: PersonalFixture[],
  browser: BrowserWireBootstrap = { available: false, placements: [], profiles: [] },
  tabs: TabBootstrap = emptyTabs,
) {
  const result = {
    apiVersion: hostApiVersion,
    browser,
    tabs,
    deploymentId: workspaces[0]?.id ?? createId("deployment"),
    personalSettings: {
      ownerId,
      agentHome: { computerId: runnerId, path: "/Users/person/Opensteer" },
      voiceThreadId: null,
    },
    can: { createTasks: true, useVoice: true, manageComputers: true, managePrivateResources: true },
    sessionId: createId("authSession"),
    latestPlaces: [],
    executionPreferences: emptyExecutionPreferences,
    quietTaskDays: 7,
    sessionSurface: "canonical",
    environments: [
      {
        capabilities: ["filesystem", "container"],
        connected: true,
        harnessAuthenticationAllowed: true,
        harnessCatalogs: [codexCatalog(harnessInstanceId)],
        harnessDrivers: [
          {
            accessModes: [...ThreadAccessModeSchema.options],
            driverKind: "codex",
            readiness: "runtime-check",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "OpenAI",
                quota: "windows",
                sourceId: "openai",
                stateKinds: ["ambient", "isolated"],
              },
            ],
          },
        ],
        providerStateModes: ["ambient", "isolated"] as const,
        id: environmentId,
        kind: "main",
        name: "Main runner",
        runnerId,
        status: "connected" as const,
        can: { executeTasks: true },
      },
    ],
    harnesses: [
      {
        config: { model: "gpt-5.6-sol" },
        driverKind: "codex",
        enabled: true,
        environmentId,
        id: harnessInstanceId,
        isDefault: true,
        name: "Codex",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "ambient" as const,
      },
    ],
    machines: [],
    identityConfig: {
      deployment: { kind: "personal" as const, name: null },
      emailDeliveryAvailable: false,
      localPasswordEnabled: true,
      machineOwner: false,
      oidcProviders: [],
      passkeysEnabled: false,
      exposure: "networked",
      portalOrigin: null,
      publicOrigin: "https://opensteer.example.test",
      setupState: "complete",
      signupPolicy: "invite-only",
    },
    user: authenticatedSession().user,
  };
  bootstrapFixtures.set(result.deploymentId, { browser, tabs });
  return result;
}

function codexCatalog(id: Thread["harnessInstanceId"]) {
  return {
    continuationIdentity: {
      continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
      driverKind: "codex",
    },
    driverKind: "codex",
    harnessInstanceId: id,
    models: [
      {
        displayName: "GPT-5.6-Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [
          {
            defaultValue: "low",
            id: "effort",
            label: "Reasoning",
            type: "select",
            values: [
              { label: "Low", value: "low" },
              { label: "High", value: "high" },
            ],
          },
        ],
        providerId: "openai",
      },
    ],
    status: "ready",
  } as const;
}

function authenticatedSession() {
  return {
    absoluteExpiresAt: "2026-09-08T20:00:00.000Z",
    createdAt: now,
    expiresAt: "2026-08-16T20:00:00.000Z",
    id: createId("authSession"),
    user: {
      disabledAt: null,
      displayName: "Alex",
      email: "alex@example.com",
      emailVerified: false,
      id: ownerId,
      image: null,
    },
  };
}

function makeDeployment(name = "Opensteer"): PersonalFixture {
  return { id: createId("deployment"), name };
}

function makeThread(_deploymentId: import("@opensteer/core").DeploymentId): Thread {
  const id = createId("thread");
  return {
    lastVisitedAt: null,
    latestRunCompletedAt: null,
    doneAt: null,
    doneReason: null,
    accessMode: "full-access",
    purpose: "task",
    teamOrigin: null,
    continuationIdentity: null,
    providerSessionId: null,
    createdAt: now,
    createdBy: ownerId,
    environmentId,
    harnessInstanceId,
    id,
    inputQueuePaused: false,
    lineageRootThreadId: id,
    listed: true,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: { effort: "low" },
      providerId: "openai",
    }),
    parentThreadId: null,
    pendingRequests: 0,

    status: "idle",
    title: "Do the work",
    icon: null,
    updatedAt: now,
  };
}

function makeMessage(
  threadId: Message["threadId"],
  kind: "assistant" | "input",
  text: string,
): Message {
  const runId = createId("run");
  return {
    author:
      kind === "input"
        ? {
            displayName: "Owner",
            kind: "human",
            principalId: `user:${ownerId}`,
            userId: ownerId,
          }
        : {
            displayName: "Opensteer",
            kind: "agent",
            runId,
            threadId,
          },
    content: [{ text, type: "text" }],
    createdAt: now,
    id: createId("message"),
    kind,
    runId,
    sequence: SequenceSchema.parse("1"),
    threadId,
  };
}

function makeThreadInput(message: Message) {
  return {
    teamRequestId: null,
    teamSource: null,
    assignmentId: null,
    cancelReason: null,
    causalChainId: createId("causalChain"),
    createdAt: message.createdAt,
    deliveredAt: message.createdAt,
    messageId: message.id,
    policy: "queue" as const,
    replyTarget: null,
    runId: message.runId,
    state: "delivered" as const,
    threadId: message.threadId,
    updatedAt: message.createdAt,
  };
}

function deploymentSnapshot(deployment: PersonalFixture, sequence: string) {
  const window = { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  const page = { asOfSequence: SequenceSchema.parse("0"), tasks: [], window };
  return {
    deploymentId: deployment.id,
    asOfSequence: SequenceSchema.parse("0"),
    messages: [],
    messageWindows: [],
    pendingRequests: [],
    pendingRequestWindow: window,
    runQueue: [],
    sequence: SequenceSchema.parse(sequence),
    serializedBytes: 256,
    threads: [],
    threadWindow: window,
    tasks: { recent: page, active: page, done: page },
    needsYou: { count: 0, entries: [], window },
    resources: {
      tabs: bootstrapFixtures.get(deployment.id)?.tabs ?? emptyTabs,
      browser: bootstrapFixtures.get(deployment.id)?.browser ?? {
        available: false,
        placements: [],
        profiles: [],
      },
    },
  };
}

function pendingRequest(input: {
  readonly presentation: OpensteerRequest["presentation"];
  readonly runId: OpensteerRequest["originatingRunId"];
  readonly threadId: OpensteerRequest["originatingThreadId"];
  readonly deploymentId: import("@opensteer/core").DeploymentId;
}): Extract<OpensteerRequest, { status: "pending" }> {
  const id = createId("request");
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id,
    kind: input.presentation.kind === "form" ? "harness.input" : "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: input.runId,
    originatingThreadId: input.threadId,

    payload: {
      kind: input.presentation.kind === "form" ? "harness.input" : "harness.approval",
    },
    presentation: input.presentation,
    requestedBy: ownerId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  };
}

function pendingIntegrationAccessRequest(input: {
  readonly optionId: string;
  readonly runId: OpensteerRequest["originatingRunId"];
  readonly threadId: OpensteerRequest["originatingThreadId"];
  readonly deploymentId: import("@opensteer/core").DeploymentId;
}): Extract<OpensteerRequest, { status: "pending" }> & {
  readonly kind: "integration.access";
  readonly payload: Extract<OpensteerRequest["payload"], { kind: "integration.access" }>;
} {
  const preinstall = input.optionId === "installed";
  const installationId = preinstall ? null : createIntegrationId("installation");
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind: "integration.access",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: input.runId,
    originatingThreadId: input.threadId,

    payload: {
      access: "read-write",
      installationId,
      kind: "integration.access",
      manifest: preinstall ? { kind: "catalog", definition: { id: "calendar" } } : null,
      reason: "Read and update the calendar",
      requestedConnectionId: null,
      requestedServerId: null,
    },
    presentation: {
      detail: "Read and update the calendar",
      kind: "choice",
      options: [{ hint: "confirm", id: input.optionId, label: "Continue" }],
      risk: "high",
      title: "Connect Calendar",
    },
    requestedBy: ownerId,
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  };
}

function sequence(value: string) {
  return SequenceSchema.parse(value);
}

function agentEvent<Type extends AgentEvent["type"]>(
  _deploymentId: import("@opensteer/core").DeploymentId,
  threadId: AgentEvent["threadId"],
  runId: AgentEvent["runId"],
  sequence: string,
  type: Type,
  data: Extract<AgentEvent, { type: Type }>["data"],
): Extract<AgentEvent, { type: Type }> {
  return {
    createdAt: now,
    data,
    environmentId,
    eventId: createId("event"),
    runId,
    sequence,
    threadId,
    type,
  } as Extract<AgentEvent, { type: Type }>;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function unauthorizedError() {
  return { code: "unauthorized", message: "Authentication required", retryable: false };
}

function parseSent(socket: FakeSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

/** One page picture as a viewer socket carries it. */
function browserFrame(surfaceId: string): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({
      encoding: "jpeg",
      frameId: 1,
      geometryRevision: 1,
      watchToken: "00000000-0000-4000-8000-000000000001",
      rasterHeight: 1,
      rasterWidth: 1,
      surfaceId,
      viewportHeight: 720,
      viewportWidth: 1_280,
    }),
  );
  const image = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const frame = new Uint8Array(4 + header.byteLength + image.byteLength);
  new DataView(frame.buffer).setUint32(0, header.byteLength, false);
  frame.set(header, 4);
  frame.set(image, 4 + header.byteLength);
  return frame.buffer;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
}

describe("task marks through the production client and mock transport", () => {
  it("refuses a reused send key with a different task or command and retries current marks", async () => {
    const mock = new MockHostClient({ latencyMs: 0, places: "absent" });
    const transport = new MockPersonalHost(mock);
    const client = new HttpHostClient({
      baseUrl: "http://mock-host",
      capabilities: ["task-marks-v1"],
      fetch: transport.fetch,
      webSocketFactory: transport.connect,
    });
    try {
      await client.load();
      await vi.waitFor(() => expect(client.getSnapshot().tasks).not.toBeNull());
      const [first, second] = mock.getSnapshot().threads;
      const command = {
        type: "thread.icon.set" as const,
        threadId: first!.id,
        icon: "plane" as const,
        idempotencyKey: "shared-mark-key",
      };
      await client.dispatch(command);
      await expect(client.dispatch({ ...command, threadId: second!.id })).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(
        client.dispatch({
          type: "thread.sendMessage",
          threadId: first!.id,
          content: [{ type: "text", text: "A different command" }],
          idempotencyKey: command.idempotencyKey,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await client.dispatch({ ...command, icon: "gift", idempotencyKey: "newer" });
      expect(await client.dispatch(command)).toMatchObject({
        type: "thread.icon.set",
        thread: { id: first!.id, icon: "gift" },
      });
      expect(
        client.getSnapshot().tasks?.entries.find(({ thread }) => thread.id === first!.id)?.thread
          .icon,
      ).toBe("gift");
    } finally {
      client.dispose();
      transport.dispose();
    }
  });
});

describe("HttpHostClient overnight transcript residency", () => {
  /*
   * Failure modes, before changing the projection:
   * - unshown Threads accumulate durable entries and streamed text indefinitely;
   * - skipping transcript content also skips Run, Request or assignment state;
   * - the first activation or observation never rereads missed history, or repeated
   *   holds reread the same page and releasing one holder stops another's updates;
   * - reconnect clears readable history or changes its event cursor before a
   *   replacement succeeds, and a failed read looks like an empty conversation;
   * - a successful retry drops durable or live events received during its read;
   * - an outstanding read restores a previous viewer or a refused Workspace.
   */
  function page(thread: Thread, events: AgentEvent[], asOfSequence: string) {
    return {
      events,
      asOfSequence,
      thread,
      threadId: thread.id,
      window: {
        byteCount: new TextEncoder().encode(JSON.stringify(events)).byteLength,
        hasMore: true,
        itemCount: events.length,
        nextBefore: events[0]?.sequence ?? null,
        threadId: thread.id,
        totalItems: 1_000,
      },
    };
  }

  async function residentFixture(
    hydrate = true,
    omitSnapshotMessages = false,
    lifecycle?: ClientLifecycle,
  ) {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const other = makeThread(workspace.id);
    const runId = createId("run");
    const replyId = createId("message");
    const events: AgentEvent[] = [
      agentEvent(workspace.id, thread.id, runId, "1", "run.started", { status: "running" }),
      agentEvent(workspace.id, thread.id, runId, "2", "tool.started", {
        arguments: { command: "inspect the overnight work" },
        callId: "kept-step",
        tool: { name: "shell", namespace: "codex" },
      }),
      agentEvent(workspace.id, thread.id, runId, "3", "tool.completed", {
        callId: "kept-step",
        isError: false,
        output: { text: "The previous work remains readable." },
      }),
      agentEvent(workspace.id, thread.id, runId, "4", "assistant.message", {
        content: [{ text: "An already loaded answer.", type: "text" }],
        messageId: replyId,
      }),
      agentEvent(workspace.id, thread.id, runId, "5", "run.completed", {
        replyMessageId: replyId,
        status: "completed",
      }),
    ];
    const histories = new Map([
      [thread.id, page(thread, events, "5")],
      [other.id, page(other, [], "5")],
    ]);
    const reads: string[] = [];
    const socket = new FakeSocket();
    const held: Array<{
      readonly asked: ReturnType<typeof Promise.withResolvers<void>>;
      readonly answer: ReturnType<typeof Promise.withResolvers<Response>>;
    }> = [];
    let boot = bootstrap([workspace]);
    const client = createHttpHostClient({
      ...(lifecycle ? { lifecycle } : {}),
      capabilities: omitSnapshotMessages ? ["snapshot-messages-omit-v1", "person-show-v1"] : [],
      webSocketFactory: () => socket,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const payload = rpcPayload(url, init);
        const threadId = payload.threadId;
        if (url.pathname === "/v1/rpc/thread.events.list") {
          const id = ThreadIdSchema.parse(threadId);
          reads.push(id);
          const pending = id === thread.id ? held.shift() : undefined;
          if (pending) {
            pending.asked.resolve();
            return pending.answer.promise;
          }
          return json(histories.get(id));
        }
        if (url.pathname === "/v1/rpc/thread.inputQueue.get")
          return json({ items: [], paused: false, steerRunId: null, threadId });
        if (url.pathname === "/v1/rpc/thread.requests.list")
          return json({ requests: [], threadId, window: emptyDurableWindow() });
        if (url.pathname === "/v1/rpc/thread.assignments.list")
          return json({ assignments: [], threadId, window: emptyDurableWindow() });
        if (url.pathname === "/v1/rpc/thread.live.get") return json({ runs: [], threadId });
        return json(boot);
      },
    });
    await client.load();
    socket.open();
    socket.receive({
      type: "host.snapshot",
      snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread, other] },
    });
    if (hydrate) {
      client.activateThread(thread.id);
      await vi.waitFor(() =>
        expect(client.getSnapshot().transcripts[thread.id]?.some(({ id }) => id === replyId)).toBe(
          true,
        ),
      );
    }
    return {
      client,
      events,
      histories,
      other,
      reads,
      runId,
      replyId,
      socket,
      thread,
      workspace,
      holdHistory() {
        const pending = {
          asked: Promise.withResolvers<void>(),
          answer: Promise.withResolvers<Response>(),
        };
        held.push(pending);
        return pending;
      },
      changeViewer() {
        boot = { ...boot, user: { ...boot.user, id: createId("user") } };
      },
    };
  }

  function emptyDurableWindow() {
    return { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  }

  it.each([false, true])(
    "negotiates omitted snapshot messages only with a capable Host (%s)",
    async (capable) => {
      const f = await residentFixture(false, capable);
      try {
        const subscription = parseSent(f.socket, 0);
        if (capable) expect(subscription).toHaveProperty("snapshotMessages", "omit");
        else expect(subscription).not.toHaveProperty("snapshotMessages");
        if (capable) expect(subscription).toHaveProperty("personShow", "accept");
        else expect(subscription).not.toHaveProperty("personShow");
      } finally {
        f.client.dispose();
      }
    },
  );

  it("delivers show only while foregrounded and never retains it for a later listener", async () => {
    const platform = fakeLifecycle();
    const f = await residentFixture(false, true, platform.lifecycle);
    const received = vi.fn();
    const release = f.client.subscribePersonShow(received);
    const message = {
      type: "host.show" as const,
      runId: createId("run"),

      threadId: f.thread.id,
      target: { taskId: f.other.id },
    };
    try {
      f.socket.receive(message);
      expect(received).toHaveBeenCalledExactlyOnceWith(message);
      received.mockClear();
      platform.enterBackground();
      f.socket.receive(message);
      expect(received).not.toHaveBeenCalled();
      platform.enterForeground();
      expect(received).not.toHaveBeenCalled();
      release();
      const later = vi.fn();
      const releaseLater = f.client.subscribePersonShow(later);
      expect(later).not.toHaveBeenCalled();
      releaseLater();
    } finally {
      release();
      f.client.dispose();
    }
  });

  it.each(["activate", "observe"] as const)(
    "leaves omitted history unloaded until %s reads its first durable page",
    async (mode) => {
      const f = await residentFixture(false, true);
      const pending = f.holdHistory();
      let release: (() => void) | undefined;
      try {
        // A previous full snapshot may have seeded a message window. It is not
        // coverage for this new snapshot's omitted history.
        f.socket.receive({
          type: "host.snapshot",
          snapshot: {
            ...deploymentSnapshot(f.workspace, "5"),
            threads: [f.thread, f.other],
            messages: [makeMessage(f.thread.id, "assistant", "Snapshot-only seed")],
            messageWindows: [{ ...emptyDurableWindow(), threadId: f.thread.id }],
          },
        });
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ body: "Snapshot-only seed" }),
        );
        f.socket.receive({
          type: "host.snapshot",
          snapshot: {
            ...deploymentSnapshot(f.workspace, "5"),
            threads: [f.thread, f.other],
            messagesOmitted: true,
          },
        });
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBeUndefined();
        expect(f.reads).toEqual([]);
        if (mode === "activate") f.client.activateThread(f.thread.id);
        else release = f.client.observeThread(f.thread.id);
        await pending.asked.promise;
        expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBe("loading");
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBeUndefined();
        pending.answer.resolve(json(page(f.thread, f.events, "5")));
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toMatchObject({
            hasMore: true,
            nextBefore: "1",
            totalItems: 1_000,
          }),
        );
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ body: "An already loaded answer." }),
        );
        expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBeUndefined();
        expect(f.reads).toEqual([f.thread.id]);
      } finally {
        pending.answer.resolve(json(page(f.thread, f.events, "5")));
        release?.();
        f.client.dispose();
      }
    },
  );

  it("keeps historical reading and its cursor through an omitted-history snapshot", async () => {
    const f = await residentFixture(true, true);
    try {
      await f.client.loadTranscriptAround(f.thread.id, f.replyId);
      const entries = f.client.getSnapshot().transcripts[f.thread.id];
      const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
      const reads = f.reads.length;
      f.socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...deploymentSnapshot(f.workspace, "10"),
          threads: [f.thread, f.other],
          messagesOmitted: true,
        },
      });
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
      expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
      expect(f.reads).toHaveLength(reads);
    } finally {
      f.client.dispose();
    }
  });

  it("does not retain an unopened Thread's overnight output while keeping its current state", async () => {
    const f = await residentFixture(false);
    try {
      f.client.activateThread(f.other.id);
      const retained = f.client.getSnapshot().transcripts[f.thread.id];
      const runId = createId("run");
      const request = pendingRequest({
        presentation: {
          kind: "choice",
          title: "Continue?",
          detail: "Review the work",
          risk: "low",
          options: [{ hint: "confirm", id: "yes", label: "Continue" }],
        },
        runId,
        threadId: f.thread.id,
        deploymentId: f.workspace.id,
      });
      const assignment = {
        createdAt: now,
        currentRunId: runId,
        currentRunStatus: "waiting" as const,
        finishedAt: null,
        id: createId("delegation"),
        initialRunId: runId,
        modelLabel: f.thread.modelSelection.modelId,
        objectivePreview: "Check the overnight task",
        origin: "run" as const,
        parentThreadId: f.other.id,
        resultPreview: null,
        returnStatus: "pending" as const,
        revision: 1,
        status: "open" as const,
        updatedAt: now,
        workerThread: {
          environmentId,
          id: f.thread.id,
          pendingRequests: 1,
          status: "waiting" as const,
          title: f.thread.title,
          icon: null,
        },
      };
      const output = Array.from({ length: 100 }, (_, index) =>
        agentEvent(f.workspace.id, f.thread.id, runId, String(index + 10), "assistant.message", {
          content: [{ text: `Overnight update ${index}`, type: "text" }],
          messageId: createId("message"),
        }),
      );
      const overnightFrame = {
        throughSequence: sequence("112"),
        type: "host.events" as const,
        events: [
          agentEvent(f.workspace.id, f.thread.id, runId, "6", "run.queued", {
            run: {
              id: runId,
              runOrdinal: 1,
              status: "queued",
              threadId: f.thread.id,
              createdAt: now,
            },
          }),
          agentEvent(f.workspace.id, f.thread.id, runId, "7", "run.started", { status: "running" }),
          ...output,
          agentEvent(f.workspace.id, f.thread.id, runId, "110", "request.opened", { request }),
          agentEvent(f.workspace.id, f.thread.id, runId, "111", "assignment.updated", {
            assignment,
          }),
          agentEvent(f.workspace.id, f.thread.id, null, "112", "thread.state-changed", {
            inputQueuePaused: false,
            pendingRequests: 1,
            status: "waiting",
          }),
        ],
      };
      HostToClientMessageSchema.parse(overnightFrame);
      f.socket.receive(overnightFrame);
      f.socket.receive({
        type: "host.live",

        afterSequence: sequence("112"),
        progress: {
          threadId: f.thread.id,
          runId,
          items: [{ op: "append", at: 0, stream: "assistant", text: "Still writing overnight" }],
        },
      });
      const snapshot = f.client.getSnapshot();
      const current = snapshot.threads.find(({ id }) => id === f.thread.id)!;
      expect(current).toMatchObject({ status: "waiting", pendingRequests: 1 });
      expect(threadStopTarget({ runQueue: snapshot.runQueue, thread: current })?.id).toBe(runId);
      expect(snapshot.requests[f.thread.id]).toContainEqual(request);
      expect(snapshot.assignments[assignment.id]).toEqual(assignment);
      expect(snapshot.transcripts[f.thread.id]).toBe(retained);
    } finally {
      f.client.dispose();
    }
  });

  it.each(["activate", "observe"] as const)(
    "rereads missed history once on %s and keeps multiple observers live",
    async (mode) => {
      const f = await residentFixture(false);
      const releases: Array<() => void> = [];
      try {
        f.client.activateThread(f.other.id);
        const update = agentEvent(
          f.workspace.id,
          f.thread.id,
          f.runId,
          "6",
          "reasoning.completed",
          { blockId: "missed", text: "Work performed while elsewhere." },
        );
        f.histories.set(f.thread.id, page(f.thread, [...f.events, update], "6"));
        f.socket.receive(eventsFrame({ type: "host.events", events: [update] }));
        if (mode === "activate") {
          f.client.activateThread(f.thread.id);
          f.client.activateThread(f.thread.id);
        } else {
          releases.push(f.client.observeThread(f.thread.id), f.client.observeThread(f.thread.id));
          releases.shift()!();
        }
        await vi.waitFor(() => expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(1));
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
            expect.objectContaining({ id: `reasoning:${f.runId}:missed` }),
          ),
        );
        const later = agentEvent(f.workspace.id, f.thread.id, f.runId, "7", "reasoning.completed", {
          blockId: "held",
          text: "The remaining reader still sees this.",
        });
        f.socket.receive(eventsFrame({ type: "host.events", events: [later] }));
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ id: `reasoning:${f.runId}:held` }),
        );
        expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(1);
      } finally {
        for (const release of releases) release();
        f.client.dispose();
      }
    },
  );

  it("keeps cached older reading and live updates when returning from another task", async () => {
    // A latest-only reread must not discard the history to which the UI restores
    // a reader's saved position. Cached reader-owned windows stay live.
    const f = await residentFixture();
    try {
      const retained = f.client.getSnapshot().transcripts[f.thread.id]!;
      const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
      f.client.activateThread(f.other.id);
      const update = agentEvent(f.workspace.id, f.thread.id, f.runId, "6", "assistant.message", {
        content: [{ text: "A new update while reading another task.", type: "text" }],
        messageId: createId("message"),
      });
      f.histories.set(f.thread.id, page(f.thread, [update], "6"));
      f.socket.receive(eventsFrame({ type: "host.events", events: [update] }));
      f.client.activateThread(f.thread.id);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toEqual([
        ...retained,
        expect.objectContaining({ body: "A new update while reading another task." }),
      ]);
      expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
      expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(1);
    } finally {
      f.client.dispose();
    }
  });

  it.each([false, true])(
    "keeps active history and its event cursor through a failed reconnect read, then replaces them atomically (omitted=%s)",
    async (omitted) => {
      const f = await residentFixture(true, omitted);
      const first = f.holdHistory();
      try {
        const entries = f.client.getSnapshot().transcripts[f.thread.id];
        const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
        const installed: ReadonlyArray<{ readonly id: string }>[] = [];
        const unsubscribe = f.client.subscribe(() =>
          installed.push(f.client.getSnapshot().transcripts[f.thread.id] ?? []),
        );
        f.socket.receive({
          type: "host.snapshot",
          snapshot: {
            ...deploymentSnapshot(f.workspace, "10"),
            threads: [f.thread, f.other],
            ...(omitted
              ? { messagesOmitted: true }
              : { messageWindows: [{ ...emptyDurableWindow(), threadId: f.thread.id }] }),
          },
        });
        await first.asked.promise;
        expect.soft(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
        expect.soft(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
        first.answer.resolve(
          json(
            {
              error: {
                code: "internal",
                message: "History temporarily unavailable",
                retryable: true,
              },
            },
            503,
          ),
        );
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBe("failed"),
        );
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
        const retry = f.holdHistory();
        f.client.activateThread(f.thread.id);
        await retry.asked.promise;
        const missed = agentEvent(
          f.workspace.id,
          f.thread.id,
          f.runId,
          "9",
          "reasoning.completed",
          {
            blockId: "missed-reconnect",
            text: "Recorded while disconnected.",
          },
        );
        const arrived = agentEvent(
          f.workspace.id,
          f.thread.id,
          f.runId,
          "11",
          "reasoning.completed",
          { blockId: "during-read", text: "Arrived during the replacement read." },
        );
        f.socket.receive(eventsFrame({ type: "host.events", events: [arrived] }));
        retry.answer.resolve(json(page(f.thread, [...f.events, missed], "10")));
        await vi.waitFor(() =>
          expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
            expect.objectContaining({ id: `reasoning:${f.runId}:missed-reconnect` }),
          ),
        );
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ id: `reasoning:${f.runId}:during-read` }),
        );
        expect(f.client.getSnapshot().threadLookups[f.thread.id]).toBeUndefined();
        expect(
          installed.every((value) =>
            value.some(({ id }) => id === "tool:" + f.runId + ":kept-step"),
          ),
        ).toBe(true);
        unsubscribe();
      } finally {
        first.answer.resolve(json(page(f.thread, f.events, "10")));
        f.client.dispose();
      }
    },
  );

  it("rereads hydrated history when a newer snapshot covers a transcript gap", async () => {
    const f = await residentFixture();
    try {
      const missed = agentEvent(f.workspace.id, f.thread.id, f.runId, "9", "reasoning.completed", {
        blockId: "hydrated-snapshot-gap",
        text: "Recorded after the hydrated page while disconnected.",
      });
      f.histories.set(f.thread.id, page(f.thread, [...f.events, missed], "10"));
      f.socket.receive({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(f.workspace, "10"), threads: [f.thread, f.other] },
      });
      await vi.waitFor(() =>
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
          expect.objectContaining({ id: `reasoning:${f.runId}:hydrated-snapshot-gap` }),
        ),
      );
      expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(2);
    } finally {
      f.client.dispose();
    }
  });

  it("requires the newest overtaking snapshot and caps uncovered history rereads", async () => {
    const f = await residentFixture();
    const pending = f.holdHistory();
    try {
      const entries = f.client.getSnapshot().transcripts[f.thread.id];
      const window = f.client.getSnapshot().transcriptWindows[f.thread.id];
      f.histories.set(f.thread.id, page(f.thread, f.events, "8"));
      const reading = f.client.loadLatestTranscript(f.thread.id);
      await pending.asked.promise;
      for (const sequence of ["10", "8"]) {
        f.socket.receive({
          type: "host.snapshot",
          snapshot: { ...deploymentSnapshot(f.workspace, sequence), threads: [f.thread, f.other] },
        });
      }
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      await expect(reading).rejects.toThrow(
        "The connection changed while loading this conversation",
      );
      expect(f.reads.filter((id) => id === f.thread.id)).toHaveLength(5);
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(entries);
      expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBe(window);
    } finally {
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      f.client.dispose();
    }
  });

  it("keeps current Run places outside a message-centered historical window", async () => {
    const f = await residentFixture(true, true);
    const runId = createId("run");
    const entered = (sequence: string) =>
      agentEvent(f.workspace.id, f.thread.id, runId, sequence, "place.entered", {
        tabId: BrowserSurfaceIdSchema.parse(`historical-tab-${sequence}`),
        title: `Current page ${sequence}`,
        site: "https://example.com",
      });
    try {
      const first = entered("7");
      f.socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(f.workspace.id, f.thread.id, runId, "6", "run.started", {
              status: "running",
            }),
            first,
          ],
        }),
      );
      expect(f.client.runPlace(runId)).toEqual(first);
      await f.client.loadTranscriptAround(f.thread.id, f.replyId);
      const history = f.client.getSnapshot().transcripts[f.thread.id];
      const current = entered("8");
      f.socket.receive(eventsFrame({ type: "host.events", events: [current] }));
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toBe(history);
      expect(f.client.runPlace(runId)).toEqual(current);
      f.socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(f.workspace.id, f.thread.id, runId, "9", "run.completed", {
              status: "completed",
              replyMessageId: null,
            }),
          ],
        }),
      );
      expect(f.client.runPlace(runId)).toBeNull();
    } finally {
      f.client.dispose();
    }
  });

  it("rereads an outstanding transcript after a snapshot even when Thread state did not change", async () => {
    const f = await residentFixture();
    const pending = f.holdHistory();
    try {
      const reading = f.client.loadLatestTranscript(f.thread.id);
      await pending.asked.promise;
      const missed = agentEvent(f.workspace.id, f.thread.id, f.runId, "9", "reasoning.completed", {
        blockId: "snapshot-gap",
        text: "New activity without a Thread status transition.",
      });
      f.histories.set(f.thread.id, page(f.thread, [...f.events, missed], "10"));
      f.socket.receive({
        type: "host.snapshot",
        snapshot: {
          ...deploymentSnapshot(f.workspace, "10"),
          threads: [f.thread, f.other],
        },
      });
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      await reading;
      expect(f.client.getSnapshot().transcripts[f.thread.id]).toContainEqual(
        expect.objectContaining({ id: `reasoning:${f.runId}:snapshot-gap` }),
      );
    } finally {
      pending.answer.resolve(json(page(f.thread, f.events, "5")));
      f.client.dispose();
    }
  });

  it.each(["viewer", "Deployment access"] as const)(
    "does not restore history whose %s was removed while the read was pending",
    async (removed) => {
      const f = await residentFixture();
      const pending = f.holdHistory();
      try {
        const reading = f.client.loadLatestTranscript(f.thread.id);
        await pending.asked.promise;
        if (removed === "viewer") {
          f.changeViewer();
          await f.client.refresh();
        } else {
          f.socket.receive({
            type: "host.error",
            error: {
              code: "forbidden",
              message: "Deployment access ended",
              reason: "deployment-forbidden",
              retryable: false,
            },
          });
        }
        pending.answer.resolve(json(page(f.thread, f.events, "10")));
        await reading;
        expect(f.client.getSnapshot().transcripts[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().transcriptWindows[f.thread.id]).toBeUndefined();
        expect(f.client.getSnapshot().threads.some(({ id }) => id === f.thread.id)).toBe(false);
      } finally {
        pending.answer.resolve(json(page(f.thread, f.events, "10")));
        f.client.dispose();
      }
    },
  );
});

it.each([false, true])(
  "gates the passkey viewer opt-in on the Host capability (%s)",
  async (capable) => {
    const workspace = makeDeployment("Example");
    const page = pageTabHost(workspace);
    const { sessionId, tabId } = page;
    const sockets: { url: string; socket: FakeSocket }[] = [];
    const client = createHttpHostClient({
      capabilities: capable
        ? ["browser-passkeys-v1", "browser-target-control-v1"]
        : ["browser-target-control-v1"],
      fetch: page.fetch,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
    });
    try {
      await client.load();
      await client.activateTab(tabId);
      const release = client.retainBrowserViewer(sessionId, tabId, { picture: false });
      const connection = sockets.find(({ url }) => url.includes("/browser-sessions/"))!;
      expect(new URL(connection.url).searchParams.get("passkeys")).toBe(capable ? "notice" : null);
      expect(new URL(connection.url).searchParams.get("popups")).toBe("1");
      expect(new URL(connection.url).searchParams.get("autofill")).toBe("2");
      expect(new URL(connection.url).searchParams.get("basicInput")).toBe("1");
      expect(new URL(connection.url).searchParams.get(apiVersionQueryParameter)).toBe(
        String(minimumHostApiVersion),
      );
      expect(new URL(connection.url).searchParams.get(apiCurrentQueryParameter)).toBe(
        String(hostApiVersion),
      );
      const popups: string[] = [];
      const stopPopups = client.subscribeBrowserPopups(sessionId, tabId, (id) => popups.push(id));
      connection.socket.open();
      connection.socket.receiveRaw({
        type: "browser.snapshot",
        sessionId,
        access: "read-write",
        state: "ready",
        dialog: null,
        targetedStreamingVersion: 1,
        surfaces: [{ id: tabId, active: true, title: "Example", url: "https://example.test" }],
        basicInput: 1,
        ...(capable ? { passkeys: "notice" } : {}),
      });
      // Only what the Host returned is offered; a watcher never asks for input.
      expect(client.browserViewerState(sessionId, tabId).input).toBe("basic");
      const releaseWatch = client.retainBrowserWatch(sessionId, tabId);
      const watch = sockets.find(({ url }) => new URL(url).searchParams.get("mode") === "watch")!;
      expect(new URL(watch.url).searchParams.has("basicInput")).toBe(false);
      releaseWatch();
      if (capable) {
        connection.socket.receiveRaw({ type: "browser.passkey.notice", surfaceId: tabId });
        expect(client.browserPasskeys.get(sessionId, tabId)).toEqual({ kind: "notice" });
      }
      const opened = {
        type: "browser.popup.opened",
        surfaceId: "srf_00000000-0000-4000-8000-000000000099",
        consumerToken: "00000000-0000-4000-8000-000000000098",
      };
      connection.socket.receiveRaw(opened);
      expect(popups).toEqual([opened.surfaceId]);
      stopPopups();
      connection.socket.receiveRaw(opened);
      expect(popups).toHaveLength(1);
      release();
      expect(client.browserPasskeys.get(sessionId, tabId)).toBeNull();
    } finally {
      client.dispose();
    }
  },
);

describe("attachment reads", () => {
  const boundedRead = (client: HttpHostClient, id: string, signal?: AbortSignal) =>
    withTimeout(client.readAttachment(id, signal), 1_000, {
      timeoutError: () => new Error("Attachment read did not settle"),
    });
  const content = (size = 4) => ({
    ok: true as const,
    data: {
      bytes: new Uint8Array(size),
      metadata: {
        contentType: "image/png",
        etag: "immutable",
        modifiedAt: null,
        sizeBytes: size,
        truncated: false as const,
      },
    },
  });
  function attachmentRpc(client: HttpHostClient) {
    const rpc = vi.fn<(typeof client.rpc)["attachment.content"]>();
    Object.defineProperty(client.rpc, "attachment.content", { value: rpc });
    return rpc;
  }
  function pendingRead() {
    const client = createHttpHostClient({});
    let complete!: (value: ReturnType<typeof content>) => void;
    const pending = new Promise<ReturnType<typeof content>>((resolve) => {
      complete = resolve;
    });
    const rpc = attachmentRpc(client).mockReturnValue(pending);
    return { client, rpc, complete };
  }

  it("shares concurrent reads, isolates cancellation, and caches completed bytes", async () => {
    const { client, rpc, complete } = pendingRead();
    try {
      const abort = new AbortController();
      const first = boundedRead(client, "image", abort.signal);
      const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
      const second = boundedRead(client, "image");
      abort.abort();
      await rejected;
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]![1]?.signal?.aborted).toBe(false);
      complete(content());
      expect((await second).size).toBe(4);
      expect((await boundedRead(client, "image")).size).toBe(4);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      client.dispose();
    }
  });

  it("keeps the request through synchronous cleanup and remount, then cancels when unused", async () => {
    const { client, rpc } = pendingRead();
    try {
      const a = new AbortController();
      const first = boundedRead(client, "image", a.signal);
      const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
      a.abort();
      const b = new AbortController();
      const second = boundedRead(client, "image", b.signal);
      const secondRejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
      await firstRejected;
      expect(rpc).toHaveBeenCalledTimes(1);
      const signal = rpc.mock.calls[0]![1]!.signal!;
      expect(signal.aborted).toBe(false);
      b.abort();
      expect(signal.aborted).toBe(false);
      await secondRejected;
      expect(signal.aborted).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("aborts active reads and refuses cached bytes after disposal", async () => {
    const { client, rpc, complete } = pendingRead();
    try {
      const completed = boundedRead(client, "cached");
      complete(content());
      await completed;
      rpc.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = boundedRead(client, "pending");
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      client.dispose();
      await rejected;
      expect(rpc.mock.calls[1]![1]!.signal!.aborted).toBe(true);
      await expect(boundedRead(client, "cached")).rejects.toMatchObject({ name: "AbortError" });
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it("evicts least recently used bytes and excludes oversized items", async () => {
    const client = createHttpHostClient({});
    const rpc = attachmentRpc(client).mockResolvedValue(content(12 * 1024 * 1024));
    try {
      await boundedRead(client, "a");
      await boundedRead(client, "b");
      await boundedRead(client, "a");
      await boundedRead(client, "c");
      await boundedRead(client, "a");
      expect(rpc).toHaveBeenCalledTimes(3);
      await boundedRead(client, "b");
      expect(rpc).toHaveBeenCalledTimes(4);
      rpc.mockResolvedValue(content(33 * 1024 * 1024));
      await boundedRead(client, "large");
      await boundedRead(client, "large");
      expect(rpc).toHaveBeenCalledTimes(6);
    } finally {
      client.dispose();
    }
  });

  it("does not cache failures or issue a request for an already aborted caller", async () => {
    const client = createHttpHostClient({});
    const rpc = attachmentRpc(client)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(content());
    try {
      await expect(boundedRead(client, "image")).rejects.toThrow("offline");
      await boundedRead(client, "image");
      expect(rpc).toHaveBeenCalledTimes(2);
      await expect(boundedRead(client, "other", AbortSignal.abort())).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it.each(["sign-out", "user", "deployment"] as const)(
    "clears bytes and in-flight reads on %s",
    async (change) => {
      let payload = bootstrap([]);
      let authenticated = true;
      const client = createHttpHostClient({
        fetch: async (input) => {
          const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
          if (path === "/v1/rpc/auth.config") return json(payload.identityConfig);
          return authenticated ? json(payload) : json({ error: unauthorizedError() }, 401);
        },
      });
      try {
        await client.load();
        const rpc = attachmentRpc(client).mockResolvedValue(content());
        await boundedRead(client, "image");
        let complete!: (value: ReturnType<typeof content>) => void;
        rpc.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
        );
        const pending = boundedRead(client, "pending");
        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        if (change === "sign-out") authenticated = false;
        else if (change === "user")
          payload = { ...payload, user: { ...payload.user, id: createId("user") } };
        else payload = { ...payload, deploymentId: createId("deployment") };
        await client.refresh();
        await rejected;
        complete(content());
        await boundedRead(client, "image");
        await boundedRead(client, "pending");
        expect(rpc).toHaveBeenCalledTimes(4);
      } finally {
        client.dispose();
      }
    },
  );
});

describe("a Run's current place", () => {
  it("keeps places through queued, starting, running and a restarted binding, fencing only terminal status", async () => {
    const workspace = makeDeployment(),
      thread = makeThread(workspace.id),
      runId = createId("run");
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      capabilities: ["place-events-v1"],
      webSocketFactory: () => socket,
      fetch: async () => json(bootstrap([workspace])),
    });
    try {
      await client.load();
      socket.open();
      socket.receiveRaw({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [thread], runPlaces: [] },
      });
      let sequence = 0;
      const status = (value: "queued" | "starting" | "running" | "waiting" | "completed") =>
        socket.receive(
          eventsFrame({
            type: "host.events",
            events: [
              agentEvent(workspace.id, thread.id, runId, String(++sequence), "run.status", {
                status: value,
              }),
            ],
          }),
        );
      const enter = () => {
        const event = agentEvent(
          workspace.id,
          thread.id,
          runId,
          String(++sequence),
          "place.entered",
          {
            tabId: BrowserSurfaceIdSchema.parse("startup-tab"),
            title: "Page",
            site: null,
          },
        );
        socket.receive(eventsFrame({ type: "host.events", events: [event] }));
        return event;
      };
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, runId, String(++sequence), "run.queued", {
              run: {
                id: runId,
                threadId: thread.id,
                createdAt: now,
                runOrdinal: 1,
                status: "queued",
              },
            }),
          ],
        }),
      );
      status("starting");
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, runId, String(++sequence), "run.started", {
              status: "running",
            }),
          ],
        }),
      );
      const first = enter();
      expect(client.runPlace(runId)).toEqual(first);
      for (const value of ["waiting", "starting", "running"] as const) {
        status(value);
        const event = enter();
        expect(client.runPlace(runId)).toEqual(event);
      }
      status("completed");
      expect(client.runPlace(runId)).toBeNull();
      enter();
      expect(client.runPlace(runId)).toBeNull();
    } finally {
      client.dispose();
    }
  });
  it("seeds omitted transcripts, follows unopened live events, survives older snapshots, and drops terminal or changed-viewer entries", async () => {
    const workspace = makeDeployment(),
      thread = makeThread(workspace.id),
      runId = createId("run");
    const place = (sequence: string) =>
      agentEvent(workspace.id, thread.id, runId, sequence, "place.entered", {
        tabId: BrowserSurfaceIdSchema.parse(`tab-${sequence}`),
        title: `Page ${sequence}`,
        site: "https://example.com",
      });
    const first = place("2"),
      second = place("4");
    let boot = bootstrap([workspace]);
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      capabilities: ["place-events-v1", "snapshot-messages-omit-v1"],
      webSocketFactory: () => socket,
      fetch: async () => json(boot),
    });
    try {
      await client.load();
      socket.open();
      const seed = {
        ...deploymentSnapshot(workspace, "3"),
        threads: [thread],
        messagesOmitted: true as const,
        runQueue: [
          {
            createdAt: now,
            id: runId,
            runOrdinal: 1,
            status: "running" as const,
            threadId: thread.id,
          },
        ],
        runPlaces: [first],
      };
      socket.receiveRaw({ type: "host.snapshot", snapshot: seed });
      expect(client.runPlace(runId)).toEqual(first);
      expect(client.getSnapshot().transcripts[thread.id]).toBeUndefined();
      socket.receive(eventsFrame({ type: "host.events", events: [second] }));
      expect(client.runPlace(runId)).toEqual(second);
      expect(client.getSnapshot().transcripts[thread.id]).toBeUndefined();
      socket.receiveRaw({ type: "host.snapshot", snapshot: seed });
      expect(client.runPlace(runId)).toEqual(second);
      // A Host that cannot fit a complete seed omits it rather than ending these Runs.
      const { runPlaces: _places, ...unknownPlaces } = seed;
      socket.receiveRaw({
        type: "host.snapshot",
        snapshot: { ...unknownPlaces, sequence: "4" },
      });
      expect(client.runPlace(runId)).toEqual(second);
      socket.receive(
        eventsFrame({
          type: "host.events",
          events: [
            agentEvent(workspace.id, thread.id, runId, "5", "run.completed", {
              status: "completed",
              replyMessageId: null,
            }),
          ],
        }),
      );
      expect(client.runPlace(runId)).toBeNull();
      socket.receiveRaw({ type: "host.snapshot", snapshot: seed });
      expect(client.runPlace(runId)).toBeNull();
      const another = { ...second, runId: createId("run"), sequence: SequenceSchema.parse("6") };
      socket.receive(eventsFrame({ type: "host.events", events: [another] }));
      expect(client.runPlace(another.runId!)).toEqual(another);
      boot = { ...boot, user: { ...boot.user, id: createId("user") } };
      await client.refresh();
      expect(client.runPlace(another.runId!)).toBeNull();
    } finally {
      client.dispose();
    }
  });
});

it("uses a real app entry URL when supplied and resolves the Host path otherwise", async () => {
  const client = createHttpHostClient();
  const at = new Date().toISOString();
  const app = AppSchema.parse({
    appId: "app_11111111-1111-4111-8111-111111111111",
    name: "App",
    kind: "html",
    state: "running",
    computerId: createId("runner"),
    taskId: null,
    version: 1,
    server: null,
    createdAt: at,
    updatedAt: at,
  });
  const path = `/v1/apps/${app.appId}/dark/${"a".repeat(43)}/`;
  const entryUrl =
    "https://aaaaaaaaaaaaaaaaaaaaaaaaaa-11111111111111111111111111111111.example.test/?opensteer-ticket=test";
  const read = vi.fn<(typeof client.rpc)["apps.view"]>();
  Object.defineProperty(client.rpc, "apps.view", { value: read });
  read.mockResolvedValueOnce({ ok: true, data: { app, path, entryUrl } });
  read.mockResolvedValueOnce({ ok: true, data: { app, path } });
  try {
    expect(await client.viewApp(app.appId, "dark")).toEqual({ title: "App", url: entryUrl });
    expect((await client.viewApp(app.appId, "dark")).url).toBe(`http://127.0.0.1${path}`);
  } finally {
    client.dispose();
  }
});

it("hydrates older running helper cards and routes a watched node's work only to its detail", async () => {
  const workspace = makeDeployment();
  const thread = makeThread(workspace.id);
  const runId = createId("run");
  const nodeId = createId("executionNode");
  const socket = new FakeSocket();
  const window = { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  const nodeReads: Readonly<Record<string, unknown>>[] = [];
  const client = createHttpHostClient({
    capabilities: ["node-detail-v1"],
    webSocketFactory: () => socket,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const payload = rpcPayload(url, init);
      if (url.pathname === "/v1/rpc/thread.events.list")
        return json({
          thread,
          threadId: thread.id,
          events: [],
          window: { ...window, threadId: thread.id },
          asOfSequence: SequenceSchema.parse("10"),
        });
      const node = {
        id: nodeId,
        attemptId: createId("runAttempt"),
        runId,
        kind: "subagent",
        title: "Older reviewer",
        status: "running",
        model: "gpt-6.1-sol",
        effort: "high",
        parentNodeId: null,
        phaseIndex: null,
        phases: [],
        prompt: "Review",
        result: null,
        startedAt: "2026-08-09T19:00:00.000Z",
        endedAt: null,
        usage: null,
      };
      if (url.pathname === "/v1/rpc/run.attempts.list")
        return json({ runId, attempts: [], nodes: [node] });
      if (url.pathname === "/v1/rpc/node.events.list") {
        nodeReads.push(payload);
        return json({ nodeId, threadId: thread.id, node, events: [], window });
      }
      if (url.pathname === "/v1/rpc/thread.requests.list")
        return json({ threadId: thread.id, requests: [], window });
      if (url.pathname === "/v1/rpc/thread.assignments.list")
        return json({ threadId: thread.id, assignments: [], window });
      return json(bootstrap([workspace]));
    },
  });
  try {
    await client.load();
    socket.open();
    socket.receive({
      type: "host.snapshot",
      snapshot: {
        ...deploymentSnapshot(workspace, "10"),
        threads: [thread],
        runQueue: [
          { id: runId, threadId: thread.id, runOrdinal: 1, status: "running", createdAt: now },
        ],
      },
    });
    socket.receive({
      type: "host.synchronized",

      sequence: sequence("10"),
    });
    await client.loadLatestTranscript(thread.id);
    expect(client.getSnapshot().transcripts[thread.id]).toMatchObject([
      { kind: "node", nodeId, effort: "high" },
    ]);
    const detail = client.watchNode(thread.id, nodeId);
    expect(socket.sent.map((data) => JSON.parse(data))).toContainEqual({
      type: "client.watch-node",
      nodeId,
    });
    socket.receive({
      type: "host.node-watched",
      nodeId,

      sequence: sequence("10"),
    });
    await vi.waitFor(() => expect(detail.getSnapshot().status).toBe("ready"));
    expect(nodeReads).toEqual([{ threadId: thread.id, nodeId, through: "10", limit: 100 }]);
    socket.receive(
      eventsFrame({
        type: "host.events",
        events: [
          agentEvent(workspace.id, thread.id, runId, "11", "tool.started", {
            nodeId,
            callId: "child-read",
            tool: { namespace: "functions", name: "read" },
            arguments: {},
          }),
        ],
      }),
    );
    socket.receive({
      type: "host.live",

      afterSequence: sequence("11"),
      progress: {
        threadId: thread.id,
        runId,
        items: [
          {
            stream: "tool",
            nodeId,
            callId: "child-read",
            op: "replace",
            length: 7,
            text: "partial",
          },
          { stream: "node", nodeId, op: "replace", length: 7, text: "Reading" },
        ],
      },
    });
    expect(detail.getSnapshot().entries).toMatchObject([{ kind: "tool", streamText: "partial" }]);
    expect(client.getSnapshot().transcripts[thread.id]).toMatchObject([
      { kind: "node", nodeId, progress: "Reading" },
    ]);
    detail.release();
    expect(socket.sent.map((data) => JSON.parse(data))).toContainEqual({
      type: "client.watch-node",
      nodeId: null,
    });
    const reopened = client.watchNode(thread.id, nodeId);
    socket.receive({
      type: "host.node-watched",
      nodeId,

      sequence: sequence("11"),
    });
    await vi.waitFor(() => expect(reopened.getSnapshot().status).toBe("ready"));
    socket.receiveRaw({
      type: "host.error",
      error: {
        code: "forbidden",
        message: "Access ended",
        reason: "deployment-forbidden",
        retryable: false,
      },
    });
    expect(reopened.getSnapshot()).toMatchObject({ status: "closed", entries: [], node: null });
    await Promise.resolve();
    expect(client.getSnapshot().threads.some((entry) => entry.id === thread.id)).toBe(false);
    reopened.release();
  } finally {
    client.dispose();
  }
});

describe("HttpHostClient command projection", () => {
  it("answers a Request without leaving the Thread owing the Host another page", async () => {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const runId = createId("run");
    const approval = pendingRequest({
      presentation: {
        detail: "Publish the release",
        kind: "choice",
        options: [{ hint: "confirm", id: "allow", label: "Publish" }],
        risk: "high",
        title: "Publish externally",
      },
      runId,
      threadId: thread.id,
      deploymentId: workspace.id,
    });
    const sockets: FakeSocket[] = [];
    const paths: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      paths.push(path);
      if (path === "/v1/rpc/thread.events.list") {
        return json({
          events: [],
          threadId: thread.id,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: 0,
            nextBefore: null,
            threadId: thread.id,
            totalItems: 0,
          },
        });
      }
      if (path === "/v1/rpc/thread.requests.list") {
        return json({
          requests: [],
          threadId: thread.id,
          window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
        });
      }
      if (path === "/v1/rpc/commands.dispatch") return json({}, 202);
      return json(bootstrap([workspace]));
    });
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ snapshot: deploymentSnapshot(workspace, "0"), type: "host.snapshot" });
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
          agentEvent(workspace.id, thread.id, runId, "2", "request.opened", { request: approval }),
          agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
            status: "waiting",
            inputQueuePaused: false,
            pendingRequests: 1,
          }),
        ],
        type: "host.events",
      }),
    );
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, runId, "4", "request.updated", {
            request: {
              ...approval,
              presentation: { ...approval.presentation, title: "Continue setup" },
            },
          }),
        ],
        type: "host.events",
      }),
    );
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    expect(client.getSnapshot().requests[thread.id]).toEqual([
      expect.objectContaining({
        id: approval.id,
        presentation: expect.objectContaining({ title: "Continue setup" }),
      }),
    ]);

    await client.dispatch({
      idempotencyKey: `request-${approval.id}:test`,
      requestId: approval.id,
      response: { kind: "choice", optionId: "allow" },
      type: "request.respond",
    });

    expect(client.getSnapshot().requests[thread.id]).toEqual([]);
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
    socket.receive(
      eventsFrame({
        events: [
          agentEvent(workspace.id, thread.id, null, "5", "thread.state-changed", {
            status: "running",
            inputQueuePaused: false,
            pendingRequests: 0,
          }),
        ],
        type: "host.events",
      }),
    );
    expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(0);

    // Only the Host's absolute state settles the count used for Request paging.
    paths.length = 0;
    client.activateThread(thread.id);
    await Promise.resolve();
    expect(paths).not.toContain("/v1/rpc/thread.requests.list");
    client.dispose();
  });

  it.each([
    { eventFirst: false, optionId: "installed" },
    { eventFirst: true, optionId: `server:${createIntegrationId("server")}` },
  ])(
    "keeps an integration access Request pending for intermediate choice $optionId",
    async ({ eventFirst, optionId }) => {
      const workspace = makeDeployment();
      const thread = makeThread(workspace.id);
      const runId = createId("run");
      const request = pendingIntegrationAccessRequest({
        optionId,
        runId,
        threadId: thread.id,
        deploymentId: workspace.id,
      });
      const updated = {
        ...request,
        payload: {
          ...request.payload,
          installationId: request.payload.installationId ?? createIntegrationId("installation"),
          manifest: null,
          requestedServerId: optionId.startsWith("server:")
            ? optionId.slice("server:".length)
            : createIntegrationId("server"),
        },
      } as typeof request;
      const sockets: FakeSocket[] = [];
      let releaseResponse!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace]));
        if (path === "/v1/rpc/commands.dispatch") {
          if (eventFirst) await responseGate;
          return json({}, 202);
        }
        throw new Error(`Unexpected request ${path}`);
      }) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        fetch,
        webSocketFactory: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      });
      await client.load();
      const socket = sockets[0]!;
      socket.open();
      socket.receive({ snapshot: deploymentSnapshot(workspace, "0"), type: "host.snapshot" });
      socket.receive(
        eventsFrame({
          events: [
            agentEvent(workspace.id, thread.id, null, "1", "thread.created", { thread }),
            agentEvent(workspace.id, thread.id, runId, "2", "request.opened", { request }),
            agentEvent(workspace.id, thread.id, null, "3", "thread.state-changed", {
              status: "waiting",
              inputQueuePaused: false,
              pendingRequests: 1,
            }),
          ],
          type: "host.events",
        }),
      );

      const responding = client.dispatch({
        idempotencyKey: `request-${request.id}:intermediate`,
        requestId: request.id,
        response: { kind: "choice", optionId },
        type: "request.respond",
      });
      if (eventFirst) {
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        socket.receive(
          eventsFrame({
            events: [
              agentEvent(workspace.id, thread.id, runId, "4", "request.updated", {
                request: updated,
              }),
            ],
            type: "host.events",
          }),
        );
        releaseResponse();
      }
      await responding;

      expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
      expect(client.getSnapshot().requests[thread.id]).toEqual([
        expect.objectContaining({ id: request.id, status: "pending" }),
      ]);
      if (!eventFirst) {
        socket.receive(
          eventsFrame({
            events: [
              agentEvent(workspace.id, thread.id, runId, "4", "request.updated", {
                request: updated,
              }),
            ],
            type: "host.events",
          }),
        );
        await vi.waitFor(() => {
          expect(client.getSnapshot().threads[0]?.pendingRequests).toBe(1);
          expect(client.getSnapshot().requests[thread.id]).toEqual([
            expect.objectContaining({
              id: request.id,
              payload: updated.payload,
              status: "pending",
            }),
          ]);
        });
      }
      expect(client.getSnapshot().transcripts[thread.id] ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "request" })]),
      );
      client.dispose();
    },
  );

  it("reads a created AI engine back from the Host instead of waiting for the refresh tick", async () => {
    const workspace = makeDeployment();
    const addedHarnessId = createId("harnessInstance");
    const paths: string[] = [];
    let created = false;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      paths.push(path);
      if (path === "/v1/rpc/commands.dispatch") {
        created = true;
        return json({
          harness: {
            config: {},
            driverKind: "claude",
            enabled: true,
            environmentId,
            id: addedHarnessId,
            isDefault: false,
            name: "Claude",
            runtimeRevision: 1,
            sourceId: "anthropic",
            stateKind: "isolated",
          },
        });
      }
      const payload = bootstrap([workspace]);
      return json(
        created
          ? {
              ...payload,
              harnesses: [
                ...payload.harnesses,
                {
                  config: {},
                  driverKind: "claude",
                  enabled: true,
                  environmentId,
                  id: addedHarnessId,
                  isDefault: false,
                  name: "Claude",
                  runtimeRevision: 1,
                  sourceId: "anthropic",
                  stateKind: "isolated" as const,
                },
              ],
            }
          : payload,
      );
    });
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();
    expect(client.getSnapshot().harnesses).toHaveLength(1);

    await client.dispatch({
      driverKind: "claude",
      environmentId,
      idempotencyKey: "harness-create:test",
      name: "Claude",
      sourceId: "anthropic",
      stateKind: "isolated",
      type: "harness.create",
    });

    await vi.waitFor(
      () =>
        expect(client.getSnapshot().harnesses).toEqual([
          expect.objectContaining({ id: harnessInstanceId }),
          expect.objectContaining({ id: addedHarnessId, name: "Claude" }),
        ]),
      { timeout: 1000 },
    );
    client.dispose();
  });

  it("refreshes after enable and delete mutations that can move a sibling default", async () => {
    const workspace = makeDeployment();
    const secondId = createId("harnessInstance");
    let phase: "initial" | "disabled" | "deleted" = "initial";
    let bootstrapReads = 0;
    const firstHarness = {
      config: {},
      driverKind: "codex",
      enabled: true,
      environmentId,
      id: harnessInstanceId,
      isDefault: true,
      name: "Codex",
      runtimeRevision: 1,
      sourceId: "openai",
      stateKind: "ambient" as const,
    };
    const secondHarness = {
      config: {},
      driverKind: "codex",
      enabled: true,
      environmentId,
      id: secondId,
      isDefault: false,
      name: "Codex Work",
      runtimeRevision: 1,
      sourceId: "openai",
      stateKind: "isolated" as const,
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/v1/rpc/commands.dispatch") {
        const command = asObject(JSON.parse(String(init?.body)));
        if (requiredString(command, "type") === "harness.enabled.set") {
          phase = "disabled";
          return json({ harness: { ...firstHarness, enabled: false, isDefault: false } });
        }
        phase = "deleted";
        return json({}, 202);
      }
      bootstrapReads += 1;
      const payload = bootstrap([workspace]);
      return json({
        ...payload,
        harnesses:
          phase === "initial"
            ? [{ ...firstHarness, enabled: true, isDefault: true }, secondHarness]
            : phase === "disabled"
              ? [
                  { ...firstHarness, enabled: false, isDefault: false },
                  { ...secondHarness, isDefault: true },
                ]
              : [{ ...firstHarness, enabled: false, isDefault: false }],
      });
    });
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    await client.dispatch({
      enabled: false,
      environmentId,
      harnessInstanceId,
      idempotencyKey: "harness-enabled:refresh",
      type: "harness.enabled.set",
    });
    expect(
      client.getSnapshot().harnesses.map(({ enabled, id, isDefault }) => ({
        enabled,
        id,
        isDefault,
      })),
    ).toEqual([
      { enabled: false, id: harnessInstanceId, isDefault: false },
      { enabled: true, id: secondId, isDefault: true },
    ]);

    await client.dispatch({
      environmentId,
      harnessInstanceId: secondId,
      idempotencyKey: "harness-delete:refresh",
      type: "harness.delete",
    });
    expect(client.getSnapshot().harnesses).toEqual([
      expect.objectContaining({ enabled: false, id: harnessInstanceId, isDefault: false }),
    ]);
    expect(bootstrapReads).toBe(3);
    client.dispose();
  });

  it("projects a renamed AI engine without carrying its driver configuration into the snapshot", async () => {
    const workspace = makeDeployment();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path !== "/v1/rpc/commands.dispatch") return json(bootstrap([workspace]));
      const command: unknown = JSON.parse(String(init?.body));
      expect(requiredString(asObject(command), "type")).toBe("harness.rename");
      return json({
        harness: {
          config: { apiKey: "do-not-retain" },
          driverKind: "codex",
          enabled: true,
          environmentId,
          id: harnessInstanceId,
          isDefault: true,
          name: "Codex Prime",
          runtimeRevision: 2,
          sourceId: "openai",
          stateKind: "ambient",
        },
      });
    });
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    await client.dispatch({
      environmentId,
      harnessInstanceId,
      idempotencyKey: "harness-rename:test",
      name: "Codex Prime",
      type: "harness.rename",
    });

    expect(client.getSnapshot().harnesses).toEqual([
      {
        driverKind: "codex",
        enabled: true,
        environmentId,
        id: harnessInstanceId,
        isDefault: true,
        name: "Codex Prime",
        runtimeRevision: 2,
        sourceId: "openai",
        stateKind: "ambient",
      },
    ]);
    expect(JSON.stringify(client.getSnapshot())).not.toContain("do-not-retain");
    client.dispose();
  });

  it("composes caller cancellation into the pending Host request", async () => {
    const workspace = makeDeployment();
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path !== "/v1/rpc/apps.view") return json(bootstrap([workspace]));
      signals.push(init?.signal);
      init?.signal?.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = createHttpHostClient({
      fetch,
      webSocketFactory: () => new FakeSocket(),
    });
    await client.load();

    const appId = `app_${crypto.randomUUID()}`;
    const pending = client.viewApp(appId, "light", controller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    const reason = new DOMException("Closed the app", "AbortError");
    const cancelled = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe(reason);
    await cancelled;
    await expect(client.viewApp(appId, "light", controller.signal)).rejects.toBe(reason);
    expect(signals).toHaveLength(1);
    client.dispose();
  });
});

function eventsThrough(events: readonly unknown[]): import("@opensteer/core").Sequence {
  let result = 0n;
  for (const event of events) {
    if (
      event &&
      typeof event === "object" &&
      "sequence" in event &&
      typeof event.sequence === "string" &&
      /^\d+$/.test(event.sequence)
    ) {
      const value = BigInt(event.sequence);
      if (value > result) result = value;
    }
  }
  return SequenceSchema.parse(String(result));
}

function eventsFrame(
  input: Omit<Extract<HostToClientMessage, { type: "host.events" }>, "throughSequence">,
): Extract<HostToClientMessage, { type: "host.events" }>;
function eventsFrame(input: {
  type: "host.events";
  events: readonly unknown[];
  readonly [key: string]: unknown;
}): {
  type: "host.events";
  events: readonly unknown[];
  throughSequence: import("@opensteer/core").Sequence;
};
function eventsFrame(input: {
  type: "host.events";
  events: readonly unknown[];
  readonly [key: string]: unknown;
}) {
  return { ...input, throughSequence: eventsThrough(input.events) };
}

it.each([60, 61])(
  "offers Device driver management only inside its served API window (%s)",
  async (apiVersion) => {
    const payload = { ...bootstrap([]), apiVersion };
    const client = createHttpHostClient({
      capabilities: ["device-drivers-v1"],
      fetch: async () => json(payload),
    });
    try {
      await client.load();
      expect(client.getSnapshot().deviceDriversAvailable).toBe(apiVersion >= 61);
    } finally {
      client.dispose();
    }
  },
);
