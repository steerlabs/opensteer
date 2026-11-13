import { MockPersonalHost } from "../mock/mock-personal-host.js";
interface PersonalFixture {
  readonly id: import("@opensteer/core").DeploymentId;
  readonly name: string;
}
import { PlaceActivityStore } from "./place-activity.js";
import * as lastPictures from "./browser-last-picture.js";
import { browserLineages } from "../test-support/browser-snapshot.js";
import { seedBrowserSession } from "../test-support/browser-snapshot.js";
import type { PersonalTabLineage } from "./client.js";
import type { PersonalStreamCheckpoint } from "./personal-stream-cache.js";
import { KeyedStreamPublisher, keyedStreamBytes } from "@opensteer/protocol/keyed-stream";
import {
  BrowserGroupRowSchema,
  BrowserTabRecordSchema,
  type HostedBrowserBootstrap as BrowserWireBootstrap,
} from "@opensteer/protocol/browser";
import {
  browserBootstrapWithRows,
  browserSessionFixture,
  type BrowserBootstrapFixture as HostedBrowserBootstrap,
} from "../test-support/browser-fixtures.js";
import { schedulesClient } from "./schedules.js";

import {
  BrowserTabGroupIdSchema,
  ModelSelectionSchema,
  SequenceSchema,
  ThreadAccessModeSchema,
  ThreadIdSchema,
  DeploymentIdSchema,
  createId,
  emptyExecutionPreferences,
  type AgentEventView as AgentEvent,
  type Message,
  type NotificationView,
  type Request as OpensteerRequest,
  type Thread,
} from "@opensteer/core";
import { apiVersionQueryParameter, hostApiVersion } from "@opensteer/deployment-authority";
import { createIntegrationId } from "@opensteer/integration-core";
import { sharedDisplayStreams } from "../integrations/phone-display-stream.js";
import {
  BrowserSurfaceIdSchema,
  ComputerViewSchema,
  HostToClientMessageSchema,
  createBrowserSessionId,
  placeIdentityKey,
  type HostToClientMessage,
  type RealtimeFrameDiagnostic,
} from "@opensteer/protocol";
import {
  BootstrapReadDiagnostics,
  bootstrapDiagnosticHeader,
} from "@opensteer/shared/bootstrapDiagnostics";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  PlaceProjection,
  isAppTabOpen,
  placeDestinationEnded,
  samePlaceListSource,
} from "./places.js";
import { sameStableHostSnapshot } from "./host-snapshot-selectors.js";

import { bootstrapReadDiagnostics } from "./bootstrap-diagnostics.js";
import { browserTabStrip } from "./browser-tab-strip.js";
import { HostClientRequestError, type ThreadSummary } from "./client.js";
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
import { placeList } from "./places.js";
import { visibleTranscript } from "./transcript.js";
import { conversationRows, groupTranscriptEntries } from "./agent-activity-model.js";

import { threadActivity, threadStopTarget } from "./thread-activity.js";

const now = "2026-08-09T20:00:00.000Z";
const ownerId = createId("user");
const runnerId = createId("runner");
const environmentId = createId("environment");
const harnessInstanceId = createId("harnessInstance");

it("opts control viewers into basic input and exposes only the returned negotiation", async () => {
  const workspace = makeDeployment();
  const sessionId = createBrowserSessionId();
  const surfaceId = BrowserSurfaceIdSchema.parse("phone-page");
  const session = seedBrowserSession(
    {
      id: sessionId,
      access: "read-write" as const,
      origin: "person" as const,
      state: "ready" as const,
      createdAt: now,
      updatedAt: now,
      deploymentId: workspace.id,
      profileId: null,
      runtimeId: "runtime",
      placement: { kind: "runner" as const, runnerId },
    },
    {
      generation: 1,
      revision: 1,
      rows: [
        {
          id: surfaceId,
          title: "Page",
          site: "https://example.test",
          iconRef: null,
          order: 0,
          openerId: null,
          availability: "ready" as const,
          documentId: null,
          occupants: [],
        },
      ],
    },
  );
  const sockets: { url: string; socket: FakeSocket }[] = [];
  const client = createHttpHostClient({
    capabilities: ["browser-target-control-v1"],
    refreshIntervalMs: 0,
    fetch: async () =>
      json(
        bootstrap([workspace], {
          available: true,
          placements: [],
          profiles: [],

          sessions: [session],
        }),
      ),
    webSocketFactory: (url) => {
      const socket = new FakeSocket();
      sockets.push({ url, socket });
      return socket;
    },
  });
  try {
    await client.load();
    const release = client.retainBrowserViewer(sessionId, surfaceId, { picture: false });
    const control = sockets.find(({ url }) => url.includes("/browser-sessions/"))!;
    expect(new URL(control.url).searchParams.get(apiVersionQueryParameter)).toBe(
      String(hostApiVersion),
    );
    expect(new URL(control.url).searchParams.get("basicInput")).toBe("1");
    const target = client.browserFrames.editing!.target(sessionId, surfaceId);
    expect(target.get().input).toBe("none");
    control.socket.open();
    control.socket.receiveRaw({
      type: "browser.snapshot",
      sessionId,
      access: "read-write",
      state: "ready",
      targetedStreamingVersion: 1,
      basicInput: 1,
      dialog: null,
      surfaces: [{ id: surfaceId, title: "Page", url: "https://example.test", active: true }],
    });
    expect(target.get().input).toBe("basic");
    expect(client.browserViewerState(sessionId, surfaceId).input).toBe("basic");
    await target.send({ kind: "command", command: "selectAll" });
    expect(parseSent(control.socket, control.socket.sent.length - 1)).toMatchObject({
      type: "input.command",
      command: "selectAll",
    });
    const releaseWatch = client.retainBrowserWatch(sessionId, surfaceId);
    const watch = sockets.find(({ url }) => new URL(url).searchParams.get("mode") === "watch")!;
    expect(new URL(watch.url).searchParams.get(apiVersionQueryParameter)).toBe(
      String(hostApiVersion),
    );
    expect(new URL(watch.url).searchParams.has("basicInput")).toBe(false);
    releaseWatch();
    release();
    expect(target.get().input).toBe("none");
  } finally {
    client.dispose();
  }
});

it.each([64, 500])(
  "measures %s tabs through the real Host publisher and one Deployment socket",
  async (count) => {
    const workspaces = [makeDeployment(), makeDeployment(), makeDeployment()];
    const counts = count === 64 ? [64] : [64, 62, 62, 62, 62, 62, 62, 64];
    const groups = counts.map((tabCount, _index) => {
      const id = createBrowserSessionId();
      return BrowserGroupRowSchema.parse({
        id,
        sessionId: id,
        createdAt: now,
        sessionCreatedAt: now,
        updatedAt: now,

        state: "ready",
        origin: "person",
        access: "read-write",
        placement: { kind: "runner", runnerId },
        profileId: null,
        runtimeId: "browser-runtime-integration",
        opener: { kind: "you" },
        navigation: false,
        unavailableReason: null,
        inventoryRevision: 1,
        acting: false,
        page: { title: "Page 0", url: "https://measure.example" },
        attachedRunIds: [],
        threadIds: [],
        tabCount,
      });
    });
    const live = new Map(
      groups.map((group, index) => [
        group.id,
        {
          groupId: group.id,
          inventoryRevision: 1,
          navigation: false,
          ready: true,
          acting: false,
          page: group.page,
          iconRef: () => null,
          records: new Map(
            Array.from({ length: group.tabCount }, (_, order) => {
              const row = BrowserTabRecordSchema.parse({
                id: `measure_${index}_${order}`,
                title: `Page ${order}`,
                order,
                openerId: null,
                url: `https://measure.example/private/${index}/${order}?secret=never-on-client`,
                icon: null,
                documentId: `doc_${index}_${order}`,
                geometryRevision: 1,
                state: "live",
                loading: false,
                navigationFailed: false,
                canGoBack: false,
                canGoForward: false,
                sizedByAgent: false,
              });
              return [row.id, row];
            }),
          ),
        },
      ]),
    );
    const errors: unknown[] = [];
    const ports = {
      authorityGeneration: () => 0,
      groupIds: async () => groups.map((group) => group.id),
      readGroups: async (_user: typeof ownerId, ids: readonly (typeof groups)[number]["id"][]) =>
        groups.filter((group) => ids.includes(group.id)),
      readTabs: async () => [],
      groupId: async (id: (typeof groups)[number]["id"]) => id,
      live: (id: (typeof groups)[number]["id"]) => live.get(id),
      occupants: () => [],
      onError: (error: unknown) => {
        errors.push(error);
      },
    };
    // Loading by path keeps this cross-package fixture outside the browser-only library build.
    const modulePath = "../../../../apps/host/src/browser/browser-client-streams.ts";
    const { BrowserClientStreams } = (await import(modulePath)) as {
      BrowserClientStreams: new (rowPorts: typeof ports) => {
        source: {
          bootstrap(
            user: typeof ownerId,
          ): Promise<Pick<BrowserWireBootstrap, "groups" | "tabs" | "continuation">>;
          markTabs(sessionId: (typeof groups)[number]["id"], ids: Iterable<string>): void;
        };
        attach(
          user: typeof ownerId,
          transport: {
            bufferedAmount(): number;
            send(message: HostToClientMessage): Promise<void>;
          },
          continuation?: string,
        ): Promise<{ close(): void; resync(): void }>;
        close(): void;
      };
    };
    const publisher = new BrowserClientStreams(ports);
    const prefix = await publisher.source.bootstrap(ownerId);
    const body = bootstrap(workspaces, {
      available: true,
      placements: [],
      profiles: [],

      ...prefix,
    });
    const sockets: FakeSocket[] = [];
    const incoming: HostToClientMessage[][] = [];
    const attachments: { close(): void }[] = [];
    const fetch = vi.fn(async () => json(body));
    const client = createHttpHostClient({
      fetch,

      refreshIntervalMs: 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        const messages: HostToClientMessage[] = [];
        incoming.push(messages);
        sockets.push(socket);
        let attachment: Awaited<ReturnType<typeof publisher.attach>> | undefined;
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          send(data);
          const message = JSON.parse(data) as { type: string; continuation?: string };
          if (message.type !== "client.browser.resync") return;
          if (attachment) attachment.resync();
          else
            void publisher
              .attach(
                ownerId,
                {
                  bufferedAmount: () => 0,
                  send: async (frame) => {
                    messages.push(frame);
                    socket.receive(frame);
                  },
                },
                message.continuation,
              )
              .then((connection) => {
                attachment = connection;
                attachments.push(connection);
              });
        };
        const close = socket.close.bind(socket);
        socket.close = (code, reason) => {
          attachment?.close();
          close(code, reason);
        };
        return socket;
      },
    });
    const total = () =>
      incoming.flat().reduce((sum, message) => sum + keyedStreamBytes(message), 0);
    const ended = (index: number) =>
      incoming[index]!.filter(
        (message) => message.type === "host.browser-tabs" && message.stream.op === "end",
      ).length;
    try {
      await client.load();
      for (const socket of sockets) socket.open();
      await vi.waitFor(() => expect(ended(0)).toBe(groups.length));
      expect(sockets).toHaveLength(1);
      expect(incoming.slice(1)).toEqual([]);
      expect(
        client
          .getSnapshot()
          .browserSessions.flatMap(
            (session) => session.browserTabs?.sessionTabs(session?.id) ?? [],
          ),
      ).toHaveLength(count);
      expect(browserLineages(client.getSnapshot())?.every((group) => group.whole)).toBe(true);
      expect([
        ...prefix.groups.rows,
        ...incoming[0]!.flatMap((message) =>
          message.type === "host.browser-groups" && message.stream.op === "rows"
            ? message.stream.rows
            : [],
        ),
      ]).toHaveLength(groups.length);
      const deliveredTabs = [
        ...prefix.tabs.flatMap((group) => group.rows),
        ...incoming[0]!.flatMap((message) =>
          message.type === "host.browser-tabs" && message.stream.op === "rows"
            ? message.stream.rows
            : [],
        ),
      ];
      expect(deliveredTabs).toHaveLength(count);
      expect(new Set(deliveredTabs.map((row) => row.id)).size).toBe(count);
      const prefixBytes = keyedStreamBytes(prefix);
      const browserSection = keyedStreamBytes(body.browser);
      const snapshotBytes = total();
      const bytesUntilWhole =
        browserSection +
        (prefix.groups.complete && prefix.tabs.every((group) => group.complete)
          ? 0
          : snapshotBytes);
      const before = total();
      const records = live.get(groups[0]!.id)!.records;
      const changed = [...records.values()][1]!;
      records.set(changed.id, { ...changed, title: `Changed at ${count}` });
      publisher.source.markTabs(groups[0]!.id, [changed.id]);
      await vi.waitFor(() =>
        expect(
          client
            .getSnapshot()
            .browserSessions.flatMap(
              (session) => session.browserTabs?.sessionTabs(session?.id) ?? [],
            )
            .find((tab) => tab.id === changed.id)?.title,
        ).toBe(`Changed at ${count}`),
      );
      const titleBytes = total() - before;
      expect(incoming[0]!.at(-1)).toMatchObject({
        type: "host.browser-tabs",
        stream: { op: "change", update: [{ id: changed.id, title: `Changed at ${count}` }] },
      });
      expect(incoming.slice(1)).toEqual([]);
      const beforeHandover = total();
      const readsBeforeHandover = fetch.mock.calls.length;
      vi.useFakeTimers();
      sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(10);
      sockets[1]!.open();
      await vi.waitFor(() => expect(ended(1)).toBe(groups.length));
      const handoverBytes = total() - beforeHandover;
      expect(
        sockets
          .slice(0, 2)
          .map(
            (socket) =>
              socket.sent.filter((data) => JSON.parse(data).type === "client.browser.resync")
                .length,
          ),
      ).toEqual([1, 1]);
      expect(fetch).toHaveBeenCalledTimes(readsBeforeHandover);
      expect(JSON.stringify(incoming)).not.toContain("never-on-client");
      expect(body.browser).not.toHaveProperty("sessions");
      expect(body.browser).not.toHaveProperty("personalTabs");
      expect(errors).toEqual([]);
      await writeRealtimeEvidence(
        {
          tabs: count,
          groups: groups.length,
          browserSection,
          prefixBytes,
          snapshotBytes,
          bytesUntilWhole,
          titleBytes,
          handoverBytes,
        },
        `browser-bytes-${count}.json`,
      );
    } finally {
      client.dispose();
      for (const attachment of attachments) attachment.close();
      publisher.close();
    }
  },
);

describe("browser carrier and derivation", () => {
  it("derives changed rows while sharing every other row and group", async () => {
    const f = await fixture();
    try {
      const group = replace(f, f.sockets[0]!, "tabs");
      const before = f.client.getSnapshot();
      const first = before.browserSessions.find((session) => session.id === group.groupId)!;
      const other = before.browserSessions.find((session) => session.id !== group.groupId)!;
      const firstRows = f.client.browserTabs.sessionTabs(first.id);
      const otherGroup = f.client.browserTabs.group(other.id);
      const otherRows = f.client.browserTabs.sessionTabs(other.id);
      f.sockets[0]!.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: {
          op: "change",
          generation: "tabs",
          base: 0,
          revision: 1,
          update: [{ id: group.rows[0]!.id, title: "Changed" }],
        },
      });
      const after = f.client.getSnapshot();
      expect(f.client.browserTabs.sessionTab(first.id, group.rows[0]!.id)?.title).toBe("Changed");
      expect(f.client.browserTabs.sessionTabs(first.id)[0]).not.toBe(firstRows[0]);
      expect(f.client.browserTabs.sessionTabs(first.id)[1]).toBe(firstRows[1]);
      expect(after.browserSessions.find((session) => session.id === other.id)).toBe(other);
      expect(f.client.browserTabs.group(other.id)).toBe(otherGroup);
      expect(f.client.browserTabs.sessionTabs(other.id)).toBe(otherRows);
    } finally {
      f.client.dispose();
    }
  });

  async function fixture(prefix = false) {
    const workspaces = [makeDeployment(), makeDeployment(), makeDeployment()];
    const sessions = workspaces.slice(0, 2).map((workspace, index) =>
      seedBrowserSession(
        {
          id: createBrowserSessionId(),
          access: "read-write" as const,
          origin: "person" as const,
          state: "ready" as const,
          createdAt: now,
          updatedAt: now,
          deploymentId: workspace.id,
          profileId: null,
          runtimeId: "runtime",
          placement: { kind: "runner" as const, runnerId },
        },
        {
          generation: 1,
          revision: 1,
          rows: [0, 1].map((order) => ({
            id: BrowserSurfaceIdSchema.parse(`carrier-${index}-${order}`),
            title: `Tab ${order}`,
            site: "https://example.test",
            iconRef: null,
            order,
            openerId: null,
            availability: "ready" as const,
            documentId: "document",
            occupants: [],
          })),
        },
      ),
    );
    sessions.sort((a, b) => a.id.localeCompare(b.id));
    const body = bootstrap(workspaces, {
      available: true,
      placements: [],
      profiles: [],

      sessions,
    });
    if (prefix) body.browser.tabs![0]!.complete = false;
    const sockets: FakeSocket[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const payload = rpcPayload(url, init);
      if (url.pathname.endsWith("/commands.dispatch") && payload.type === "browser.tab.close")
        return json({
          sessionId: payload.sessionId,
          outcome: "tab-closed",
        });
      return json(body);
    });
    const client = createHttpHostClient({
      fetch,

      refreshIntervalMs: 0,
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    for (const socket of sockets) socket.open();
    return { client, sockets, fetch, body, sessions };
  }
  function resyncs(socket: FakeSocket) {
    return socket.sent
      .map((value) => JSON.parse(value) as { type: string; groupId?: string })
      .filter((value) => value.type === "client.browser.resync");
  }
  function replace(f: Awaited<ReturnType<typeof fixture>>, socket: FakeSocket, generation: string) {
    const group = f.body.browser.tabs![0]!;
    for (const message of [
      { op: "begin", generation },
      { op: "rows", rows: group.rows },
      { op: "end", revision: 0, count: group.rows.length, meta: {} },
    ])
      socket.receiveRaw({ type: "host.browser-tabs", groupId: group.groupId, stream: message });
    return group;
  }
  it.each(["control", "watch"] as const)(
    "keeps %s viewer metadata on its held target, including a known prefix row",
    async (mode) => {
      const f = await fixture(true);
      try {
        const sessionId = f.sessions[0]!.id;
        const [own, sibling] = f.body.browser.tabs![0]!.rows;
        const retain =
          mode === "control" ? f.client.retainBrowserViewer : f.client.retainBrowserWatch;
        let release = retain(sessionId, own!.id);
        const socket = f.sockets[1]!;
        expect(socket, "known prefix target must open a viewer").toBeDefined();
        socket.open();
        socket.receiveRaw({
          type: "browser.snapshot",
          sessionId,
          state: "ready",
          access: "read-write",
          dialog: null,
          targetedStreamingVersion: 1,
          surfaces: [],
        });
        const surface = {
          id: own!.id,
          title: "Own title",
          url: "https://example.test/private",
          state: "live",
          documentId: "document",
          geometryRevision: 1,
          loading: false,
          navigationFailed: false,
          sizedByAgent: false,
          favicon: "data:image/png;base64,AA==",
        };
        const beforeSurface = f.client.getSnapshot().browserSessions;
        const notified = vi.fn();
        const stop = f.client.subscribe(notified);
        socket.receiveRaw({ type: "browser.surface", surfaceId: own!.id, surface });
        expect(notified).toHaveBeenCalledTimes(1);
        expect(f.client.getSnapshot().browserSessions).toBe(beforeSurface);
        stop();
        const session = () =>
          f.client.getSnapshot().browserSessions.find((s) => s.id === sessionId)!;
        expect(f.client.browserViewerSurface(sessionId, own!.id)).toMatchObject({
          title: surface.title,
          url: surface.url,
          favicon: surface.favicon,
        });
        expect(f.client.browserViewerSurface(sessionId, sibling!.id)).toBeUndefined();
        socket.receiveRaw({ type: "browser.surface", surfaceId: own!.id, surface: null });
        expect(f.client.browserViewerSurface(sessionId, own!.id)).toBeUndefined();
        expect(session().state).toBe("ready");
        socket.receiveRaw({ type: "browser.surface", surfaceId: own!.id, surface });
        release();
        expect(f.client.browserViewerSurface(sessionId, own!.id)).toBeUndefined();
        socket.receiveRaw({ type: "browser.surface", surfaceId: own!.id, surface });
        expect(f.client.browserViewerSurface(sessionId, own!.id)?.url).toBeUndefined();
        release = retain(sessionId, own!.id);
        const next = f.sockets[2]!;
        next.open();
        next.receiveRaw({
          type: "browser.snapshot",
          sessionId,
          state: "ready",
          access: "read-write",
          dialog: null,
          targetedStreamingVersion: 1,
          surfaces: [],
        });
        next.receiveRaw({ type: "browser.surface", surfaceId: own!.id, surface });
        next.serverClose(4003, "Browser access ended");
        expect(f.client.browserViewerSurface(sessionId, own!.id)?.url).toBeUndefined();
        next.receiveRaw({ type: "browser.surface", surfaceId: own!.id, surface });
        expect(f.client.browserViewerSurface(sessionId, own!.id)?.url).toBeUndefined();
        expect(session().state).toBe("ready");
        release();
      } finally {
        f.client.dispose();
      }
    },
  );

  it.each(["envelope", "record"] as const)(
    "refuses mismatched %s viewer metadata",
    async (mismatch) => {
      const f = await fixture();
      try {
        const sessionId = f.sessions[0]!.id;
        const [own, sibling] = f.body.browser.tabs![0]!.rows;
        const release = f.client.retainBrowserViewer(sessionId, own!.id);
        const socket = f.sockets[1]!;
        socket.open();
        socket.receiveRaw({
          type: "browser.snapshot",
          sessionId,
          state: "ready",
          access: "read-write",
          dialog: null,
          targetedStreamingVersion: 1,
          surfaces: [],
        });
        socket.receiveRaw({
          type: "browser.surface",
          surfaceId: mismatch === "envelope" ? sibling!.id : own!.id,
          surface: {
            id: sibling!.id,
            title: "Secret",
            url: "https://sibling.test/private",
            state: "live",
            documentId: "document",
            geometryRevision: 1,
            loading: false,
            navigationFailed: false,
            sizedByAgent: false,
            favicon: null,
          },
        });
        expect(socket.readyState).toBe(3);
        expect(f.client.browserViewerSurface(sessionId, own!.id)).toBeUndefined();
        expect(f.client.browserViewerSurface(sessionId, sibling!.id)).toBeUndefined();
        expect(f.client.browserViewerState(sessionId, own!.id).error).toMatch(/match/);
        release();
      } finally {
        f.client.dispose();
      }
    },
  );

  it("keeps an interrupted snapshot and fences revocation before its late end", async () => {
    const f = await fixture();
    try {
      const carrier = f.sockets[0]!;
      const group = replace(f, carrier, "committed");
      const held = f.client.browserTabs.sessionTabs(group.groupId);
      carrier.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: { op: "begin", generation: "interrupted" },
      });
      carrier.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: { op: "rows", rows: [{ ...group.rows[0]!, title: "Uncommitted" }] },
      });
      vi.useFakeTimers();
      carrier.serverClose();
      await vi.advanceTimersByTimeAsync(10);
      f.sockets[1]!.open();
      const next = f.sockets[1]!;
      expect(f.client.browserTabs.sessionTabs(group.groupId)).toBe(held);
      next.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: { op: "end", count: 1, revision: 0, meta: {} },
      });
      expect(f.client.browserTabs.sessionTabs(group.groupId)).toBe(held);
      publishBrowser(next, { sessions: f.sessions });
      next.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: { op: "begin", generation: "revoked" },
      });
      next.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: { op: "rows", rows: group.rows },
      });
      publishBrowser(next, { sessions: [f.sessions[1]!] });
      next.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: { op: "end", count: group.rows.length, revision: 0, meta: {} },
      });
      expect(
        f.client.getSnapshot().browserSessions.some((session) => session.id === group.groupId),
      ).toBe(false);
      expect(browserLineages(f.client.getSnapshot())?.some((row) => row.id === group.groupId)).toBe(
        false,
      );
    } finally {
      f.client.dispose();
    }
  });
  it("keeps an incomplete prefix visible until its first complete stream", async () => {
    const f = await fixture();
    try {
      // A new viewer's incomplete seed is independent of the first client's carrier.
      const body = f.body;
      body.browser.groups = { ...body.browser.groups!, complete: false };
      body.browser.tabs = body.browser.tabs!.map((group) => ({
        ...group,
        rows: group.rows.slice(0, 1),
        complete: false,
      }));
      const socket = new FakeSocket();
      const client = createHttpHostClient({
        fetch: async () => json(body),
        refreshIntervalMs: 0,
        webSocketFactory: () => socket,
      });
      try {
        await client.load();
        expect(
          client
            .getSnapshot()
            .browserSessions.every(
              (session) => session.browserTabs?.sessionList(session.id).whole === false,
            ),
        ).toBe(true);
        expect(
          browserLineages(client.getSnapshot())!.every(
            (group) => group.whole === false && group.tabs?.length === 1,
          ),
        ).toBe(true);
        const reading = client.readPersonalTabs(f.sessions[0]!.id);
        let settled = false;
        void reading
          .then(() => {
            settled = true;
          })
          .catch(() => undefined);
        socket.open();
        expect(settled).toBe(false);
        expect(
          placeDestinationEnded(client.getSnapshot(), {
            kind: "browser",
            sessionId: f.sessions[0]!.id,
            tabId: (f.sessions[0]!.browserTabs?.sessionTabs(f.sessions[0]!.id) ?? [])[1]!.id,
          }),
        ).toBe(false);
        expect(resyncs(socket)).toHaveLength(1);
        expect(f.sockets.map(resyncs)).toEqual([[{ type: "client.browser.resync" }]]);
        publishBrowser(socket, { sessions: f.sessions });
        expect((await reading)?.tabs).toHaveLength(2);
        expect(
          browserLineages(client.getSnapshot())!.every(
            (group) => group.whole === true && group.tabs?.length === 2,
          ),
        ).toBe(true);
        expect(
          client
            .getSnapshot()
            .browserSessions.every(
              (session) => (session.browserTabs?.sessionTabs(session?.id) ?? []).length === 2,
            ),
        ).toBe(true);
      } finally {
        client.dispose();
      }
    } finally {
      f.client.dispose();
    }
  });
  it("closes live rows with the displayed inventory fence after a newer inventory arrives", async () => {
    const f = await fixture();
    try {
      const session = f.client
        .getSnapshot()
        .browserSessions.find((session) => session.id === f.sessions[0]!.id)!;
      const expected = session.browserTabs!.inventory(session?.id)!;
      publishBrowser(f.sockets[0]!, {
        sessions: f.sessions.map((session) =>
          seedBrowserSession(
            { ...session },
            { ...session.browserTabs!.inventory(session?.id), revision: 2 },
          ),
        ),
      });
      await f.client.closeBrowserTab(
        session.id,
        session.browserTabs!.sessionTabs(session.id)[0]!.id,
        expected,
      );
      const command = f.fetch.mock.calls
        .map(([input, init]) => rpcPayload(new URL(input.toString()), init))
        .find((payload) => payload.type === "browser.tab.close");
      expect(command).toMatchObject({
        type: "browser.tab.close",
        sessionId: session.id,
        surfaceId: session.browserTabs!.sessionTabs(session.id)[0]!.id,
        inventoryRevision: 1,
      });
    } finally {
      f.client.dispose();
    }
  });
  it("repairs gaps and unreadable browser frames on the carrier without rereading bootstrap", async () => {
    const f = await fixture();
    try {
      const group = replace(f, f.sockets[0]!, "tabs");
      const before = f.client.getSnapshot().browserSessions;
      const reads = f.fetch.mock.calls.length;
      f.sockets[0]!.receiveRaw({
        type: "host.browser-tabs",
        groupId: group.groupId,
        stream: { op: "change", generation: "tabs", base: 1, revision: 2 },
      });
      expect(resyncs(f.sockets[0]!)).toEqual([
        { type: "client.browser.resync" },
        { type: "client.browser.resync", groupId: group.groupId },
      ]);
      expect(f.client.getSnapshot().browserSessions).toBe(before);
      f.sockets[0]!.receiveRaw({ type: "host.browser-tabs", stream: {} });
      expect(resyncs(f.sockets[0]!).at(-1)).toEqual({ type: "client.browser.resync" });
      expect(resyncs(f.sockets[0]!)).toHaveLength(3);
      expect(f.fetch).toHaveBeenCalledTimes(reads);
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
  const realtime: FakeSocket[] = [];
  return new HttpHostClient({
    baseUrl: "http://127.0.0.1",
    ...options,
    webSocketFactory: (url) => {
      const socket = options.webSocketFactory?.(url) ?? new FakeSocket();
      if (url.includes("/v1/realtime") && socket instanceof FakeSocket) realtime.push(socket);
      return socket;
    },
    ...(options.fetch
      ? {
          fetch: rpcContractFetch(
            options.fetch,
            timeZoneReports,
            browserUsageReads,
            taskReads,
            realtime,
          ),
        }
      : {}),
  });
}

function rpcContractFetch(
  fetch: typeof globalThis.fetch,
  timeZoneReports: "answered" | "observed",
  browserUsageReads: "answered" | "observed",
  taskReads: "answered" | "observed",
  realtime: FakeSocket[],
): typeof globalThis.fetch {
  const startedSessions = new WeakMap<FakeSocket, ReturnType<typeof browserSessionFixture>>();
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
    if (name === "commands.dispatch" && payload.type === "browser.session.close") {
      const socket = realtime[0]!;
      const current = startedSessions.get(socket);
      if (current)
        publishBrowser(socket, {
          sessions: [
            seedBrowserSession(
              { ...current, state: "closed" },
              { generation: 1, revision: 2, rows: [] },
            ),
          ],
        });
    }
    if (name === "commands.dispatch" && payload.type === "browser.session.start") {
      const session = browserSessionFixture(body.session as object);
      const socket = realtime[0]!;
      startedSessions.set(socket, session);
      if (socket.readyState !== 1) socket.open();
      publishBrowser(socket, {
        sessions: [
          seedBrowserSession(
            { ...session },
            {
              generation: 1,
              revision: 1,
              rows: [
                {
                  id: BrowserSurfaceIdSchema.parse("page-1"),
                  title: "Example",
                  site: "https://example.com",
                  iconRef: null,
                  order: 0,
                  openerId: null,
                  availability: "ready",
                  documentId: "document",
                  occupants: [],
                },
              ],
            },
          ),
        ],
      });
    }
    if (name === "bootstrap.get") {
      const id = stringValue(data, "deploymentId");
      if (id)
        bootstrapFixtures.set(id, {
          browser: objectValue(data, "browser") as BrowserWireBootstrap,
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
      refreshIntervalMs: 0,
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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await client.load();
    expect(client.getSnapshot().session).toBe("authentication-required");

    await client.rpc["auth.setup.exchange"]({ token: setupToken });
    await client.rpc["auth.setup.claim"]({ email: "alex@example.com", kind: "password", password });
    await client.refresh();

    expect(client.getSnapshot()).toMatchObject({
      connection: "connecting",
      ownerName: "Alex",
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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

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

  it("resolves a selected group outside the prefix from the carrier and keeps it through stale bootstrap", async () => {
    const workspace = makeDeployment();
    const seed = new MockHostClient({ latencyMs: 0 });
    const group = browserLineages(seed.getSnapshot())!.find((group) => group.tabs?.length)!;
    seed.dispose();
    const socket = new FakeSocket();
    const fetch = vi.fn(async () => json(bootstrap([workspace])));
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
    });
    try {
      await client.load();
      socket.open();
      expect(await client.readPersonalTabs(group.session.id)).toBeNull();
      publishBrowser(socket, { lineages: [group] });
      const received = await client.readPersonalTabs(group.session.id);
      expect(received?.tabs?.map((tab) => tab.id)).toEqual(group.tabs!.map((tab) => tab.id));
      await client.refresh();
      expect(await client.readPersonalTabs(group.session.id)).toBe(received);
    } finally {
      client.dispose();
    }
  });
  // Failure mode: a pending move materializes the old tab set, so a lineage read
  // inserts its new tab beside the moved opener instead of replaying the move.
  it("replays a pending move with tabs learned before the layout acknowledgement", async () => {
    const workspace = makeDeployment();
    const sessionId = createBrowserSessionId();
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) =>
      BrowserSurfaceIdSchema.parse(`surface_pending_${id}`),
    );
    const lineage: PersonalTabLineage = {
      id: sessionId,
      revision: 1,
      createdAt: now,
      session: {
        id: sessionId,
        access: "read-write",
        createdAt: now,
        updatedAt: now,
        origin: "person",
        placement: { kind: "runner", runnerId },
        profileId: null,
        runtimeId: "test",
        state: "failed",
      },
      tabs: [a!, b!, c!].map((id, order) => ({
        kind: "browser",
        id,
        sessionId,
        title: id,
        site: "",
        order,
        openerId: null,
        state: "suspended",
        createdAt: now,
      })),
    };
    const browser: HostedBrowserBootstrap = {
      available: true,
      tabRestoreVersion: 1,
      lineages: [lineage],
      tabGroupsVersion: 1,
      tabGroups: { revision: 1, groups: [], order: [] },
      profiles: [],
      placements: [],

      sessions: [],
    };
    const newer: PersonalTabLineage = {
      ...lineage,
      revision: 2,
      tabs: [
        ...lineage.tabs!,
        {
          kind: "browser",
          id: d!,
          sessionId,
          title: "New child",
          site: "",
          order: 3,
          openerId: c!,
          state: "suspended",
          createdAt: now,
        },
      ],
    };
    let commandStarted = false;
    let acknowledge: (response: Response) => void = () => {
      throw new Error("No pending command");
    };
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/commands.dispatch")
          return new Promise<Response>((resolve) => {
            acknowledge = resolve;
            commandStarted = true;
          });
        return json(bootstrap([workspace], browser));
      },
    });
    let pending: Promise<void> | undefined;
    try {
      await client.load();
      pending = client.moveBrowserTabs({
        item: { tabIds: [c!] },
        to: { groupId: null, before: { tabId: a! } },
      });
      await vi.waitFor(() => expect(commandStarted).toBe(true));
      socket.open();
      publishBrowser(socket, { lineages: [newer] });
      const snapshot = client.getSnapshot();
      expect(
        browserTabStrip(placeList(snapshot), snapshot.browserTabGroups)
          .ordered.filter((p) => p.kind === "browser")
          .map((p) => p.personalTab!.id),
      ).toEqual([c, a, b, d]);
    } finally {
      acknowledge(
        json({
          type: "workspace.tabs.move",
          layout: { revision: 2, order: [c, a, b, d], groups: [] },
        }),
      );
      await pending;
      client.dispose();
    }
  });
  // Failure modes: a delayed command restores a closed member at the refresh's revision;
  // rejecting equal-revision refreshes instead leaves visibility changes stale.
  it("keeps an equal-revision refresh when an older command acknowledgement arrives later", async () => {
    const workspace = makeDeployment();
    const a = BrowserSurfaceIdSchema.parse("surface_delayed-a");
    const b = BrowserSurfaceIdSchema.parse("surface_delayed-b");
    const group = {
      id: BrowserTabGroupIdSchema.parse(`btg_${crypto.randomUUID()}`),
      title: "Reading",
      color: "blue" as const,
      collapsed: false,
      tabIds: [a, b],
    };
    const browser: HostedBrowserBootstrap = {
      available: true,
      profiles: [],
      placements: [],

      sessions: [],
      tabGroupsVersion: 1,
      tabGroups: { revision: 1, groups: [group] },
    };
    let acknowledge: (response: Response) => void = () => {
      throw new Error("No pending command");
    };
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path === "/v1/rpc/commands.dispatch")
          return new Promise<Response>((resolve) => {
            acknowledge = resolve;
          });
        return json(bootstrap([workspace], browser));
      },
    });
    try {
      await client.load();
      const pending = client.updateBrowserTabGroup(group.id, { title: "Renamed" });
      await vi.waitFor(() =>
        expect(client.getSnapshot().browserTabGroups?.groups[0]?.title).toBe("Renamed"),
      );
      const committed = { revision: 2, groups: [{ ...group, title: "Renamed" }] };
      browser.tabGroups = { revision: 2, groups: [{ ...committed.groups[0]!, tabIds: [b] }] };
      await client.refresh();
      expect(client.getSnapshot().browserTabGroups?.groups[0]?.tabIds).toEqual([b]);
      acknowledge(json({ type: "workspace.tabGroup.update", layout: committed }));
      await pending;
      expect(client.getSnapshot().browserTabGroups?.groups[0]?.tabIds).toEqual([b]);
      browser.tabGroups = { revision: 2, groups: [] };
      await client.refresh();
      expect(client.getSnapshot().browserTabGroups?.groups).toEqual([]);
    } finally {
      client.dispose();
    }
  });
  // Failure modes: a batch close invents a live catalog revision, changes unrelated
  // lineages, or requests a redundant bootstrap instead of using the Host notice.
  it("batch close updates only durable membership and leaves catalog reconciliation to Host notices", async () => {
    const workspace = makeDeployment();
    const sessionId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("surface_batch-close");
    const lineage: PersonalTabLineage = {
      id: sessionId,
      revision: 1,
      createdAt: now,
      session: {
        id: sessionId,
        access: "read-write",
        createdAt: now,
        updatedAt: now,
        origin: "person",
        placement: { kind: "runner", runnerId },
        profileId: null,
        runtimeId: "test",
        state: "failed",
      },
      tabs: [
        {
          kind: "browser",
          id: tabId,
          sessionId,
          title: "Closing",
          site: "https://example.test",
          order: 0,
          openerId: null,
          state: "suspended",
        },
      ],
    };
    const browser: HostedBrowserBootstrap = {
      available: true,
      tabRestoreVersion: 1,
      lineages: [lineage],
      profiles: [],
      placements: [],

      sessions: [],
    };
    const calls: string[] = [];
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      webSocketFactory: () => socket,
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        calls.push(path);
        if (path === "/v1/rpc/commands.dispatch")
          return json({ type: "workspace.tabs.close", closed: [tabId], failed: [] });
        return json(bootstrap([workspace], browser));
      },
    });
    try {
      await client.load();
      const before = client.getSnapshot();
      const groupsBefore = client.browserTabs.groups();
      const rowsBefore = client.browserTabs.sessionTabs(lineage.session.id);
      expect(await client.closePersonalTabs([tabId])).toMatchObject({
        closed: [tabId],
        failed: [],
      });
      expect(client.getSnapshot().browserSessions).toBe(before.browserSessions);
      expect(client.browserTabs.groups()).toBe(groupsBefore);
      expect(client.browserTabs.sessionTabs(lineage.session.id)).toBe(rowsBefore);
      socket.open();
      publishBrowser(socket, { lineages: [{ ...lineage, tabs: [] }] });
      expect(browserLineages(client.getSnapshot())?.[0]?.tabs).toEqual([]);
      expect(calls.filter((path) => path === "/v1/rpc/bootstrap.get")).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });

  it("sends the execution tuple it was given and remembers it once the Host accepts", async () => {
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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });

    await expect(
      client.rpc["harness.authentication.get"]({ environmentId, harnessInstanceId }),
    ).resolves.toMatchObject({ ok: false });
    client.dispose();
  });
});

describe("HttpHostClient durable realtime", () => {
  it("routes viewer-wide history notices to the history cache", async () => {
    const workspace = makeDeployment();
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
          sessions: [],
        }),
      );
    };
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
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
          refreshIntervalMs: 0,
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

  describe("browser catalog churn", () => {
    async function fixture(withGroup = true) {
      const workspace = makeDeployment();
      const sessionId = createBrowserSessionId();
      const group: PersonalTabLineage = {
        id: sessionId,
        revision: 1,
        createdAt: now,
        session: seedBrowserSession(
          {
            access: "read-write",
            createdAt: now,
            updatedAt: now,
            id: sessionId,
            origin: "person",
            placement: { kind: "runner", runnerId },
            profileId: null,
            runtimeId: "runtime-1",
            state: "ready",
            deploymentId: workspace.id,
            tabRestoreVersion: 1,
          },
          { generation: 1, revision: 1, rows: [] },
        ),
        tabs: [
          {
            kind: "browser",
            id: BrowserSurfaceIdSchema.parse("surface_notice"),
            sessionId,
            title: "Store",
            site: "https://store.example/",
            order: 0,
            openerId: null,
            state: "suspended",
          },
        ],
      };
      const body = bootstrap([workspace], {
        available: true,
        tabRestoreVersion: 1,
        lineages: withGroup ? [group] : [],
        sessions: [group.session],
        placements: [],
        profiles: [],

        tabGroupsVersion: 1,
        tabGroups: { revision: 1, groups: [], order: [] },
      });
      const mock = new MockHostClient({ latencyMs: 0 });
      const machines = mock.getSnapshot().machines;
      mock.dispose();
      const socket = new FakeSocket();
      const fetch = vi.fn(async () => json({ ...body, machines }));
      const client = createHttpHostClient({
        fetch,
        refreshIntervalMs: 0,

        webSocketFactory: () => socket,
      });
      await client.load();
      socket.open();
      socket.receive({
        type: "host.snapshot",
        snapshot: { ...deploymentSnapshot(workspace, "0"), threads: [makeThread(workspace.id)] },
      });
      return { body, client, fetch, group, socket, workspace };
    }

    it("does constant client reconciliation for a single title among 10,000 tabs", async () => {
      const f = await fixture();
      try {
        const store = f.client.browserTabs;
        const groupId = store.groups().ids[0]!;
        const row = store.sessionTabs(f.group.session.id)[0]!;
        const rows = Array.from({ length: 10_000 }, (_, i) => ({
          ...row,
          id: BrowserSurfaceIdSchema.parse(`large-${i}`),
          order: i,
          openerId: null,
        }));
        store.applyTabs(groupId, { op: "begin", generation: "large" });
        store.applyTabs(groupId, { op: "rows", rows });
        store.applyTabs(groupId, { op: "end", revision: 0, count: rows.length, meta: {} });
        const visit = vi.spyOn(PlaceProjection.prototype, "place");
        const activity = vi.spyOn(PlaceActivityStore.prototype, "reconcile");
        const pictures = vi.spyOn(lastPictures, "reconcileBrowserLastPictures");
        const read = vi.spyOn(store, "tab");
        const sessions = f.client.getSnapshot().browserSessions;
        try {
          store.applyTabs(groupId, {
            op: "change",
            generation: "large",
            base: 0,
            revision: 1,
            update: [{ id: rows[0]!.id, title: "Fresh title" }],
          });
          expect(f.client.getSnapshot().browserSessions).toBe(sessions);
          expect(visit).not.toHaveBeenCalled();
          expect(activity).not.toHaveBeenCalled();
          expect(pictures).not.toHaveBeenCalled();
          expect(read.mock.calls.length).toBeLessThan(10);
        } finally {
          visit.mockRestore();
          activity.mockRestore();
          pictures.mockRestore();
          read.mockRestore();
        }
      } finally {
        f.client.dispose();
      }
    });

    it("keeps stream state through stale bootstrap", async () => {
      const f = await fixture();
      try {
        const tabId = f.group.tabs![0]!.id;
        f.body.browser.tabGroups = {
          revision: 2,
          order: [tabId],
          groups: [
            {
              id: createId("browserTabGroup"),
              title: "Reading",
              color: "blue",
              collapsed: false,
              tabIds: [tabId],
            },
          ],
        };
        await f.client.refresh();
        const current = { ...f.group, tabs: [{ ...f.group.tabs![0]!, title: "Checkout" }] };
        publishBrowser(f.socket, { lineages: [current] });
        const before = f.client.getSnapshot();
        const groupsBefore = f.client.browserTabs.groups();
        const rowsBefore = f.client.browserTabs.sessionTabs(current.session.id);
        expect(f.client.getSnapshot()).toBe(before);
        await f.client.refresh();
        expect(f.client.browserTabs.groups()).toBe(groupsBefore);
        expect(f.client.browserTabs.sessionTabs(current.session.id)).toBe(rowsBefore);
        expect(placeList(f.client.getSnapshot()).map((place) => place.title)).toContain("Checkout");
        publishBrowser(f.socket, { lineages: [{ ...current, tabs: [] }] });
        expect(f.client.getSnapshot().browserTabGroups?.groups).toEqual([]);
        expect(f.client.getSnapshot().browserTabGroups?.order).toEqual([]);
        await f.client.refresh();
        expect(browserLineages(f.client.getSnapshot())?.[0]?.tabs).toEqual([]);
      } finally {
        f.client.dispose();
      }
    });

    it("shares unchanged bootstrap records and propagates a changed field", async () => {
      const f = await fixture();
      try {
        // Align the Thread's derived labels with bootstrap before measuring a reread.
        await f.client.load();
        const before = f.client.getSnapshot();
        expect(before.threads).toHaveLength(1);
        expect(before.machines.length).toBeGreaterThan(0);
        await f.client.load();
        const after = f.client.getSnapshot();
        expect(sameStableHostSnapshot(before, after)).toBe(true);
        expect(samePlaceListSource(before, after)).toBe(true);
        for (const key of [
          "threads",

          "browserSessions",
          "browserTabs",
          "environments",
          "harnesses",
          "machines",
        ] as const) {
          expect(after[key]).toBe(before[key]);
          if (key !== "browserTabs") expect(after[key]![0]).toBe(before[key]![0]);
        }
        f.body.environments[0]!.name = "Renamed computer";
        await f.client.load();
        const changed = f.client.getSnapshot();
        expect(changed.environments[0]!.name).toBe("Renamed computer");
        expect(changed.environments[0]).not.toBe(after.environments[0]);
        expect(changed.browserSessions[0]).toBe(after.browserSessions[0]);
        expect(sameStableHostSnapshot(after, changed)).toBe(false);
      } finally {
        f.client.dispose();
      }
    });
  });

  it.each([
    "host.browser-sessions-changed",
    "host.app-tabs-changed",
    "host.machines.changed",
  ] as const)(
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
            sessions: [],
          }),
        ),
      ) as unknown as typeof globalThis.fetch;
      const client = createHttpHostClient({
        fetch,
        refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
                  sessions: [],
                }),
              ),
            ),
          );
        }),
    ) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
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
    const sessionId = createBrowserSessionId();
    const now = new Date().toISOString();
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
            profiles: [],
            sessions:
              reads > 1
                ? [
                    {
                      access: "read-write" as const,
                      createdAt: now,
                      id: sessionId,
                      origin: "agent" as const,
                      placement: { kind: "runner" as const, runnerId },
                      profileId: null,
                      runtimeId: "runtime-1",
                      state: "ready" as const,
                      updatedAt: now,
                    },
                  ]
                : [],
          }),
        );
      },
      lifecycle: platform.lifecycle,
      refreshIntervalMs: 0,
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

    platform.enterBackground();
    sockets[0]!.receive({ type: "host.browser-sessions-changed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nobody is looking, so nothing is fetched for them.
    expect(reads).toBe(1);
    expect(client.getSnapshot().browserSessions).toEqual([]);

    // The return already rereads; the notice needs nothing of its own.
    platform.enterForeground();
    await vi.waitUntil(() => client.getSnapshot().browserSessions.length === 1);
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
        fields: [{ id: "choice", multiSelect: false, prompt: "Which option?", secret: false }],
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });
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
      refreshIntervalMs: 0,
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
    const client = createHttpHostClient({ fetch, refreshIntervalMs: 0 });
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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

  it("queues a follow-up through HTTP and interrupts only the executing Run", async () => {
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
      refreshIntervalMs: 0,
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
            threadId: thread.id,
            runOrdinal: 0,
          },
        ],
        threads: [{ ...thread, status: "running" }],
      },
      type: "host.snapshot",
    });

    await client.dispatch({
      content: [{ text: "Follow up next", type: "text" }],
      idempotencyKey: "message:test",
      threadId: thread.id,
      type: "thread.sendMessage",
    });
    await client.stopRun(thread.id);

    expect(client.getSnapshot().runQueue.map(({ id, status }) => [id, status])).toEqual([
      [currentRunId, "running"],
      [queuedRunId, "queued"],
    ]);
    expect(requestedTypes).toEqual(["thread.sendMessage", "run.interrupt"]);
    client.dispose();
  });

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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
        canMove: true,
        canSteer: true,
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
async function queueHost() {
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
        if (gate) await gate;
        return json({
          items: state.items,
          paused: state.paused,
          steerRunId: state.steerRunId,
          threadId: thread.id,
        });
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
    refreshIntervalMs: 0,
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

function queueItem(message: Message, canSteer: boolean) {
  return { canCancel: true, canMove: true, canSteer, input: pendingInput(message), message };
}

describe("HttpHostClient hosted browser", () => {
  it.each(["profile", "workspace"] as const)(
    "revokes %s pixels from the catalog before authorization close, even after transport release",
    async (reason) => {
      const workspace = makeDeployment(),
        sessionId = createBrowserSessionId(),
        profileId = createId("browserProfile");
      const browser: HostedBrowserBootstrap = {
        available: true,
        placements: [],
        profiles: [{ homeRunnerId: null, id: profileId, name: "Profile" }],

        sessions: [
          seedBrowserSession(
            {
              id: sessionId,
              deploymentId: workspace.id,
              profileId,
              placement: { kind: "runner", runnerId },
              runtimeId: "runtime",
              origin: "person",
              state: "ready",
              access: "read-write",
              createdAt: now,
              updatedAt: now,
            },
            {
              generation: 1,
              revision: 1,
              rows: [
                {
                  id: BrowserSurfaceIdSchema.parse("page-1"),
                  title: "Page",
                  site: "https://example.com",
                  iconRef: null,
                  order: 0,
                  openerId: null,
                  availability: "ready",
                  occupants: [],
                  documentId: null,
                },
              ],
            },
          ),
        ],
      };
      const boot = bootstrap([workspace], browser);
      const sockets: { url: string; socket: FakeSocket }[] = [];
      const client = createHttpHostClient({
        refreshIntervalMs: 0,

        fetch: async () => json(boot),
        webSocketFactory: (url) => {
          const socket = new FakeSocket();
          sockets.push({ url, socket });
          return socket;
        },
      });
      try {
        await client.load();
        const notify = vi.fn();
        const unsubscribe = client.browserWatchFrames.subscribe(sessionId, notify, "page-1");
        const release = client.retainBrowserWatch(sessionId, "page-1");
        const socket = sockets.find(({ url }) => url.includes("/browser-sessions/"))!.socket;
        socket.open();
        socket.receiveRaw({
          type: "browser.snapshot",
          sessionId,
          state: "ready",
          access: "read-write",
          targetedStreamingVersion: 1,
          dialog: null,
          surfaces: [{ id: "page-1", active: true, title: "Page", url: "https://example.com" }],
        });
        socket.receiveBinary(browserFrame(1));
        expect(client.browserWatchFrames.get(sessionId, "page-1")).not.toBeNull();
        const before = client.browserWatchFrames.invalidationKey!(sessionId, "page-1");
        // The presenter remains subscribed while its offscreen card releases transport.
        release();
        notify.mockClear();
        if (reason === "profile") {
          browser.profiles = [];
          const workspaceSocket = sockets.find(
            ({ url }) => !url.includes("/browser-sessions/"),
          )!.socket;
          workspaceSocket.open();
          publishBrowser(workspaceSocket, { sessions: [] });
        }
        if (reason === "workspace") {
          const workspaceSocket = sockets.find(
            ({ url }) => !url.includes("/browser-sessions/"),
          )!.socket;
          workspaceSocket.open();
          workspaceSocket.receiveRaw({
            type: "host.error",
            error: {
              code: "forbidden",
              message: "Access ended",
              reason: "deployment-forbidden",
              retryable: false,
            },
          });
        } else await client.refresh();
        expect(client.browserWatchFrames.invalidationKey!(sessionId, "page-1")).not.toBe(before);
        expect(notify).toHaveBeenCalled();
        expect(
          client.getSnapshot().browserSessions.some((session) => session.id === sessionId),
        ).toBe(false);
        unsubscribe();
      } finally {
        client.dispose();
      }
    },
  );

  it("reconciles retained Watch targets when the carrier learns a tab", async () => {
    const workspace = makeDeployment();
    const sessionId = createBrowserSessionId();
    const tabId = BrowserSurfaceIdSchema.parse("surface_http-outage");
    const browser: HostedBrowserBootstrap = {
      available: true,
      placements: [],
      profiles: [],

      sessions: [],
    };
    const connections: string[] = [];
    const realtime = new FakeSocket();
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace], browser)),
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        connections.push(url);
        return url.includes("/v1/realtime") ? realtime : new FakeSocket();
      },
    });
    try {
      await client.load();
      expect(client.getSnapshot().session).toBe("authenticated");
      const release = client.retainBrowserWatch(sessionId, tabId);
      expect(connections.some((url) => url.includes("/browser-sessions/"))).toBe(false);
      browser.sessions = [
        seedBrowserSession(
          {
            id: sessionId,
            access: "read-write",
            origin: "person",
            state: "ready",
            createdAt: now,
            updatedAt: now,
            deploymentId: workspace.id,
            profileId: null,
            runtimeId: "runtime-1",
            placement: { kind: "runner", runnerId },
          },
          {
            generation: 1,
            revision: 1,
            rows: [
              {
                id: tabId,
                title: "HTTP-discovered tab",
                site: "https://example.test",
                iconRef: null,
                order: 0,
                openerId: null,
                availability: "ready",
                documentId: null,
                occupants: [],
              },
            ],
          },
        ),
      ];
      realtime.open();
      publishBrowser(realtime, browser);
      expect(client.getSnapshot().connection).not.toBe("connected");
      expect(connections.filter((url) => url.includes("/browser-sessions/"))).toHaveLength(1);
      release();
    } finally {
      client.dispose();
    }
  });

  it("keeps hot Runtime frames outside the global snapshot and sends explicit commands", async () => {
    const workspace = makeDeployment();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    const browser: HostedBrowserBootstrap = {
      available: true,
      placements: [
        {
          available: true,
          environmentIds: [],
          kind: "runner",
          label: "Main Host",
          runnerId: runnerId,
          runtimeId: "runtime-1",
        },
      ],
      profiles: [{ homeRunnerId: null, id: profileId, name: "Default browser" }],
      sessions: [],
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/rpc/bootstrap.get") return json(bootstrap([workspace], browser));
      if (path === "/v1/rpc/commands.dispatch") {
        return json(
          {
            session: {
              access: "read-write",
              createdAt: now,
              id: sessionId,
              origin: "person",
              placement: { kind: "runner", runnerId: runnerId },
              profileId,
              runtimeId: "runtime-1",
              state: "ready",
              updatedAt: now,
              deploymentId: workspace.id,
            },
            wasExisting: false,
          },
          201,
        );
      }
      throw new Error(`Unexpected request ${path}`);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      viewerPlatform: "mac",
      random: () => 0,
      reconnectBaseDelayMs: 5,
      reconnectMaxDelayMs: 5,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    await client.load();
    expect(client.getSnapshot().browserAvailable).toBe(true);

    await client.startBrowser(workspace.id, { kind: "profile", profileId });
    expect(sockets.some(({ url }) => url.includes("/browser-sessions/"))).toBe(false);
    const releaseViewer = client.retainBrowserViewer(sessionId, "page-1");
    const releaseSecondViewer = client.retainBrowserViewer(sessionId, "page-1");
    const browserSocket = sockets.find(({ url }) => url.includes("/browser-sessions/"))?.socket;
    expect(browserSocket).toBeDefined();
    expect(browserSocket?.binaryType).toBe("arraybuffer");
    browserSocket?.open();
    browserSocket?.receiveRaw({
      access: "read-write",
      dialog: {
        id: "00000000-0000-4000-8000-0000000000d1",
        message: "Continue?",
        surfaceId: "page-1",
        type: "confirm",
      },
      sessionId,
      state: "ready",
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "https://example.com/",
        },
      ],
      targetedStreamingVersion: 1,
      basicInput: 1,
      type: "browser.snapshot",
    });
    browserSocket!.receiveRaw({
      type: "browser.surface",
      surfaceId: "page-1",
      surface: {
        id: "page-1",
        title: "Example",
        url: "https://example.com/",
        state: "live",
        documentId: "document-page-1",
        geometryRevision: 1,
        loading: false,
        navigationFailed: false,
        sizedByAgent: false,
        favicon: null,
      },
    });
    const target = client.browserFrames.editing!.target(sessionId, "page-1");
    await target.send({ kind: "command", command: "selectAll" });
    expect(parseSent(browserSocket!, browserSocket!.sent.length - 1)).toMatchObject({
      type: "input.command",
      command: "selectAll",
      surfaceId: "page-1",
    });
    const snapshotBeforeFrame = client.getSnapshot();
    const snapshotListener = vi.fn();
    const frameListener = vi.fn();
    const unsubscribeSnapshot = client.subscribe(snapshotListener);
    const unsubscribeFrame = client.browserFrames.subscribe(sessionId, frameListener, "page-1");
    browserSocket?.receiveBinary(browserFrame(9));

    expect(client.getSnapshot()).toBe(snapshotBeforeFrame);
    expect(snapshotListener).not.toHaveBeenCalled();
    expect(frameListener).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      id: sessionId,
      state: "ready",
      viewerState: "disconnected",
    });
    expect(client.browserViewerSurface(sessionId, "page-1")).toMatchObject({
      title: "Example",
      url: "https://example.com/",
    });
    expect(client.browserFrames.get(sessionId, "page-1")?.header.frameId).toBe(9);

    client.sendBrowserCommand(sessionId, {
      type: "navigation.reload",
      surfaceId: BrowserSurfaceIdSchema.parse("page-1"),
    });
    expect(JSON.parse(browserSocket?.sent.at(-1) ?? "{}")).toEqual({
      type: "navigation.reload",
      surfaceId: "page-1",
      inputGeneration: 0,
      inputSequence: expect.any(Number),
    });
    client.sendBrowserCommand(sessionId, {
      surfaceId: BrowserSurfaceIdSchema.parse("page-1"),
      accept: true,
      dialogId: "00000000-0000-4000-8000-0000000000d1",
      type: "dialog.respond",
    });
    expect(client.getSnapshot().browserSessions[0]?.dialog).toMatchObject({
      message: "Continue?",
    });
    browserSocket?.receiveRaw({
      dialog: null,
      surfaceId: "page-1",
      type: "browser.dialog.changed",
    });
    expect(client.getSnapshot().browserSessions[0]?.dialog).toBeNull();
    releaseViewer();
    expect(browserSocket?.readyState).toBe(1);
    browserSocket?.close();
    expect(() =>
      client.sendBrowserCommand(sessionId, { type: "stream.unsubscribe" }),
    ).not.toThrow();
    // A streamed view resets its cursor around the moments it holds no tab.
    expect(() =>
      client.sendBrowserCommand(sessionId, {
        surfaceId: BrowserSurfaceIdSchema.parse("surface_released"),
        type: "cursor.reset",
      }),
    ).not.toThrow();
    expect(() => client.sendBrowserCommand(sessionId, { type: "navigation.reload" })).toThrow(
      "The browser view is not synchronized.",
    );
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      state: "ready",
      viewerState: "disconnected",
    });
    releaseSecondViewer();

    expect(sockets.filter(({ url }) => url.includes("/browser-sessions/"))).toHaveLength(1);
    client.dispose();
    expect(client.browserFrames.get(sessionId, "page-1")).toBeNull();
    unsubscribeFrame();
    unsubscribeSnapshot();
  });

  it("closes viewer transport when the durable Host session becomes terminal", async () => {
    const workspace = makeDeployment();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    let bootstrapReads = 0;
    const client = createHttpHostClient({
      fetch: async () => {
        bootstrapReads += 1;
        return json(
          bootstrap([workspace], {
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId: runnerId,
                runtimeId: "runtime-1",
              },
            ],

            profiles: [{ homeRunnerId: null, id: profileId, name: "Default browser" }],
            sessions: [
              seedBrowserSession(
                {
                  access: "read-write",
                  createdAt: now,
                  id: sessionId,
                  origin: "person",
                  placement: { kind: "runner", runnerId: runnerId },
                  profileId,
                  runtimeId: "runtime-1",
                  state: bootstrapReads === 1 ? "ready" : "failed",
                  updatedAt: bootstrapReads === 1 ? now : "2026-08-09T20:00:01.000Z",
                  deploymentId: workspace.id,
                },
                {
                  generation: 1,
                  revision: 1,
                  rows: [
                    {
                      id: BrowserSurfaceIdSchema.parse("page-1"),
                      title: "Example",
                      site: "https://example.com",
                      iconRef: null,
                      order: 0,
                      openerId: null,
                      availability: "ready",
                      documentId: "document",
                      occupants: [],
                    },
                  ],
                },
              ),
            ],
          }),
        );
      },
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    await client.load();
    const release = client.retainBrowserViewer(sessionId, "page-1");
    const socket = sockets.find(({ url }) => url.includes("/browser-sessions/"))?.socket;
    socket?.open();
    socket?.receiveRaw({
      access: "read-write",
      dialog: {
        id: "00000000-0000-4000-8000-0000000000d1",
        message: "Continue?",
        surfaceId: "page-1",
        type: "confirm",
      },
      sessionId,
      state: "ready",
      surfaces: [
        {
          active: true,
          id: "page-1",
          title: "Example",
          url: "https://example.com/",
        },
      ],
      targetedStreamingVersion: 1,
      basicInput: 1,
      type: "browser.snapshot",
    });
    expect(client.browserViewerState(sessionId, "page-1")).toMatchObject({ admitted: true });

    await client.refresh();
    const realtime = sockets.find(({ url }) => url.includes("/v1/realtime"))!.socket;
    realtime.open();
    publishBrowser(realtime, {
      sessions: [
        {
          ...browserLineages(client.getSnapshot())![0]!.session,
          state: "failed",
          updatedAt: "2026-08-09T20:00:01.000Z",
        },
      ],
    });
    expect(socket?.closeEvents).toContainEqual({ code: 1000, reason: "Target released" });
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      dialog: null,
      state: "failed",
      viewerError: null,
      viewerState: "disconnected",
    });
    release();
    client.dispose();
  });
});

describe("HttpHostClient browser profiles", () => {
  it("keeps pending erasure from delete receipts and bootstrap until completion, including older Hosts", async () => {
    const profileId = createId("browserProfile");
    const computerId = createId("runner");
    const deletion = { profileId, computerId, state: "pending-computer" as const };
    let browser: HostedBrowserBootstrap = {
      available: false,
      placements: [],
      profiles: [{ homeRunnerId: null, id: profileId, name: "Work" }],

      sessions: [],
    };
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
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
  it("uses cached evidence on periodic refresh and reverifies after a Host restart", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const sockets: FakeSocket[] = [];
    const capabilities = vi.fn(async () => ["thread-titles-v1"] as const);
    const client = createHttpHostClient({
      capabilities,
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 15_000,
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
      expect(capabilities).toHaveBeenCalledTimes(2);
      expect(capabilities).not.toHaveBeenCalledWith({ revalidate: true });
      sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(10);
      expect(capabilities).toHaveBeenCalledWith({ revalidate: true });
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().threadRenameAvailable).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("reverifies discovery on refresh while a periodic bootstrap is still running", async () => {
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
      refreshIntervalMs: 15_000,
      webSocketFactory: () => new FakeSocket(),
    });
    try {
      await client.load();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(held).not.toBeNull();
      const refreshed = client.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(capabilities).toHaveBeenCalledWith({ revalidate: true });
      held!.resolve(json(bootstrap([workspace])));
      await refreshed;
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
        refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
  it("stops polling and stops burning reconnect backoff while backgrounded", async () => {
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
      refreshIntervalMs: 1_000,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await client.load();
    sockets[0]?.open();
    await vi.advanceTimersByTimeAsync(2_500);
    const polledWhileVisible = bootstrapCalls;
    expect(polledWhileVisible).toBeGreaterThan(1);

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
      refreshIntervalMs: 1_000,
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
        readonly refreshIntervalMs?: number;
      } = {},
    ) {
      vi.useFakeTimers();
      const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
      const sockets: FakeSocket[] = [];
      const client = createHttpHostClient({
        fetch: options.fetch ?? (async () => json(bootstrap(workspaces))),
        lifecycle: platform.lifecycle,
        refreshIntervalMs: options.refreshIntervalMs ?? 0,
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
      host.platform.changeNetwork("online", "same");
      await vi.advanceTimersByTimeAsync(realtimeIdleProbeDeadlineMs);

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
      expect(host.label()).toBe("Reconnecting…");

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
      expect(host.client.getSnapshot().connectionInterrupted).toBe(true);

      host.platform.enterBackground();
      host.platform.enterForeground();

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
        refreshIntervalMs: 15_000,
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
      expect(labels).toEqual(new Set(["Unavailable"]));

      // A new network is worth hoping for, with the pill already up.
      host.platform.changeNetwork("online");
      expect(host.label()).toBe("Reconnecting…");

      up = true;
      const retried = host.client.refresh({ retryConnection: true });
      expect(host.label()).toBe("Reconnecting…");
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
    expect(dead.closeEvents).toEqual([{ code: 1000, reason: "Liveness probe unanswered" }]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    expect(parseSent(sockets[1]!, 0)).toMatchObject({
      cursor: { deploymentId: workspace.id, afterSequence: "7", apiVersion: hostApiVersion },

      type: "client.subscribe",
    });
    client.dispose();
  });

  it("keeps a probed channel whose subscription delivers before the answer does", async () => {
    vi.useFakeTimers();
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      realtimeLiveness: { deadlineMs: 1_000, idleMs: 1_000 },
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
    expect(socket.closeEvents).toEqual([{ code: 1000, reason: "Liveness probe unanswered" }]);
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
    const view = await mock.openComputerView(app.machineId, app.target);
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
      commandRows: true,
      commandReplies: 0,
      bootstrap: async (): Promise<Response> =>
        json({ ...bootstrap([workspace]), machines: machines() }),
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
            /^(computer\.view|browser\.tab)\./u.test(payload.type)
          ) {
            commands.push(payload);
            const socket = sockets[0];
            if (payload.type === "browser.tab.open" && socket?.readyState === 0) socket.open();
            const response = await answer(payload);
            host.commandReplies++;
            const fixture = asObject(await response.clone().json());
            const { sourceCatalog, ...result } = fixture;
            if (
              host.commandRows &&
              payload.type === "browser.tab.open" &&
              response.ok &&
              socket?.readyState === 1
            ) {
              if (result.session) {
                const session = browserSessionFixture(result.session);
                publishBrowser(socket, {
                  sessions: [
                    seedBrowserSession(
                      { ...session },
                      sourceCatalog as NonNullable<Parameters<typeof seedBrowserSession>[1]>,
                    ),
                  ],
                });
              }
            }
            return json(result, response.status);
          }
        }
        return host.bootstrap();
      },
      refreshIntervalMs: 0,
      webSocketFactory: () => {
        const socket = new FakeSocket();
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
  async function browserOpenWorld() {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      const session = mock.getSnapshot().browserSessions.find((value) => value.state === "ready")!;
      const result = await mock.openBrowserTab(session.id, {
        url: "https://pending.example/",
        idempotencyKey: "fixture-open",
      });
      return {
        ...result,
        sourceCatalog: {
          ...mock.browserTabs.inventory(result.sessionId)!,
          rows: mock.browserTabs.sessionTabs(result.sessionId),
        },
      };
    } finally {
      mock.dispose();
    }
  }

  it("opens authoritative tabs before loading presentation scope without publishing pending rows", async () => {
    const opened = await browserOpenWorld();
    const host = ownerViewHost(
      () => [],
      async () => json(opened),
    );
    try {
      const target = { identity: { kind: "guest" as const } };
      const options = { url: "https://pending.example/", idempotencyKey: "before-load" };
      const opening = host.client.openBrowserTab(target, options);
      expect(host.client.getSnapshot().pendingBrowserTabs ?? []).toEqual([]);
      const { sourceCatalog: _catalog, ...receipt } = opened;
      await expect(opening).resolves.toEqual(receipt);
      expect(host.commands).toEqual([{ type: "browser.tab.open", ...target, ...options }]);
      expect(host.client.getSnapshot().pendingBrowserTabs ?? []).toEqual([]);
      expect(host.sockets).toEqual([]);
      await host.client.load();
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
    } finally {
      host.client.dispose();
    }
  });

  it("publishes a pending browser row synchronously before dispatch and joins the same key", async () => {
    const opened = await browserOpenWorld();
    const gate = deferred<void>();
    const host = ownerViewHost(
      () => [],
      async () => {
        expect(host.client.getSnapshot().pendingBrowserTabs).toMatchObject([
          { idempotencyKey: "instant", state: "opening", url: "https://pending.example/" },
        ]);
        await withTimeout(gate.promise, 2_000, {
          timeoutError: () => new Error("The delayed browser command was never released."),
        });
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const handle = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        {
          url: "https://pending.example/",
          idempotencyKey: "instant",
        },
      );
      expect(host.client.getSnapshot().pendingBrowserTabs).toHaveLength(1);
      const joined = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        {
          url: "https://pending.example/",
          idempotencyKey: "instant",
        },
      );
      expect(joined.result).toBe(handle.result);
      gate.resolve();
      await handle.result;
      expect(host.commands).toHaveLength(1);
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
    } finally {
      gate.resolve();
      host.client.dispose();
    }
  });

  it("retains an uncertain open and retries only its original command key and payload", async () => {
    const opened = await browserOpenWorld();
    let uncertain = true;
    const host = ownerViewHost(
      () => [],
      async () => {
        if (uncertain) throw new TypeError("Connection lost");
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const target = { identity: { kind: "guest" as const } };
      const options = {
        url: "https://pending.example/",
        viewport: { width: 700, height: 500 },
        idempotencyKey: "uncertain",
      };
      await expect(host.client.beginBrowserTabOpen(target, options).result).rejects.toThrow();
      expect(host.client.getSnapshot().pendingBrowserTabs).toMatchObject([
        { idempotencyKey: "uncertain", state: "unknown" },
      ]);
      uncertain = false;
      await host.client.beginBrowserTabOpen(target, {
        url: options.url,
        idempotencyKey: options.idempotencyKey,
      }).result;
      expect(host.commands).toHaveLength(2);
      expect(host.commands[1]).toEqual(host.commands[0]);
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
    } finally {
      host.client.dispose();
    }
  });

  it("keeps a Host's explicit unknown-outcome conflict on the original key", async () => {
    const host = ownerViewHost(
      () => [],
      async () =>
        json(
          {
            error: {
              code: "conflict",
              reason: "browser-tab-open-outcome-unknown",
              message: "The original page outcome is unknown.",
            },
          },
          409,
        ),
    );
    try {
      await host.client.load();
      const target = { identity: { kind: "guest" as const } };
      const options = { idempotencyKey: "host-unknown" };
      await expect(host.client.beginBrowserTabOpen(target, options).result).rejects.toMatchObject({
        reason: "browser-tab-open-outcome-unknown",
      });
      expect(host.client.getSnapshot().pendingBrowserTabs).toMatchObject([
        { idempotencyKey: "host-unknown", state: "unknown" },
      ]);
      await expect(host.client.beginBrowserTabOpen(target, options).result).rejects.toThrow();
      expect(host.commands[1]).toEqual(host.commands[0]);
    } finally {
      host.client.dispose();
    }
  });

  it.each(["inventory-first", "response-first"])(
    "merges a pending result once with %s inventory",
    async (order) => {
      const opened = await browserOpenWorld();
      const gate = deferred<void>();
      const host = ownerViewHost(
        () => [],
        async () => {
          await withTimeout(gate.promise, 2_000, {
            timeoutError: () => new Error("The delayed browser command was never released."),
          });
          return json(opened);
        },
      );
      try {
        host.host.commandRows = false;
        await host.client.load();
        const socket = host.connect();
        const handle = host.client.beginBrowserTabOpen(
          { identity: { kind: "guest" } },
          { idempotencyKey: "merge" },
        );
        const inventory = async () => {
          publishBrowser(socket, {
            sessions: [
              seedBrowserSession(
                { ...opened.session },
                {
                  ...opened.sourceCatalog,
                  revision: opened.sourceCatalog.revision + 1,
                  inventoryRevision:
                    (opened.sourceCatalog.inventoryRevision ?? opened.sourceCatalog.revision) + 1,
                },
              ),
            ],
          });
        };
        if (order === "inventory-first") await inventory();
        gate.resolve();
        if (order === "response-first") {
          await vi.waitFor(() => expect(host.host.commandReplies).toBe(1));
          expect(host.client.getSnapshot().pendingBrowserTabs).toHaveLength(1);
          await inventory();
        }
        await handle.result;
        expect(
          host.client
            .getSnapshot()
            .browserSessions.filter((value) => value.id === opened.sessionId),
        ).toHaveLength(1);
        expect(host.client.browserTabs.inventory(opened.sessionId)?.revision).toBe(
          opened.sourceCatalog.revision + 1,
        );
        expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
      } finally {
        gate.resolve();
        host.client.dispose();
      }
    },
  );

  it("dismisses an opening immediately and closes only its exact late result", async () => {
    const opened = await browserOpenWorld();
    const gate = deferred<void>();
    const host = ownerViewHost(
      () => [],
      async (command) => {
        if (command.type === "browser.tab.close")
          return json({
            sessionId: opened.sessionId,
            outcome: "tab-closed",
            sourceCatalog: opened.sourceCatalog,
          });
        await withTimeout(gate.promise, 2_000, {
          timeoutError: () => new Error("The delayed browser command was never released."),
        });
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const closed = deferred<void>();
      const originalClose = host.client.closeBrowserTab.bind(host.client);
      const close = vi.spyOn(host.client, "closeBrowserTab").mockImplementation(async (...args) => {
        const result = await originalClose(...args);
        closed.resolve();
        return result;
      });
      const handle = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        { idempotencyKey: "dismiss" },
      );
      const cancelled = expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
      host.client.dismissPendingBrowserTab(handle.idempotencyKey);
      expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
      await cancelled;
      gate.resolve();
      await withTimeout(closed.promise, 2_000, {
        timeoutError: () => new Error("The exact late tab was never closed."),
      });
      expect(close).toHaveBeenCalledExactlyOnceWith(
        opened.sessionId,
        opened.tabId,
        expect.objectContaining({ inventoryRevision: opened.sourceCatalog.inventoryRevision }),
      );
    } finally {
      gate.resolve();
      host.client.dispose();
    }
  });

  it.each(["sign-out", "person", "deployment"])(
    "forgets pending browser authority on %s and refuses a late result",
    async (change) => {
      const opened = await browserOpenWorld();
      const gate = deferred<void>();
      const host = ownerViewHost(
        () => [],
        async () => {
          await withTimeout(gate.promise, 2_000, {
            timeoutError: () => new Error("The delayed browser command was never released."),
          });
          return json(opened);
        },
      );
      try {
        await host.client.load();
        const handle = host.client.beginBrowserTabOpen(
          { identity: { kind: "guest" } },
          { idempotencyKey: "viewer-open" },
        );
        const answer = handle.result.catch((error: unknown) => error);
        const original = host.host.bootstrap;
        host.host.bootstrap = async () => {
          if (change === "sign-out")
            return json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
          const body = await (await original()).json();
          return json(
            change === "person"
              ? { ...body, user: { ...body.user, id: createId("user") } }
              : { ...body, deploymentId: "dep_00000000-0000-4000-8000-000000000002" },
          );
        };
        if (change === "sign-out") await expect(host.client.refresh()).rejects.toThrow();
        else await host.client.refresh();
        expect(host.client.getSnapshot().pendingBrowserTabs).toEqual([]);
        gate.resolve();
        expect(await answer).toMatchObject({ code: "unauthorized" });
        expect(
          host.client
            .getSnapshot()
            .browserSessions.some((session) => session.id === opened.sessionId),
        ).toBe(false);
      } finally {
        gate.resolve();
        host.client.dispose();
      }
    },
  );

  it("does not complete a dismissed opening for a viewer who left during its authorized close", async () => {
    const opened = await browserOpenWorld();
    const openingGate = deferred<void>();
    const closingGate = deferred<void>();
    const closingStarted = deferred<void>();
    const host = ownerViewHost(
      () => [],
      async (command) => {
        if (command.type === "browser.tab.close") {
          closingStarted.resolve();
          await withTimeout(closingGate.promise, 2_000, {
            timeoutError: () => new Error("The authorized tab close was never released."),
          });
          return json({
            sessionId: opened.sessionId,
            outcome: "tab-closed",
            sourceCatalog: opened.sourceCatalog,
          });
        }
        await withTimeout(openingGate.promise, 2_000, {
          timeoutError: () => new Error("The pending tab open was never released."),
        });
        return json(opened);
      },
    );
    try {
      await host.client.load();
      const handle = host.client.beginBrowserTabOpen(
        { identity: { kind: "guest" } },
        { idempotencyKey: "dismiss-and-leave" },
      );
      const answer = handle.result.catch((error: unknown) => error);
      host.client.dismissPendingBrowserTab(handle.idempotencyKey);
      openingGate.resolve();
      await withTimeout(closingStarted.promise, 2_000, {
        timeoutError: () => new Error("The dismissed tab was never closed."),
      });
      host.host.bootstrap = async () =>
        json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
      await expect(host.client.refresh()).rejects.toThrow();
      closingGate.resolve();
      expect(await answer).toMatchObject({ name: "AbortError" });
      expect(
        host.client
          .getSnapshot()
          .browserSessions.some((session) => session.id === opened.sessionId),
      ).toBe(false);
    } finally {
      openingGate.resolve();
      closingGate.resolve();
      host.client.dispose();
    }
  });

  const renewals = (commands: readonly Readonly<Record<string, unknown>>[]) =>
    commands.filter((command) => command.type === "computer.view.renew").length;

  it.each(["command", "notice"] as const)(
    "keeps a second app window accepted through a %s while an older refresh is in flight",
    async (delivery) => {
      const { machine, view } = await ownerViewWorld();
      if (view.target.kind !== "app") throw new Error("Expected a Mac app view");
      const second = ComputerViewSchema.parse({
        ...view,
        viewId: `cvw_${crypto.randomUUID()}`,
        target: { ...view.target, window: 102 },
        window: { id: 102, title: "Second window" },
      });
      let listed = [machine];
      const host = ownerViewHost(
        () => listed,
        async () => json({ view: second }),
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
        if (delivery === "command")
          await host.client.openComputerView(second.machineId, second.target);
        else socket.receive({ type: "host.computer-view.changed", view: second });
        const views = () =>
          host.client.getSnapshot().machines.find((candidate) => candidate.id === machine.id)
            ?.computerUse?.ownerViews;
        expect(views()).toEqual([view, second]);
        release.resolve();
        await refreshing;
        expect(views()).toEqual([view, second]);
        expect(
          placeList(host.client.getSnapshot()).filter((place) => place.ownerView),
        ).toHaveLength(2);

        // A read begun after the update still removes views the Host no longer lists.
        host.host.bootstrap = bootstrapAnswer;
        await host.client.refresh();
        expect(views()).toEqual([view]);
        listed = [{ ...machine, computerUse: { ...machine.computerUse!, ownerViews: [] } }];
        await host.client.refresh();
        expect(views()).toEqual([]);
      } finally {
        host.client.dispose();
      }
    },
  );

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

  it("never brings back a view the Host removed while an answer about it was on its way", async () => {
    const { machine, view } = await ownerViewWorld();
    const without = {
      ...machine,
      computerUse: { ...machine.computerUse!, ownerViews: [] },
    };
    let listed: readonly unknown[] = [without];
    const opening = deferred<void>();
    const host = ownerViewHost(
      () => listed,
      async (command) => {
        if (command.type === "computer.view.open") await opening.promise;
        return json({ view: command.type === "computer.view.open" ? view : view });
      },
    );
    await host.client.load();
    host.connect();
    const shown = () =>
      host.client
        .getSnapshot()
        .machines.flatMap((candidate) => candidate.computerUse?.ownerViews ?? [])
        .filter((candidate) => candidate.viewId === view.viewId);
    const opened = host.client.openComputerView(view.machineId, view.target);
    // Another device closed it; that notice arrives before this device's answer.
    host.sockets[0]!.receive({
      type: "host.computer-view.removed",
      viewId: view.viewId,
      generation: view.generation,
      machineId: view.machineId,
      reason: "closed",
    } as HostToClientMessage);
    opening.resolve();
    await opened;
    expect(shown()).toEqual([]);
    // Nor does a reread that left before the removal.
    listed = [machine];
    await host.client.refresh();
    expect(shown()).toEqual([]);
    // A newer generation of the same view is a new open, and is shown.
    const reopened = { ...view, generation: view.generation + 1 };
    host.sockets[0]!.receive({
      type: "host.computer-view.changed",
      view: reopened,
    } as HostToClientMessage);
    expect(shown()).toEqual([reopened]);
    host.client.dispose();
  });

  it("arms a phone's wake only for an open that did not decline it", async () => {
    const { machine, view: app } = await ownerViewWorld();
    const view = { ...app, target: { kind: "phone", display: "main" } } as typeof app;
    const host = ownerViewHost(
      () => [machine],
      async () => json({ type: "computer.view.open", view }),
    );
    await host.client.load();
    const arm = vi.spyOn(sharedDisplayStreams(host.client), "armAutoWake");
    await host.client.openComputerView(view.machineId, view.target, { wake: false });
    expect(arm).not.toHaveBeenCalled();
    await host.client.openComputerView(view.machineId, view.target);
    expect(arm).toHaveBeenCalledOnce();
    host.client.dispose();
  });

  it("takes a phone's tab away with its view, or a tab in front would reopen it", async () => {
    const { machine, view } = await ownerViewWorld();
    const tabOpenedAt = "2026-11-02T12:00:00.000Z";
    const host = ownerViewHost(
      () => [{ ...machine, tabOpenedAt }],
      async () => json({ view }),
    );
    await host.client.load();
    host.connect();
    const removal = {
      type: "host.computer-view.removed",
      viewId: view.viewId,
      machineId: view.machineId,
      reason: "closed",
    };
    const tab = () =>
      host.client.getSnapshot().machines.find(({ id }) => id === view.machineId)?.tabOpenedAt;
    host.sockets[0]!.receive({ ...removal, generation: view.generation } as HostToClientMessage);
    expect(tab()).toBe(tabOpenedAt);
    host.sockets[0]!.receive({
      ...removal,
      generation: view.generation + 1,
      tabClosed: true,
    } as HostToClientMessage);
    expect(tab()).toBeNull();
    host.client.dispose();
  });

  it("finishes an open the Host granted although history was cleared meanwhile, and refuses one for a viewer who left", async () => {
    const { machine, view } = await ownerViewWorld();
    const sessionId = createBrowserSessionId();
    const deploymentId = DeploymentIdSchema.parse(createId("deployment"));
    let gate = deferred<void>();
    let signedIn = true;
    const host = ownerViewHost(
      () => [machine],
      async (command) => {
        await withTimeout(gate.promise, 2_000, {
          timeoutError: () => new Error("The domain command was not released."),
        });
        if (command.type === "computer.view.open") return json({ view });
        return json({
          sessionId,
          tabId: "page-1",
          sourceCatalog: {
            generation: 1,
            revision: 1,
            rows: [
              {
                id: BrowserSurfaceIdSchema.parse("page-1"),
                title: "Example",
                site: "https://example.com",
                iconRef: null,
                order: 0,
                openerId: null,
                availability: "ready",
                documentId: "document",
                occupants: [],
              },
            ],
          },
          browserStarted: true,
          session: {
            access: "read-write",
            createdAt: now,
            id: sessionId,
            origin: "person",
            placement: { kind: "runner", runnerId },
            profileId: null,
            runtimeId: "runtime",
            state: "ready",
            updatedAt: now,
            deploymentId,
          },
        });
      },
    );
    const bootstrapAnswer = host.host.bootstrap;
    host.host.bootstrap = async () =>
      signedIn
        ? bootstrapAnswer()
        : json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
    await host.client.load();
    host.connect();
    const personal = {
      kind: "profile" as const,
      profileId: "bpr_00000000-0000-4000-8000-000000000001",
    };
    const viewOpen = host.client.openComputerView(view.machineId, view.target);
    const tabOpen = host.client.openBrowserTab(
      { identity: { kind: "guest" } },
      { url: "https://example.com/", typed: true },
    );
    expect(host.commands.find((command) => command.type === "browser.tab.open")).toMatchObject({
      typed: true,
    });
    // Clearing history has no effect on unrelated domain answers.
    await host.client.browserHistory.clear(personal.profileId);
    gate.resolve();
    await expect(viewOpen).resolves.toMatchObject({ viewId: view.viewId });
    await expect(tabOpen).resolves.toMatchObject({ sessionId, tabId: "page-1" });
    expect(
      host.client.getSnapshot().browserSessions.some((session) => session.id === sessionId),
    ).toBe(true);
    expect(host.client.browserHistory.entries(personal.profileId)).toEqual([]);

    // The person who asked is no longer the one signed in: the answer is not adopted.
    gate = deferred<void>();
    const late = host.client.openComputerView(view.machineId, view.target);
    signedIn = false;
    await expect(host.client.refresh()).rejects.toThrow();
    gate.resolve();
    const refused = await late.then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(HostClientRequestError);
    expect((refused as HostClientRequestError).code).toBe("unauthorized");
    host.client.dispose();
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

describe("HttpHostClient saved-tab activation lifecycle", () => {
  const traces: Record<string, unknown>[] = [];
  let traceStart = 0;
  beforeEach(() => {
    traceStart = traces.length;
  });
  afterEach(({ task }) => {
    const observed = traces.slice(traceStart);
    expect(observed.length).toBeGreaterThan(0);
    Object.assign(task.meta, { personalTabActivationTrace: observed });
  });

  async function fixture(name: string, available = false) {
    const seed = new MockHostClient();
    const initial = seed.getSnapshot();
    const saved = browserLineages(initial)!.find(
      (group) =>
        group.session.profileId &&
        group.tabs?.length &&
        initial.browserPlacements.some(
          (placement) => placement.runnerId === group.session.placement.runnerId,
        ),
    )!;
    const session = initial.browserSessions.find((value) => value.id === saved.session.id)!;
    const workspace = makeDeployment();
    const group: PersonalTabLineage = {
      ...saved,
      session: seedBrowserSession(
        { ...saved.session, deploymentId: workspace.id, state: "closed" },
        undefined,
      ),
      tabs: saved.tabs!.map((tab) => ({ ...tab, state: "suspended" })),
    };
    const tabId = group.tabs![0]!.id;
    const browser: HostedBrowserBootstrap = {
      available: true,
      tabRestoreVersion: 1,
      lineages: [group],
      profiles: initial.browserProfiles,

      sessions: [],
      placements: initial.browserPlacements.map((placement) => ({ ...placement, available })),
    };
    seed.dispose();
    const body = { ...bootstrap([workspace], browser), browser };
    const platform = fakeLifecycle({ network: "online", visibility: "foreground" });
    const sockets: FakeSocket[] = [];
    const requests: { reply: (response: Response) => void }[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    const concurrentByViewer = new Map<string, number>();
    let subscriptions = 0;
    const client = createHttpHostClient({
      refreshIntervalMs: 0,
      lifecycle: platform.lifecycle,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/commands.dispatch")) {
          expect(rpcPayload(url, init).type).toBe("tab.activate");
          concurrent++;
          const viewer = client.getSnapshot().user!.id;
          const viewerConcurrent = (concurrentByViewer.get(viewer) ?? 0) + 1;
          concurrentByViewer.set(viewer, viewerConcurrent);
          maximumConcurrent = Math.max(maximumConcurrent, viewerConcurrent);
          try {
            return await new Promise<Response>((reply) => requests.push({ reply }));
          } finally {
            concurrent--;
            concurrentByViewer.set(viewer, concurrentByViewer.get(viewer)! - 1);
          }
        }
        return json(body);
      },
    });
    const sync = () => {
      const socket = sockets.at(-1)!;
      socket.open();
      socket.receive({ type: "host.snapshot", snapshot: deploymentSnapshot(workspace, "1") });
      socket.receive({
        type: "host.synchronized",

        sequence: sequence("1"),
      });
    };
    await client.load();
    sync();
    const effects: { sessions: string[]; titles: string[] }[] = [];
    const stopEffects = client.subscribe(() => {
      const snapshot = client.getSnapshot();
      effects.push({
        sessions: snapshot.browserSessions.map((session) => session.id),
        titles: snapshot.browserSessions.flatMap(
          (session) =>
            (session.browserTabs?.sessionTabs(session?.id) ?? []).map((tab) => tab.title) ?? [],
        ),
      });
    });
    const subscribe = client.subscribe;
    vi.spyOn(client, "subscribe").mockImplementation((listener) => {
      subscriptions++;
      const stop = subscribe(listener);
      return () => {
        subscriptions--;
        stop();
      };
    });
    const success = (title?: string) => {
      if (title === undefined && client.getSnapshot().session === "authenticated")
        publishBrowser(sockets.at(-1)!, {
          lineages: [
            {
              ...group,
              session: seedBrowserSession(
                { ...group.session, state: "ready" },
                session.browserTabs!.inventory(session?.id),
              ),
              tabs: group.tabs!.map((tab) => ({ ...tab, state: "live" })),
            },
          ],
        });
      return json({
        type: "tab.activate",
        tabId,
        catalog: title
          ? {
              ...session.browserTabs!.inventory(session?.id)!,
              tabs: (session.browserTabs?.sessionTabs(session?.id) ?? []).map((tab) => ({
                ...tab,
                title,
              })),
            }
          : session.browserTabs!.inventory(session?.id),
        session: { ...group.session, state: "ready" },
        group: {
          ...group,
          revision: group.revision + 1,
          session: { ...group.session, state: "ready" },
          tabs: group.tabs!.map((tab) => ({ ...tab, state: "live" })),
        },
      });
    };
    const waiting = () =>
      json(
        {
          error: {
            code: "conflict",
            reason: "browser-placement-waiting",
            message: "Computer is reconnecting",
            retryable: true,
          },
        },
        409,
      );
    const record = (phase: string) => {
      const observed = {
        name,
        phase,
        dispatches: requests.length,
        concurrent,
        maximumConcurrent,
        concurrentByViewer: Object.fromEntries(concurrentByViewer),
        subscriptions,
        pending: [...(client.getSnapshot().activatingPersonalTabs ?? [])],
      };
      traces.push(observed);
      expect(maximumConcurrent).toBeLessThanOrEqual(1);
      return observed;
    };
    return {
      client,
      effects,
      tabId,
      group,
      browser,
      session,
      body,
      platform,
      sockets,
      requests,
      sync,
      success,
      waiting,
      record,
      async ready(value: boolean) {
        body.browser.placements = body.browser.placements.map((placement) => ({
          ...placement,
          available: value,
        }));
        await client.refresh();
      },
      cleanup() {
        stopEffects();
        client.dispose();
        const observed = record("disposed");
        expect(observed.subscriptions).toBe(0);
        expect(observed.pending).toEqual([]);
      },
    };
  }

  it("joins StrictMode double effects, switch-away/reselection and reconnect without concurrent dispatch", async () => {
    const f = await fixture("selection and Host reconnect");
    try {
      const first = f.client.activatePersonalTab(f.tabId);
      expect(f.client.activatePersonalTab(f.tabId)).toBe(first);
      // Selection cleanup does not own the client operation; reselection joins it.
      expect(f.client.activatePersonalTab(f.tabId)).toBe(first);
      expect(f.record("selected")).toMatchObject({
        dispatches: 0,
        subscriptions: 1,
        pending: [f.tabId],
      });
      f.platform.changeNetwork("offline");
      expect(f.client.getSnapshot().connection).toBe("offline");
      await f.ready(true);
      expect(f.record("Host offline").dispatches).toBe(0);
      f.platform.changeNetwork("online");
      f.sync();
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(f.success());
      expect(await first).toMatchObject({ tabId: f.tabId });
      expect(f.record("paintable")).toMatchObject({ dispatches: 1, subscriptions: 0, pending: [] });
    } finally {
      f.cleanup();
    }
  });

  it("rechecks availability changed before a placement refusal arrives", async () => {
    const f = await fixture("readiness changes during request", true);
    try {
      const result = f.client.activatePersonalTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      await f.ready(false);
      await f.ready(true);
      expect(f.record("before refusal").dispatches).toBe(1);
      f.requests[0]!.reply(f.waiting());
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[1]!.reply(f.success());
      expect(await result).toMatchObject({ tabId: f.tabId });
      expect(f.record("retried")).toMatchObject({
        dispatches: 2,
        maximumConcurrent: 1,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it("waits after placement refusal, ignores unrelated publications, and retries exactly once", async () => {
    const f = await fixture("serialized placement retry", true);
    try {
      const result = f.client.activatePersonalTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(f.waiting());
      await vi.waitFor(() => expect(f.record("refused").concurrent).toBe(0));
      await f.client.refresh();
      await f.client.refresh();
      expect(f.record("unrelated publications")).toMatchObject({
        dispatches: 1,
        subscriptions: 1,
        pending: [f.tabId],
      });
      await f.ready(false);
      await f.ready(true);
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[1]!.reply(f.success());
      await result;
      expect(f.record("finished")).toMatchObject({
        dispatches: 2,
        maximumConcurrent: 1,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it("rejects real errors and permits an explicit retry", async () => {
    const f = await fixture("failure and explicit retry", true);
    try {
      const pending = f.client.activatePersonalTab(f.tabId);
      const failed = expect(pending).rejects.toThrow("Activation failed");
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(
        json({ error: { code: "internal", message: "Activation failed" } }, 500),
      );
      await failed;
      expect(f.record("failed")).toMatchObject({ subscriptions: 0, pending: [] });
      const retry = f.client.activatePersonalTab(f.tabId);
      expect(retry).not.toBe(pending);
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[1]!.reply(f.success());
      await retry;
      expect(f.record("retry complete")).toMatchObject({
        dispatches: 2,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it.each(["waiting", "dispatching"] as const)(
    "actively settles on disposal while %s",
    async (phase) => {
      const f = await fixture(`dispose ${phase}`, phase === "dispatching");
      const pending = f.client.activatePersonalTab(f.tabId);
      if (phase === "dispatching") await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.cleanup();
      expect(await pending).toBeNull();
      if (phase === "dispatching") f.requests[0]!.reply(f.success());
      await Promise.resolve();
      expect(
        f.client.getSnapshot().browserSessions.every((session) => session.state !== "ready"),
      ).toBe(true);
      expect(await f.client.activatePersonalTab(f.tabId)).toBeNull();
    },
  );

  it.each([false, true])(
    "silently closes and fences late success (dispatching=%s)",
    async (dispatching) => {
      const f = await fixture(`close dispatching=${dispatching}`, dispatching);
      try {
        const pending = f.client.activatePersonalTab(f.tabId);
        if (dispatching) await vi.waitFor(() => expect(f.requests).toHaveLength(1));
        f.body.browser.lineages = [{ ...f.group, revision: f.group.revision + 2, tabs: [] }];
        publishBrowser(f.sockets.at(-1)!, f.body.browser);
        await f.client.refresh();
        expect(await pending).toBeNull();
        if (dispatching) f.requests[0]!.reply(f.success("Closed tab late reply"));
        await f.client.refresh();
        expect(
          f.effects.some((snapshot) => snapshot.titles.includes("Closed tab late reply")),
        ).toBe(false);
        expect(
          f.client.getSnapshot().browserSessions.every((session) => session.state !== "ready"),
        ).toBe(true);
        expect(browserLineages(f.client.getSnapshot())![0]!.tabs).toEqual([]);
        expect(f.record("closed")).toMatchObject({ subscriptions: 0, pending: [] });
      } finally {
        f.cleanup();
      }
    },
  );

  it("settles on account switch and an old finalizer cannot clear a replacement", async () => {
    const f = await fixture("account switch and late reply", true);
    try {
      const old = f.client.activatePersonalTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.body.user = { ...f.body.user, id: createId("user") };
      await f.client.refresh();
      f.sync();
      expect(await old).toBeNull();
      expect(f.record("account changed")).toMatchObject({ pending: [], subscriptions: 0 });
      const replacement = f.client.activatePersonalTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(2));
      f.requests[0]!.reply(f.success("Old account late reply"));
      await f.client.refresh();
      expect(f.record("old reply").pending).toEqual([f.tabId]);
      f.requests[1]!.reply(f.success());
      await replacement;
      expect(f.effects.some((snapshot) => snapshot.titles.includes("Old account late reply"))).toBe(
        false,
      );
      expect(f.record("replacement complete")).toMatchObject({ pending: [], subscriptions: 0 });
    } finally {
      f.cleanup();
    }
  });

  it.each(["profile", "row", "placement"] as const)(
    "lasting %s unavailability overrides restoring and ends silently",
    async (kind) => {
      const f = await fixture(`unavailable ${kind}`);
      try {
        const pending = f.client.activatePersonalTab(f.tabId);
        f.body.browser.lineages = [
          {
            ...f.group,
            tabs: f.group.tabs!.map((tab) => ({ ...tab, state: "restoring" })),
            ...(kind === "row" ? { unavailableReason: "Row unavailable" } : {}),
          },
        ];
        if (kind === "profile") f.body.browser.profiles = [];
        if (kind === "placement")
          f.body.browser.placements = f.body.browser.placements.map((placement) => ({
            ...placement,
            unavailableReason: "Computer unavailable",
          }));
        f.body.browser.sessions = [
          seedBrowserSession(
            { ...f.group.session, state: "ready" },
            {
              ...f.session.browserTabs!.inventory(f.session?.id)!,
              rows: (f.session.browserTabs?.sessionTabs(f.session?.id) ?? []).map((tab) => ({
                ...tab,
                loading: true,
              })),
            },
          ),
        ];
        publishBrowser(f.sockets.at(-1)!, f.body.browser);
        await f.client.refresh();
        expect(await pending).toBeNull();
        expect(
          placeList(f.client.getSnapshot()).find((place) => place.personalTab?.id === f.tabId)
            ?.loading,
        ).toBe(false);
        expect(f.record("unavailable")).toMatchObject({
          dispatches: 0,
          pending: [],
          subscriptions: 0,
        });
      } finally {
        f.cleanup();
      }
    },
  );

  it("applies a successful reply even when a bounded bootstrap omitted the lineage", async () => {
    const f = await fixture("reply after omitted lineage", true);
    try {
      const pending = f.client.activatePersonalTab(f.tabId);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.body.browser.lineages = [];
      await f.client.refresh();
      f.requests[0]!.reply(f.success());
      expect(await pending).toMatchObject({ tabId: f.tabId });
      expect(
        browserLineages(f.client.getSnapshot())
          ?.find((group) => group.id === f.group.id)
          ?.tabs?.some((tab) => tab.id === f.tabId),
      ).toBe(true);
      expect(f.record("recovered from reply")).toMatchObject({
        dispatches: 1,
        subscriptions: 0,
        pending: [],
      });
    } finally {
      f.cleanup();
    }
  });

  it("keeps waiting across an omitted lineage and a missing tabs array", async () => {
    const f = await fixture("bounded catalog");
    try {
      const pending = f.client.activatePersonalTab(f.tabId);
      f.body.browser.lineages = [];
      await f.client.refresh();
      expect(f.record("lineage omitted")).toMatchObject({
        pending: [f.tabId],
        subscriptions: 1,
        dispatches: 0,
      });
      const { tabs: _tabs, ...bounded } = f.group;
      f.body.browser.lineages = [bounded];
      await f.client.refresh();
      expect(
        browserLineages(f.client.getSnapshot())![0]!.tabs?.some((tab) => tab.id === f.tabId),
      ).toBe(true);
      expect(f.record("tabs omitted").pending).toEqual([f.tabId]);
      await f.ready(true);
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      f.requests[0]!.reply(f.success());
      await pending;
      expect(f.record("recovered")).toMatchObject({ dispatches: 1, pending: [], subscriptions: 0 });
    } finally {
      f.cleanup();
    }
  });
});

describe("realtime review regressions", () => {
  async function fixture(options: Partial<TestHostClientOptions> = {}) {
    const workspace = makeDeployment();
    const thread = makeThread(workspace.id);
    const sockets: FakeSocket[] = [];
    const client = createHttpHostClient({
      fetch: async () => json(bootstrap([workspace])),
      refreshIntervalMs: 0,
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
    const f = await fixture({ lifecycle: platform.lifecycle, refreshIntervalMs: 10 });
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
      refreshIntervalMs: 0,
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
    readonly hostBrowser?: (workspace: PersonalFixture) => HostedBrowserBootstrap;
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
      refreshIntervalMs: 0,
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
      expect(describeHostConnection(f.client.getSnapshot())).toMatchObject({
        action: "retry",
        label: "Unavailable",
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
        platform.changeNetwork("online");
        await vi.advanceTimersByTimeAsync(0);
        expect(f.sockets).toHaveLength(opened + 1);
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
    const session = (workspace: PersonalFixture, fields: Record<string, unknown> = {}) => ({
      access: "read-write" as const,
      createdAt: now,
      id: sessionId,
      origin: "person" as const,
      placement: { kind: "runner" as const, runnerId },
      profileId: null,
      runtimeId: "runtime",
      state: "ready" as const,
      updatedAt: now,
      deploymentId: workspace.id,
      ...fields,
    });
    const browserWith = (sessions: NonNullable<HostedBrowserBootstrap["sessions"]>) =>
      browserBootstrapWithRows({
        available: true,
        placements: [],

        profiles: [],
        sessions,
      });

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
      const tabSeed = (revision: number) => ({
        generation: 1,
        revision,
        rows: [
          {
            availability: "ready" as const,
            documentId: null,
            iconRef: null,
            id: "page-1",
            occupants: [],
            openerId: null,
            order: 0,
            site: "https://example.com",
            title: "Example",
          },
        ],
      });
      const lost = {
        type: "host.computer-presence",
        sessions: "unreadable",
      };

      async function losing(reads: Parameters<typeof synchronizedClient>[0] = {}) {
        let revision = 1;
        const f = await synchronizedClient({
          ...reads,
          hostBrowser: (workspace) =>
            browserWith([seedBrowserSession(session(workspace), tabSeed(revision))]),
        });
        f.sockets[0]!.receiveRaw(lost);
        await vi.advanceTimersByTimeAsync(0);
        revision = 2;
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
        hostBrowser: (workspace) => browserWith([session(workspace)]),
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

    const place = {
      kind: "browser" as const,
      sessionId,
      surfaceId: BrowserSurfaceIdSchema.parse("page-1"),
    };
    const activity = (runId: string, seq: number) => ({
      at: 1_000,
      expiresAt: 2_000,
      generation: 1,
      geometryRevision: 1,

      order: seq,
      place,
      pointer: { x: 0.5, y: 0.5 },
      runId,
      seq,
      threadId: createId("thread"),
    });

    it.each([
      ["host.place-activity-cleared", { place: "unreadable" }],
      ["host.place-activity", { activity: { place: "unreadable" } }],
    ])("leaves no agent behind when %s cannot be read", async (type, fields) => {
      const f = await synchronizedClient();
      try {
        const socket = f.sockets[0]!;
        const runId = createId("run");
        const key = placeIdentityKey(place);
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

function publishBrowser(socket: FakeSocket, input: Partial<HostedBrowserBootstrap>) {
  const { groups: _groups, tabs: _tabs, ...browser } = input;
  const prefix = browserBootstrapWithRows({
    available: true,

    profiles: [],
    placements: [],
    sessions: [],
    ...browser,
  });
  const send = <Row extends { id: string }>(
    rows: Row[],
    envelope: (stream: unknown) => unknown,
  ) => {
    const records = new Map(rows.map((row) => [row.id, row]));
    const publisher = new KeyedStreamPublisher({
      ids: () => records.keys(),
      read: (id) => records.get(id),
      meta: () => ({}),
      targetBytes: 16 * 1024,
      envelopeBytes: 200,
    });
    for (let frame = publisher.next(); frame; frame = publisher.next()) {
      socket.receiveRaw(envelope(frame));
      publisher.settled(frame, true);
    }
  };
  send(prefix.groups!.rows, (stream) => ({ type: "host.browser-groups", stream }));
  for (const group of prefix.tabs!)
    send(group.rows, (stream) => ({ type: "host.browser-tabs", groupId: group.groupId, stream }));
}

const bootstrapFixtures = new Map<string, { browser: BrowserWireBootstrap }>();
function bootstrap(
  workspaces: PersonalFixture[],
  browser: HostedBrowserBootstrap = {
    available: false,
    placements: [],
    profiles: [],
    sessions: [],
  },
) {
  const result = {
    browser: browserBootstrapWithRows(browser),
    deploymentId: workspaces[0]?.id ?? createId("deployment"),
    personalSettings: {
      ownerId,
      agentHome: { computerId: runnerId, path: "/Users/person/Opensteer" },
      voiceThreadId: null,
    },
    can: { createTasks: true, useVoice: true, manageComputers: true, managePrivateResources: true },
    sessionId: createId("authSession"),
    appTabs: [],
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
  bootstrapFixtures.set(result.deploymentId, result);
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

function browserFrame(frameId: number): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({
      encoding: "jpeg",
      frameId,
      geometryRevision: 1,
      watchToken: "00000000-0000-4000-8000-000000000001",
      rasterHeight: 1,
      rasterWidth: 1,
      surfaceId: "page-1",
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
      appTabs: [],
      browser:
        bootstrapFixtures.get(deployment.id)?.browser ??
        browserBootstrapWithRows({ available: false, placements: [], profiles: [], sessions: [] }),
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
  if (typeof payload === "object" && payload !== null && "browser" in payload) {
    const body = payload as { browser: HostedBrowserBootstrap };
    payload = { ...payload, browser: browserBootstrapWithRows(body.browser) };
  }
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      target: { threadId: f.other.id },
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
        place: {
          kind: "browser",
          sessionId: createBrowserSessionId(),
          surfaceId: BrowserSurfaceIdSchema.parse(`historical-tab-${sequence}`),
        },
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
    const sessionId = createBrowserSessionId();
    const runnerId = createId("runner");
    const tabId = BrowserSurfaceIdSchema.parse("tab");
    const browser: HostedBrowserBootstrap = {
      available: true,
      placements: [
        {
          kind: "runner",
          runnerId,
          runtimeId: "runtime",
          label: "Example computer",
          environmentIds: [],
          available: true,
        },
      ],

      profiles: [],
      sessions: [
        seedBrowserSession(
          {
            id: sessionId,
            access: "read-write",
            origin: "person",
            state: "ready",
            createdAt: now,
            updatedAt: now,
            deploymentId: workspace.id,
            profileId: null,
            runtimeId: "runtime",
            placement: { kind: "runner", runnerId },
          },
          {
            generation: 1,
            revision: 1,
            rows: [
              {
                id: tabId,
                title: "Example",
                site: "https://example.test",
                iconRef: null,
                order: 0,
                openerId: null,
                availability: "ready",
                documentId: null,
                occupants: [],
              },
            ],
          },
        ),
      ],
    };
    const sockets: { url: string; socket: FakeSocket }[] = [];
    const client = createHttpHostClient({
      capabilities: capable
        ? ["browser-passkeys-v1", "browser-target-control-v1"]
        : ["browser-target-control-v1"],
      fetch: async () => json(bootstrap([workspace], browser)),
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ url, socket });
        return socket;
      },
    });
    try {
      await client.load();
      const release = client.retainBrowserViewer(sessionId, tabId, { picture: false });
      const connection = sockets.find(({ url }) => url.includes("/browser-sessions/"))!;
      expect(new URL(connection.url).searchParams.get("passkeys")).toBe(capable ? "notice" : null);
      expect(new URL(connection.url).searchParams.get("popups")).toBe("1");
      expect(new URL(connection.url).searchParams.get("autofill")).toBe("2");
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
        ...(capable ? { passkeys: "notice" } : {}),
      });
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
    const client = createHttpHostClient({ refreshIntervalMs: 0 });
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
    const client = createHttpHostClient({ refreshIntervalMs: 0 });
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
    const client = createHttpHostClient({ refreshIntervalMs: 0 });
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
        refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,

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
            place: {
              kind: "browser",
              sessionId: createBrowserSessionId(),
              surfaceId: BrowserSurfaceIdSchema.parse("startup-tab"),
            },
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
        place: {
          kind: "browser",
          sessionId: createBrowserSessionId(),
          surfaceId: BrowserSurfaceIdSchema.parse(`tab-${sequence}`),
        },
        title: `Page ${sequence}`,
        site: "https://example.com",
      });
    const first = place("2"),
      second = place("4");
    let boot = bootstrap([workspace]);
    const socket = new FakeSocket();
    const client = createHttpHostClient({
      refreshIntervalMs: 0,

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

describe("app tab bootstrap races", () => {
  const appId = "app_00000000-0000-4000-8000-000000000001";
  function fixture(initialOpen = false) {
    const workspace = makeDeployment();
    const tab = {
      appId,
      title: "Budget",
      threadId: createId("thread"),
      deploymentId: workspace.id,
      latestVersion: 4,
      openedAt: now,
    };
    let tabs = initialOpen ? [tab] : [];
    let nextAppRead: ReturnType<typeof deferred<Response>> | null = null;
    let nextRead: ReturnType<typeof deferred<Response>> | null = null;
    let nextCommand: ReturnType<typeof deferred<Response>> | null = null;
    const commands: string[] = [];
    const readStarted = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith("bootstrap.get")) {
        readStarted();
        if (nextRead) {
          const gate = nextRead;
          nextRead = null;
          return gate.promise;
        }
        return json({ ...bootstrap([workspace]), appTabs: tabs });
      }
      if (path.endsWith("apps.get")) {
        if (nextAppRead) {
          const gate = nextAppRead;
          nextAppRead = null;
          return gate.promise;
        }
        return json({
          id: new URL(input instanceof Request ? input.url : input.toString()).searchParams.has(
            "input",
          )
            ? JSON.parse(
                new URL(input instanceof Request ? input.url : input.toString()).searchParams.get(
                  "input",
                )!,
              ).appId
            : appId,
          title: tab.title,
          threadId: tab.threadId,
          deploymentId: tab.deploymentId,
          runId: createId("run"),
          latestVersion: 4,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (path.endsWith("auth.logout")) return json({});
      if (path.endsWith("commands.dispatch")) {
        const command = JSON.parse(String(init?.body));
        commands.push(command.type);
        if (nextCommand) {
          const gate = nextCommand;
          nextCommand = null;
          return gate.promise;
        }
        tabs = command.type === "app.tab.open" ? [tab] : [];
        return json({ appTabs: tabs });
      }
      throw new Error(path);
    }) as unknown as typeof globalThis.fetch;
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: () => new FakeSocket(),
    });
    return {
      client,
      commands,
      tab,
      workspace,
      readStarted,
      holdAppRead: () => {
        const gate = deferred<Response>();
        nextAppRead = gate;
        return gate;
      },
      holdRead: () => {
        const gate = deferred<Response>();
        nextRead = gate;
        return gate;
      },
      holdCommand: () => {
        const gate = deferred<Response>();
        nextCommand = gate;
        return gate;
      },
    };
  }
  it("reserves the app while metadata loads so immediate navigation does not end it", async () => {
    const f = fixture();
    try {
      await f.client.load();
      const gate = f.holdAppRead();
      const opening = f.client.openAppTab(appId);
      const snapshot = f.client.getSnapshot();
      gate.resolve(
        json({
          id: appId,
          title: f.tab.title,
          threadId: f.tab.threadId,
          deploymentId: f.tab.deploymentId,
          runId: createId("run"),
          latestVersion: 4,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await opening;
      expect(isAppTabOpen(snapshot, appId)).toBe(true);
      expect(placeDestinationEnded(snapshot, { kind: "opensteer-app", appId })).toBe(false);
    } finally {
      f.client.dispose();
    }
  });
  it("sends one app's writes in order, so a slow open cannot outlive a later close", async () => {
    const f = fixture();
    try {
      await f.client.load();
      const gate = f.holdCommand();
      const opening = f.client.openAppTab(appId);
      await vi.waitFor(() => expect(f.commands).toEqual(["app.tab.open"]));
      const closing = f.client.closeAppTab(appId);
      for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
      expect(f.commands).toEqual(["app.tab.open"]);
      gate.resolve(json({ appTabs: [f.tab] }));
      await Promise.all([opening, closing]);
      expect(f.commands).toEqual(["app.tab.open", "app.tab.close"]);
      expect(f.client.getSnapshot().appTabs ?? []).toEqual([]);
    } finally {
      f.client.dispose();
    }
  });
  it("drops a queued app write when the viewer changes before it is sent", async () => {
    const f = fixture();
    try {
      await f.client.load();
      const gate = f.holdCommand();
      const opening = f.client.openAppTab(appId);
      await vi.waitFor(() => expect(f.commands).toEqual(["app.tab.open"]));
      const closing = f.client.closeAppTab(appId);
      const read = f.holdRead();
      const refreshing = f.client.refresh();
      const payload = bootstrap([f.workspace]);
      read.resolve(json({ ...payload, user: { ...payload.user, id: createId("user") } }));
      await refreshing;
      gate.resolve(json({ appTabs: [f.tab] }));
      await Promise.all([opening, closing]);
      expect(f.commands).toEqual(["app.tab.open"]);
    } finally {
      f.client.dispose();
    }
  });
  it("drops a queued app write when the client is disposed before it is sent", async () => {
    const f = fixture();
    await f.client.load();
    const gate = f.holdCommand();
    const opening = f.client.openAppTab(appId);
    await vi.waitFor(() => expect(f.commands).toEqual(["app.tab.open"]));
    const closing = f.client.closeAppTab(appId);
    f.client.dispose();
    gate.resolve(json({ appTabs: [f.tab] }));
    await Promise.allSettled([opening, closing]);
    expect(f.commands).toEqual(["app.tab.open"]);
  });
  it("does not reopen a tab when a later close overtakes its metadata read", async () => {
    const f = fixture();
    try {
      await f.client.load();
      const gate = f.holdAppRead();
      const opening = f.client.openAppTab(appId);
      await f.client.closeAppTab(appId);
      gate.resolve(
        json({
          id: appId,
          title: f.tab.title,
          threadId: f.tab.threadId,
          deploymentId: f.tab.deploymentId,
          runId: createId("run"),
          latestVersion: 4,
          createdAt: now,
          updatedAt: now,
        }),
      );
      await opening;
      expect(f.client.getSnapshot().appTabs ?? []).toEqual([]);
    } finally {
      f.client.dispose();
    }
  });
  it("merges bootstrap app versions without lowering an observed version", async () => {
    const f = fixture(true);
    try {
      await f.client.load();
      expect(f.client.getSnapshot().appVersions?.[appId]).toBe(4);
      const gate = f.holdRead();
      const reading = f.client.refresh();
      gate.resolve(
        json({ ...bootstrap([f.workspace]), appTabs: [{ ...f.tab, latestVersion: 2 }] }),
      );
      await reading;
      expect(f.client.getSnapshot().appVersions?.[appId]).toBe(4);
    } finally {
      f.client.dispose();
    }
  });
  it.each([true, false])("keeps a settled %s mutation over an earlier bootstrap", async (open) => {
    const f = fixture(!open);
    try {
      await f.client.load();
      const gate = f.holdRead();
      const reads = f.readStarted.mock.calls.length;
      const reading = f.client.refresh();
      await vi.waitFor(() => expect(f.readStarted.mock.calls.length).toBeGreaterThan(reads));
      await (open ? f.client.openAppTab(appId) : f.client.closeAppTab(appId));
      gate.resolve(json({ ...bootstrap([f.workspace]), appTabs: open ? [] : [f.tab] }));
      await reading;
      expect(f.client.getSnapshot().appTabs?.some((tab) => tab.appId === appId) ?? false).toBe(
        open,
      );
      if (open) expect(f.client.getSnapshot().appVersions?.[appId]).toBe(4);
    } finally {
      f.client.dispose();
    }
  });
  it("rolls back a failed open while retaining another app tab", async () => {
    const f = fixture(true);
    const otherId = "app_00000000-0000-4000-8000-000000000002";
    try {
      await f.client.load();
      const gate = f.holdCommand();
      const opening = f.client.openAppTab(otherId);
      const rejected = expect(opening).rejects.toThrow();
      await vi.waitFor(() => expect(f.client.getSnapshot().appTabs).toHaveLength(2));
      gate.resolve(json({ error: { code: "conflict", message: "Limit", retryable: false } }, 409));
      await rejected;
      expect(f.client.getSnapshot().appTabs?.map((tab) => tab.appId)).toEqual([appId]);
    } finally {
      f.client.dispose();
    }
  });
  it("discards a mutation answer after the viewer changes", async () => {
    const f = fixture(true);
    try {
      await f.client.load();
      const gate = f.holdCommand();
      const closing = f.client.closeAppTab(appId);
      const read = f.holdRead();
      const refreshing = f.client.refresh();
      const payload = bootstrap([f.workspace]);
      read.resolve(
        json({ ...payload, user: { ...payload.user, id: createId("user") }, appTabs: [] }),
      );
      await refreshing;
      gate.resolve(json({ appTabs: [f.tab] }));
      await closing;
      expect(f.client.getSnapshot().appTabs ?? []).toEqual([]);
    } finally {
      f.client.dispose();
    }
  });
});

it("uses a real app entry URL when supplied and resolves legacy paths for previous Hosts", async () => {
  const client = createHttpHostClient();
  const app = {
    id: "app_11111111-1111-4111-8111-111111111111",
    deploymentId: createId("deployment"),
    threadId: createId("thread"),
    runId: createId("run"),
    title: "App",
    latestVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const path = `/v1/apps/${app.id}/dark/legacy/`;
  const entryUrl =
    "https://aaaaaaaaaaaaaaaaaaaaaaaaaa-11111111111111111111111111111111.example.test/?opensteer-ticket=test";
  const read = vi.fn<(typeof client.rpc)["apps.view"]>();
  Object.defineProperty(client.rpc, "apps.view", { value: read });
  read.mockResolvedValueOnce({ ok: true, data: { app, path, entryUrl } });
  read.mockResolvedValueOnce({ ok: true, data: { app, path } });
  try {
    expect((await client.viewApp(app.id, "dark")).url).toBe(entryUrl);
    expect((await client.viewApp(app.id, "dark")).url).toBe(`http://127.0.0.1${path}`);
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
    refreshIntervalMs: 0,
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

it.each([true, false])("opens a fresh session with workspace cached: %s", async (cached) => {
  const workspace = makeDeployment();
  const sessionId = createBrowserSessionId();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path === "/v1/rpc/bootstrap.get") {
      return json(
        bootstrap(cached ? [workspace] : [], {
          available: true,
          placements: [
            {
              available: true,
              environmentIds: [],
              kind: "runner",
              label: "Main Host",
              runnerId: runnerId,
              runtimeId: "runtime-1",
            },
          ],
          profiles: [],
          sessions: [],
        }),
      );
    }
    if (path === "/v1/rpc/commands.dispatch" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({
        input: { fresh: true, placement: { kind: "runner", runnerId: runnerId } },
        type: "browser.session.start",
      });
      return json(
        {
          session: {
            access: "read-write",
            createdAt: now,
            id: sessionId,
            origin: "person",
            placement: { kind: "runner", runnerId: runnerId },
            profileId: null,
            runtimeId: "runtime-1",
            state: "ready",
            updatedAt: now,
          },
          wasExisting: false,
        },
        201,
      );
    }
    throw new Error(`Unexpected request ${path}`);
  }) as unknown as typeof globalThis.fetch;
  const client = createHttpHostClient({
    fetch,
    refreshIntervalMs: 0,
    webSocketFactory: () => new FakeSocket(),
  });
  await client.load();

  const session = await client.startBrowser(
    workspace.id,
    { kind: "fresh" },
    {
      available: true,
      environmentIds: [],
      kind: "runner",
      label: "Main Host",
      runnerId: runnerId,
      runtimeId: "runtime-1",
    },
  );
  expect(session.profileId).toBeNull();
  expect(client.getSnapshot().browserSessions).toEqual([
    expect.objectContaining({ id: sessionId, profileId: null }),
  ]);
  client.dispose();
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
      refreshIntervalMs: 0,
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
        refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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

    expect(client.getSnapshot().harnesses).toEqual([
      expect.objectContaining({ id: harnessInstanceId }),
      expect.objectContaining({ id: addedHarnessId, name: "Claude" }),
    ]);
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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
      refreshIntervalMs: 0,
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

  it("releases the viewer transport and its frame when a Browser Session is closed", async () => {
    const workspace = makeDeployment();
    const profileId = createId("browserProfile");
    const sessionId = createBrowserSessionId();
    const sockets: Array<{ socket: FakeSocket; url: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path !== "/v1/rpc/commands.dispatch") {
        return json(
          bootstrap([workspace], {
            available: true,
            placements: [
              {
                available: true,
                environmentIds: [],
                kind: "runner",
                label: "Main Host",
                runnerId: runnerId,
                runtimeId: "runtime-1",
              },
            ],
            profiles: [{ homeRunnerId: null, id: profileId, name: "Default browser" }],
            sessions: [],
          }),
        );
      }
      const command = asObject(JSON.parse(String(init?.body)));
      if (requiredString(command, "type") === "browser.session.close") return json({}, 202);
      return json(
        {
          session: {
            access: "read-write",
            createdAt: now,
            id: sessionId,
            origin: "person",
            placement: { kind: "runner", runnerId: runnerId },
            profileId,
            runtimeId: "runtime-1",
            state: "ready",
            updatedAt: now,
            deploymentId: workspace.id,
          },
          wasExisting: false,
        },
        201,
      );
    });
    const client = createHttpHostClient({
      fetch,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new FakeSocket();
        sockets.push({ socket, url });
        return socket;
      },
    });
    await client.load();
    await client.startBrowser(workspace.id, { kind: "profile", profileId });
    const release = client.retainBrowserViewer(sessionId, "page-1");
    const viewer = sockets.find(({ url }) => url.includes("/browser-sessions/"))?.socket;
    expect(viewer).toBeDefined();
    viewer?.open();
    viewer?.receiveRaw({
      access: "read-write",
      dialog: null,
      sessionId,
      state: "ready",
      surfaces: [{ active: true, id: "page-1", title: "Example", url: "https://example.com/" }],
      targetedStreamingVersion: 1,
      type: "browser.snapshot",
    });
    viewer?.receiveBinary(browserFrame(1));
    expect(client.browserFrames.get(sessionId, "page-1")).not.toBeNull();

    // Re-opening the same session must keep the viewer state only the client
    // holds; the Host record says nothing about tabs or socket health.
    await client.startBrowser(workspace.id, { kind: "profile", profileId });
    expect(client.getSnapshot().browserSessions[0]).toMatchObject({
      viewerState: "disconnected",
    });
    expect(client.browserTabs.sessionTabs(client.getSnapshot().browserSessions[0]!.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Example" })]),
    );

    await client.dispatch({
      idempotencyKey: "browser-close:test",
      sessionId,
      type: "browser.session.close",
    });

    expect(viewer?.closeEvents).toEqual([{ code: 1000, reason: "Target released" }]);
    expect(client.browserFrames.get(sessionId, "page-1")).toBeNull();
    expect(client.getSnapshot().browserSessions[0]?.state).toBe("closed");
    release();
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
