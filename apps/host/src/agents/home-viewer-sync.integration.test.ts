import { gate } from "@opensteer/shared/test-support/observation";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, UserIdSchema, createId, zeroSequence } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { HostToClientMessageSchema, type HostToClientMessage } from "@opensteer/protocol";
import {
  DesktopHostHttpRequestSchema,
  DesktopHostHttpResponseSchema,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

interface ViewerClient {
  activateThread(threadId: string): void;
  activateWorkspace(workspaceId: string): void;
  dispatch(command: {
    readonly idempotencyKey: string;
    readonly threadId: string;
    readonly throughSequence: string;
    readonly type: "thread.read.mark";
  }): Promise<{ readonly type: string }>;
  dispose(): void;
  getSnapshot(): {
    readonly connection: string;
    readonly homeWorkspaceId: string | null;
    readonly notificationMutes: readonly string[];
    readonly revision: number;
    readonly activeTasks: readonly {
      readonly thread: { readonly id: string; readonly status: string };
    }[];
    readonly tasks: {
      readonly entries: readonly {
        readonly failure: string | null;
        readonly lastReply: string | null;
        readonly thread: {
          readonly doneAt: string | null;
          readonly id: string;
          readonly status: string;
          readonly workspaceId: string;
        };
      }[];
      readonly window: { readonly hasMore: boolean; readonly itemCount: number };
    } | null;
    readonly threadReadStates: Record<
      string,
      {
        readonly readSequence: string | null;
        readonly unreadSequence: string | null;
      }
    >;
    readonly threads: readonly {
      readonly doneAt: string | null;
      readonly id: string;
      readonly unread: boolean;
      readonly workspaceId: string;
    }[];
    readonly user: { readonly id: string } | null;
    readonly workspaces: readonly { readonly id: string }[];
  };
  load(): Promise<void>;
  loadEarlierTasks(): Promise<void>;
  loadLatestTranscript(threadId: string): Promise<void>;
  reauthenticate(): Promise<void>;
  setTaskDone(threadId: string, done: boolean): Promise<{ readonly doneAt: string | null }>;
  readonly rpc: {
    readonly "thread.events.list": (input: {
      readonly threadId: string;
    }) => Promise<{ readonly ok: boolean }>;
  };
}

interface BridgeFailures {
  readonly prefetchHome?: boolean;
  failNextBootstrap: boolean;
  holdResponse?: {
    readonly operation: string;
    readonly enter: () => Promise<void>;
  };
  readonly httpOperations: Set<string>;
  readonly transportOperations: Set<string>;
}

integration(
  "Home viewer synchronization across the actual Host and desktop request boundary",
  () => {
    let stack: VerticalStack | undefined;
    const clients: ViewerClient[] = [];
    const sockets: WebSocket[] = [];
    const gates: ReturnType<typeof gate>[] = [];
    const hold = (label: string) => {
      const held = gate({ label, deadlineMs: 15_000 });
      gates.push(held);
      return held;
    };
    const requests: Array<{ method: string; path: string; status: number }> = [];

    afterEach(async () => {
      for (const held of gates.splice(0)) held.abort();
      for (const client of clients.splice(0)) client.dispose();
      for (const socket of sockets.splice(0)) socket.terminate();
      requests.splice(0);
      await stack?.close();
      stack = undefined;
    }, 60_000);

    it("hydrates 82, 83, 100, 101, and 251 threads, pages older unread state through the task list, and repairs a missed read on resume without bulk metadata RPCs", async () => {
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [fakeCodexAppServer, "--scenario=vertical", "--unique-threads"],
            executable: process.execPath,
          },
        }),
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 30_000,
        databaseUrl: databaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        harnesses,
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        runTimeoutMs: 15_000,
      });
      const workspaceId = stack.mainWorkspaceId;
      const oldestThreadId = await stack.createThread({
        home: true,
        modelSelection,
        title: "Old unread Home",
        workspaceId,
      });
      const turn = await stack.sendMessage({
        text: "An incoming answer on an old thread must remain visible in Home.",
        threadId: oldestThreadId,
        workspaceId,
      });
      expect(turn.assistantText).toBe("Completed by Codex.");
      const milestones: Array<{ count: number; initialThreads: number; hasMore: boolean }> = [];
      let created = 1;
      for (const target of [82, 83, 100, 101, 251]) {
        while (created < target) {
          await stack.createThread({
            idempotencyKey: `viewer-thread-${created}`,
            modelSelection,
            title: `Viewer thread ${created}`,
            workspaceId,
          });
          created += 1;
        }
        // Measure the first catalog page with a cold transcript cache. Home warming
        // can merge its off-page thread; the delayed-history case exercises that prefetch.
        const client = await desktopBoundClient(stack, requests, sockets, {
          prefetchHome: false,
          failNextBootstrap: false,
          httpOperations: new Set(),
          transportOperations: new Set(),
        });
        clients.push(client);
        await client.load();
        await vi.waitFor(
          () => {
            const snapshot = client.getSnapshot();
            expect(snapshot.connection).toBe("connected");
            expect(
              snapshot.threads.filter((thread) => thread.workspaceId === workspaceId),
            ).toHaveLength(Math.min(target, 100));
            expect(snapshot.tasks?.window.itemCount).toBe(Math.min(target, 100));
          },
          { timeout: 15_000 },
        );
        const initial = client.getSnapshot();
        milestones.push({
          count: target,
          hasMore: initial.tasks!.window.hasMore,
          initialThreads: initial.threads.filter((thread) => thread.workspaceId === workspaceId)
            .length,
        });
        expect(initial.tasks?.window.hasMore).toBe(target > 100);
        if (target === 251) {
          // Force the formerly racing Home read after measuring the first page.
          // If it completed before that measurement, the count would already be 101.
          await client.loadLatestTranscript(oldestThreadId);
          expect(
            client.getSnapshot().threads.filter((thread) => thread.workspaceId === workspaceId),
          ).toHaveLength(101);
        }
        if (target !== 251) {
          client.dispose();
          clients.pop();
        }
      }

      const reader = clients[0]!;
      while (reader.getSnapshot().tasks?.window.hasMore) {
        await reader.loadEarlierTasks();
      }
      const full = reader.getSnapshot();
      expect(
        full.tasks?.entries.filter(({ thread }) => thread.workspaceId === workspaceId),
      ).toHaveLength(251);
      expect(full.threadReadStates[oldestThreadId]?.unreadSequence).not.toBeNull();
      expect(full.threadReadStates[oldestThreadId]?.readSequence).toBeNull();

      const secondDevice = await desktopBoundClient(stack, requests, sockets);
      clients.push(secondDevice);
      await secondDevice.load();
      await vi.waitFor(() => expect(secondDevice.getSnapshot().connection).toBe("connected"), {
        timeout: 15_000,
      });

      // Force a socket break before another device advances the private marker.
      const readerSocket = sockets.at(-2);
      if (!readerSocket) throw new Error("Reader WebSocket was not recorded");
      readerSocket.terminate();
      const unreadSequence = full.threadReadStates[oldestThreadId]?.unreadSequence;
      if (!unreadSequence) throw new Error("Old thread has no published incoming sequence");
      const marked = await secondDevice.dispatch({
        idempotencyKey: `cross-device-read-${randomUUID()}`,
        threadId: oldestThreadId,
        throughSequence: unreadSequence,
        type: "thread.read.mark",
      });
      expect(marked.type).toBe("thread.read.mark");
      await vi.waitFor(
        () => {
          expect(reader.getSnapshot().threadReadStates[oldestThreadId]?.readSequence).toBe(
            unreadSequence,
          );
        },
        { timeout: 15_000 },
      );

      const beforeInvalid = requests.length;
      await expect(
        reader.dispatch({
          idempotencyKey: `invalid-read-${randomUUID()}`,
          threadId: "not-a-thread-id",
          throughSequence: unreadSequence,
          type: "thread.read.mark",
        }),
      ).rejects.toThrow();
      expect(requests).toHaveLength(beforeInvalid);
      // A refused dispatch must leave the session usable. Under suite load the
      // socket can be mid-reconnect for unrelated reasons, so wait for it.
      await vi.waitFor(() => expect(reader.getSnapshot().connection).toBe("connected"));
      await expect(
        reader.dispatch({
          idempotencyKey: `missing-read-${randomUUID()}`,
          threadId: createId("thread"),
          throughSequence: unreadSequence,
          type: "thread.read.mark",
        }),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(reader.getSnapshot().connection).toBe("connected"));

      const resumedSocket = sockets.at(-1);
      if (!resumedSocket) throw new Error("Resumed reader WebSocket was not recorded");
      resumedSocket.terminate();
      const mute = await stack.api["commands.dispatch"]({
        idempotencyKey: `missed-mute-${randomUUID()}`,
        muted: true,
        type: "workspace.notifications.update",
        workspaceId,
      });
      if (!mute.ok || mute.data.type !== "workspace.notifications.update")
        throw new Error("Mute update failed");
      await vi.waitFor(
        () => {
          expect(reader.getSnapshot().notificationMutes).toContain(workspaceId);
          expect(reader.getSnapshot().connection).toBe("connected");
        },
        { timeout: 15_000 },
      );

      const forbidden = requests.filter(({ path }) =>
        /\/v1\/rpc\/(thread\.readStates\.list|workspace\.notifications\.get)/u.test(path),
      );
      expect(forbidden).toEqual([]);
      expect(requests.some(({ path }) => path.startsWith("/v1/rpc/tasks.list"))).toBe(true);
      const evidenceRoot =
        process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
        join(tmpdir(), "opensteer-home-viewer-sync", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, "viewer-sync.json"),
        JSON.stringify(
          {
            milestones,
            pagedTasks: full.tasks?.entries.filter(
              ({ thread }) => thread.workspaceId === workspaceId,
            ).length,
            olderThreadUnreadBeforeCrossDeviceRead: true,
            olderThreadReadAfterReconnect:
              reader.getSnapshot().threadReadStates[oldestThreadId]?.readSequence ===
              unreadSequence,
            mutedWorkspaceRecoveredOnReconnect: reader
              .getSnapshot()
              .notificationMutes.includes(workspaceId),
            requests: requests.map(({ method, path, status }) => ({
              method,
              operation: path.split("?")[0],
              status,
            })),
          },
          null,
          2,
        ),
      );
      console.info(`Home viewer sync evidence: ${evidenceRoot}`);
    }, 300_000);

    it("does not let a delayed history page erase a live read or newer incoming answer", async () => {
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [fakeCodexAppServer, "--scenario=vertical", "--unique-threads"],
            executable: process.execPath,
          },
        }),
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 30_000,
        databaseUrl: databaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        harnesses,
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        runTimeoutMs: 15_000,
      });
      const workspaceId = stack.mainWorkspaceId;
      const threadId = await stack.createThread({
        home: true,
        modelSelection,
        title: "Delayed history",
        workspaceId,
      });
      await stack.sendMessage({ text: "First published answer.", threadId, workspaceId });
      const failures: BridgeFailures = {
        prefetchHome: true,
        failNextBootstrap: false,
        httpOperations: new Set(),
        transportOperations: new Set(),
      };
      const history = hold("initial Home history prefetch");
      failures.holdResponse = { operation: "/v1/rpc/thread.events.list", enter: history.enter };
      const client = await desktopBoundClient(stack, requests, sockets, failures);
      clients.push(client);
      await client.load();
      await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"), {
        timeout: 15_000,
      });
      const firstUnread = client.getSnapshot().threadReadStates[threadId]?.unreadSequence;
      if (!firstUnread) throw new Error("First answer was not unread");
      // Loading Home starts the prefetch before any explicit activation.
      await history.entered;
      client.activateThread(threadId);
      const mark = await stack.api["commands.dispatch"]({
        idempotencyKey: `racing-mark-${randomUUID()}`,
        threadId,
        throughSequence: firstUnread,
        type: "thread.read.mark",
      });
      if (!mark.ok || mark.data.type !== "thread.read.mark") throw new Error("Read mark failed");
      await vi.waitFor(
        () =>
          expect(client.getSnapshot().threadReadStates[threadId]?.readSequence).toBe(firstUnread),
        {
          timeout: 15_000,
        },
      );
      await stack.sendMessage({ text: "Second published answer.", threadId, workspaceId });
      await vi.waitFor(
        () => {
          const state = client.getSnapshot().threadReadStates[threadId];
          expect(state?.unreadSequence).not.toBe(firstUnread);
          expect(client.getSnapshot().threads.find(({ id }) => id === threadId)?.unread).toBe(true);
        },
        { timeout: 15_000 },
      );
      const newerUnread = client.getSnapshot().threadReadStates[threadId]?.unreadSequence;
      const revisionBeforePage = client.getSnapshot().revision;
      history.release();
      await vi.waitFor(
        () => {
          expect(client.getSnapshot().revision).toBeGreaterThan(revisionBeforePage);
          const state = client.getSnapshot().threadReadStates[threadId];
          expect(state?.readSequence).toBe(firstUnread);
          expect(state?.unreadSequence).toBe(newerUnread);
          expect(client.getSnapshot().threads.find(({ id }) => id === threadId)?.unread).toBe(true);
        },
        { timeout: 15_000 },
      );
      await client.loadLatestTranscript(threadId);
      const evidenceRoot =
        process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
        join(tmpdir(), "opensteer-home-viewer-sync", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, "viewer-page-race.json"),
        JSON.stringify(
          {
            heldOperation: "/v1/rpc/thread.events.list",
            firstReadSequence: firstUnread,
            newerUnreadSequence: newerUnread,
            finalReadSequence: client.getSnapshot().threadReadStates[threadId]?.readSequence,
            finalUnread: client.getSnapshot().threads.find(({ id }) => id === threadId)?.unread,
          },
          null,
          2,
        ),
      );
      console.info(`Home viewer page race evidence: ${evidenceRoot}`);
    }, 120_000);

    it("leaves Connecting after initial transport failure and keeps a healthy channel through later RPC failures", async () => {
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [fakeCodexAppServer, "--scenario=vertical", "--unique-threads"],
            executable: process.execPath,
          },
        }),
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 30_000,
        databaseUrl: databaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        harnesses,
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        runTimeoutMs: 15_000,
      });
      const failures: BridgeFailures = {
        failNextBootstrap: true,
        httpOperations: new Set(),
        transportOperations: new Set(),
      };
      const client = await desktopBoundClient(stack, requests, sockets, failures);
      clients.push(client);
      await expect(client.load()).rejects.toThrow();
      expect(client.getSnapshot().connection).toBe("offline");
      await client.load();
      await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"), {
        timeout: 15_000,
      });
      const path = "/v1/rpc/thread.events.list";
      failures.httpOperations.add(path);
      expect((await client.rpc["thread.events.list"]({ threadId: createId("thread") })).ok).toBe(
        false,
      );
      expect(client.getSnapshot().connection).toBe("connected");
      failures.transportOperations.add(path);
      expect((await client.rpc["thread.events.list"]({ threadId: createId("thread") })).ok).toBe(
        false,
      );
      expect(client.getSnapshot().connection).toBe("connected");
      const evidenceRoot =
        process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
        join(tmpdir(), "opensteer-home-viewer-sync", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, "viewer-transport.json"),
        JSON.stringify(
          {
            afterInitialFailure: "offline",
            afterRetry: client.getSnapshot().connection,
            injectedStatuses: requests.map(({ path: requestPath, status }) => ({
              operation: requestPath.split("?")[0],
              status,
            })),
          },
          null,
          2,
        ),
      );
      console.info(`Home viewer transport evidence: ${evidenceRoot}`);
    }, 90_000);

    it("keeps a member's read marker off another member's subscribed socket", async () => {
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [fakeCodexAppServer, "--scenario=vertical", "--unique-threads"],
            executable: process.execPath,
          },
        }),
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 30_000,
        databaseUrl: databaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        harnesses,
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        runTimeoutMs: 15_000,
      });
      const workspace = await stack.createWorkspace("Shared viewer state");
      const threadId = await stack.createThread({
        modelSelection,
        title: "Member visible thread",
        workspaceId: workspace.id,
      });
      await stack.sendMessage({
        text: "Give both members a published incoming message.",
        threadId,
        workspaceId: workspace.id,
      });
      const invitation = await stack.api["commands.dispatch"]({
        idempotencyKey: `invite-${randomUUID()}`,
        role: "collaborator",
        type: "workspace.invitation.create",
        workspaceId: workspace.id,
      });
      if (!invitation.ok || invitation.data.type !== "workspace.invitation.create")
        throw new Error("Workspace invitation failed");
      const inviteUrl = new URL(invitation.data.invitationUrl);
      const selector = inviteUrl.pathname.split("/").at(-1);
      const verifier = inviteUrl.hash.slice(1);
      if (!selector || !verifier) throw new Error("Invitation URL is incomplete");
      const exchanged = await testRpcRequest(
        stack.hostOrigin,
        "auth.invitation.exchange",
        {
          selector,
          verifier,
        },
        { headers: { origin: stack.hostOrigin.origin } },
      );
      expect(exchanged.status).toBe(200);
      const admissionCookies = responseCookies(exchanged);
      const signedUp = await testRpcRequest(
        stack.hostOrigin,
        "auth.password.signUp",
        {
          email: `viewer-${randomUUID()}@example.test`,
          password: "viewer integration password",
        },
        { headers: { cookie: admissionCookies.join("; "), origin: stack.hostOrigin.origin } },
      );
      expect(signedUp.status).toBe(200);
      const memberCookies = responseCookies(signedUp);
      const accepted = await testRpcRequest(
        stack.hostOrigin,
        "auth.invitation.accept",
        {},
        {
          headers: {
            cookie: [...admissionCookies, ...memberCookies].join("; "),
            origin: stack.hostOrigin.origin,
          },
        },
      );
      expect(accepted.status).toBe(200);
      const memberCookie = memberCookies.join("; ");
      const acceptedBody = (await accepted.json()) as {
        readonly data?: { readonly membership?: { readonly userId?: string } };
      };
      const memberId = UserIdSchema.parse(acceptedBody.data?.membership?.userId);
      const memberClient = await desktopBoundClient(
        stack,
        requests,
        sockets,
        undefined,
        memberCookie,
      );
      clients.push(memberClient);
      await memberClient.load();
      memberClient.activateWorkspace(workspace.id);
      await vi.waitFor(
        () => {
          expect(memberClient.getSnapshot().connection).toBe("connected");
          expect(memberClient.getSnapshot().workspaces.some(({ id }) => id === workspace.id)).toBe(
            true,
          );
          expect(memberClient.getSnapshot().threads.some(({ id }) => id === threadId)).toBe(true);
        },
        { timeout: 15_000 },
      );

      const unfollowed = await stack.createWorkspace("Unfollowed membership tasks");
      const idleTaskId = await stack.createThread({
        modelSelection,
        title: "Idle membership task",
        workspaceId: unfollowed.id,
      });
      const idleTaskVisible = () =>
        memberClient.getSnapshot().tasks?.entries.some(({ thread }) => thread.id === idleTaskId) ??
        false;
      expect(idleTaskVisible()).toBe(false);
      const secondInvitation = await stack.api["commands.dispatch"]({
        idempotencyKey: `invite-unfollowed-${randomUUID()}`,
        role: "collaborator",
        type: "workspace.invitation.create",
        workspaceId: unfollowed.id,
      });
      if (!secondInvitation.ok || secondInvitation.data.type !== "workspace.invitation.create")
        throw new Error("Second invitation failed");
      const secondUrl = new URL(secondInvitation.data.invitationUrl);
      const secondExchange = await testRpcRequest(
        stack.hostOrigin,
        "auth.invitation.exchange",
        { selector: secondUrl.pathname.split("/").at(-1)!, verifier: secondUrl.hash.slice(1) },
        { headers: { cookie: memberCookie, origin: stack.hostOrigin.origin } },
      );
      expect(secondExchange.status).toBe(200);
      const secondAcceptance = await testRpcRequest(
        stack.hostOrigin,
        "auth.invitation.accept",
        {},
        {
          headers: {
            cookie: [...responseCookies(secondExchange), ...memberCookies].join("; "),
            origin: stack.hostOrigin.origin,
          },
        },
      );
      expect(secondAcceptance.status).toBe(200);
      await vi.waitFor(() => expect(idleTaskVisible()).toBe(true), { timeout: 15_000 });
      const acceptedUnfollowedTaskAppeared = idleTaskVisible();
      // No events in this idle Workspace and no subscription to it can repair the list.
      const removed = await stack.api["commands.dispatch"]({
        idempotencyKey: `remove-unfollowed-${randomUUID()}`,
        state: "revoked",
        type: "workspace.member.update",
        userId: memberId,
        workspaceId: unfollowed.id,
      });
      expect(removed.ok).toBe(true);
      await vi.waitFor(() => expect(idleTaskVisible()).toBe(false), { timeout: 15_000 });
      const revokedUnfollowedTaskDisappeared = !idleTaskVisible();

      const ownerFrames: HostToClientMessage[] = [];
      const memberFrames: HostToClientMessage[] = [];
      const ownerSocket = await subscribeRaw(
        stack.hostOrigin,
        stack.sessionCookie,
        workspace.id,
        ownerFrames,
      );
      const memberSocket = await subscribeRaw(
        stack.hostOrigin,
        memberCookie,
        workspace.id,
        memberFrames,
      );
      sockets.push(ownerSocket, memberSocket);
      const ownerSnapshot = ownerFrames.find((frame) => frame.type === "host.snapshot");
      const memberSnapshot = memberFrames.find((frame) => frame.type === "host.snapshot");
      expect(ownerSnapshot).toBeDefined();
      expect(memberSnapshot).toBeDefined();
      if (ownerSnapshot?.type !== "host.snapshot" || memberSnapshot?.type !== "host.snapshot")
        return;
      expect(
        ownerSnapshot.snapshot.readStates.find((state) => state.threadId === threadId)
          ?.readSequence,
      ).toBeNull();
      expect(
        memberSnapshot.snapshot.readStates.find((state) => state.threadId === threadId)
          ?.readSequence,
      ).toBeNull();

      const before = await stack.api["thread.events.list"]({ threadId });
      if (!before.ok || !before.data.readState.unreadSequence)
        throw new Error("Published message has no unread sequence");
      const marked = await stack.api["commands.dispatch"]({
        idempotencyKey: `private-owner-read-${randomUUID()}`,
        threadId,
        throughSequence: before.data.readState.unreadSequence,
        type: "thread.read.mark",
      });
      if (!marked.ok || marked.data.type !== "thread.read.mark")
        throw new Error("Owner read mark failed");
      const readSequence = marked.data.state.readSequence;
      await vi.waitFor(
        () =>
          expect(
            ownerFrames.some(
              (frame) =>
                frame.type === "host.read-states" &&
                frame.states.some(
                  (state) => state.threadId === threadId && state.readSequence === readSequence,
                ),
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );
      memberSocket.send(JSON.stringify({ nonce: "privacy-barrier", type: "client.ping" }));
      await vi.waitFor(
        () =>
          expect(
            memberFrames.some(
              (frame) => frame.type === "host.pong" && frame.nonce === "privacy-barrier",
            ),
          ).toBe(true),
        { timeout: 10_000 },
      );
      expect(
        memberFrames.some(
          (frame) =>
            (frame.type === "host.read-states" &&
              frame.states.some(
                (state) => state.threadId === threadId && state.readSequence === readSequence,
              )) ||
            (frame.type === "host.read-markers" &&
              frame.markers.some(
                (marker) => marker.threadId === threadId && marker.readSequence === readSequence,
              )),
        ),
      ).toBe(false);
      const memberRead = await testRpcData(
        stack.hostOrigin,
        "thread.events.list",
        { threadId },
        {
          headers: { cookie: memberCookie },
        },
      );
      expect(memberRead.readState.readSequence).toBeNull();
      expect(memberClient.getSnapshot().threadReadStates[threadId]?.readSequence).toBeNull();

      const ownerMute = await stack.api["commands.dispatch"]({
        idempotencyKey: `owner-private-mute-${randomUUID()}`,
        muted: true,
        type: "workspace.notifications.update",
        workspaceId: workspace.id,
      });
      if (!ownerMute.ok || ownerMute.data.type !== "workspace.notifications.update")
        throw new Error("Owner mute failed");
      let rotatingCookie = stack.sessionCookie;
      const rotatingClient = await desktopBoundClient(
        stack,
        requests,
        sockets,
        undefined,
        () => rotatingCookie,
      );
      clients.push(rotatingClient);
      await rotatingClient.load();
      rotatingClient.activateWorkspace(workspace.id);
      await vi.waitFor(
        () => {
          expect(rotatingClient.getSnapshot().connection).toBe("connected");
          expect(rotatingClient.getSnapshot().threadReadStates[threadId]?.readSequence).toBe(
            readSequence,
          );
          expect(rotatingClient.getSnapshot().notificationMutes).toContain(workspace.id);
        },
        { timeout: 15_000 },
      );
      rotatingCookie = memberCookie;
      await rotatingClient.reauthenticate();
      expect(rotatingClient.getSnapshot().user?.id).toBe(memberId);
      expect(rotatingClient.getSnapshot().threadReadStates[threadId]?.readSequence).not.toBe(
        readSequence,
      );
      expect(rotatingClient.getSnapshot().notificationMutes).not.toContain(workspace.id);
      rotatingClient.activateWorkspace(workspace.id);
      await vi.waitFor(
        () => {
          expect(rotatingClient.getSnapshot().threadReadStates[threadId]?.readSequence).toBeNull();
          expect(rotatingClient.getSnapshot().threads.some(({ id }) => id === threadId)).toBe(true);
        },
        { timeout: 15_000 },
      );
      const crossViewerPrivateClearedBeforeRevocation =
        rotatingClient.getSnapshot().user?.id === memberId &&
        rotatingClient.getSnapshot().threadReadStates[threadId]?.readSequence === null &&
        !rotatingClient.getSnapshot().notificationMutes.includes(workspace.id);

      const revoked = await stack.api["commands.dispatch"]({
        idempotencyKey: `revoke-viewer-${randomUUID()}`,
        state: "revoked",
        type: "workspace.member.update",
        userId: memberId,
        workspaceId: workspace.id,
      });
      if (!revoked.ok || revoked.data.type !== "workspace.member.update")
        throw new Error("Workspace member revocation failed");
      await vi.waitFor(
        () => {
          const view = memberClient.getSnapshot();
          expect(view.connection).toBe("connected");
          expect(view.homeWorkspaceId).not.toBe(workspace.id);
          expect(view.workspaces.some(({ id }) => id === workspace.id)).toBe(false);
          expect(view.threads.some(({ id }) => id === threadId)).toBe(false);
          expect(view.threadReadStates[threadId]).toBeUndefined();
        },
        { timeout: 15_000 },
      );
      const socketCountAfterRevocation = sockets.length;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(sockets).toHaveLength(socketCountAfterRevocation);
      const evidenceRoot =
        process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
        join(tmpdir(), "opensteer-home-viewer-sync", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, "viewer-privacy.json"),
        JSON.stringify(
          {
            acceptedUnfollowedTaskAppeared,
            revokedUnfollowedTaskDisappeared,
            ownerPrivateUpdateFrames: ownerFrames.filter(
              (frame) => frame.type === "host.read-states",
            ).length,
            memberPrivateUpdateFrames: memberFrames.filter(
              (frame) => frame.type === "host.read-states" || frame.type === "host.read-markers",
            ).length,
            memberReadSequenceStayedNull: memberRead.readState.readSequence === null,
            crossViewerReauthenticationClearedPrivateState:
              crossViewerPrivateClearedBeforeRevocation,
            revokedWorkspaceRemovedFromMember: !memberClient
              .getSnapshot()
              .workspaces.some(({ id }) => id === workspace.id),
            memberHomeStillConnected: memberClient.getSnapshot().connection === "connected",
            socketsOpenedAfterRevocation: sockets.length - socketCountAfterRevocation,
          },
          null,
          2,
        ),
      );
      console.info(`Home viewer privacy evidence: ${evidenceRoot}`);
    }, 120_000);

    it("reads older active work through tasks.list and the shared client beyond 100 idle tasks", async () => {
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [fakeCodexAppServer, "--scenario=vertical", "--unique-threads"],
            executable: process.execPath,
          },
        }),
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 30_000,
        databaseUrl: databaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        harnesses,
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        runTimeoutMs: 15_000,
      });
      const research = await stack.createWorkspace("Older active workspace");
      const running = await stack.createThread({
        modelSelection,
        title: "Older running",
        workspaceId: research.id,
      });
      const waiting = await stack.createThread({
        modelSelection,
        title: "Older waiting",
        workspaceId: research.id,
      });
      await stack.host.store.database
        .updateTable("threads")
        .set({ status: "running", updatedAt: new Date("2026-01-01T00:00:00Z") })
        .where("id", "=", running)
        .execute();
      await stack.host.store.database
        .updateTable("threads")
        .set({ status: "waiting", updatedAt: new Date("2026-01-01T00:00:00Z") })
        .where("id", "=", waiting)
        .execute();
      for (let n = 0; n < 100; n++)
        await stack.createThread({
          modelSelection,
          title: `Newer idle ${n}`,
          workspaceId: stack.mainWorkspaceId,
        });
      const first = await testRpcData(
        stack.hostOrigin,
        "tasks.list",
        { active: true, limit: 1 },
        { headers: { cookie: stack.sessionCookie } },
      );
      expect(first.window).toMatchObject({ hasMore: true, totalItems: 2 });
      const second = await testRpcData(
        stack.hostOrigin,
        "tasks.list",
        { active: true, before: first.window.nextBefore!, limit: 1 },
        { headers: { cookie: stack.sessionCookie } },
      );
      expect(new Set([...first.tasks, ...second.tasks].map(({ thread }) => thread.id))).toEqual(
        new Set([running, waiting]),
      );
      expect(second.window.hasMore).toBe(false);
      const reader = await desktopBoundClient(stack, requests, sockets);
      clients.push(reader);
      await reader.load();
      await vi.waitFor(() => expect(reader.getSnapshot().activeTasks).toHaveLength(2), {
        timeout: 15_000,
      });
      expect(reader.getSnapshot().tasks?.entries).toHaveLength(100);
      expect(reader.getSnapshot().tasks?.window.hasMore).toBe(true);
      expect(reader.getSnapshot().tasks?.entries.some(({ thread }) => thread.id === running)).toBe(
        false,
      );
      const evidenceRoot =
        process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
        join(tmpdir(), "opensteer-active-tasks", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, "active-tasks.json"),
        JSON.stringify(
          {
            running,
            waiting,
            activeTasks: reader.getSnapshot().activeTasks,
            historyWindow: reader.getSnapshot().tasks?.window,
            activeRpcPages: [first, second],
          },
          null,
          2,
        ),
      );
      console.info(`Active task evidence: ${evidenceRoot}`);
    }, 120_000);

    it("keeps every device's task list current across Workspaces it does not follow, without polling", async () => {
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [fakeCodexAppServer, "--scenario=vertical", "--unique-threads"],
            executable: process.execPath,
          },
        }),
      );
      stack = await startVerticalStack({
        catalogTimeoutMs: 30_000,
        databaseUrl: databaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        harnesses,
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        runTimeoutMs: 15_000,
      });
      const chatId = await stack.createThread({
        home: true,
        modelSelection,
        title: "Chat",
        workspaceId: stack.mainWorkspaceId,
      });
      const research = await stack.createWorkspace("Research");
      const taskId = await stack.createThread({
        modelSelection,
        title: "Find a venue",
        workspaceId: research.id,
      });
      const entryOf = (client: ViewerClient) =>
        client.getSnapshot().tasks?.entries.find(({ thread }) => thread.id === taskId);

      // Both devices follow only Main; the task lives in a Workspace neither follows.
      const failures: BridgeFailures = {
        failNextBootstrap: false,
        httpOperations: new Set(),
        transportOperations: new Set(),
      };
      const reader = await desktopBoundClient(stack, requests, sockets, failures);
      clients.push(reader);
      await reader.load();
      await vi.waitFor(
        () => {
          const ids = reader.getSnapshot().tasks?.entries.map(({ thread }) => thread.id);
          expect(ids).toEqual(expect.arrayContaining([chatId, taskId]));
        },
        { timeout: 15_000 },
      );
      expect(entryOf(reader)?.lastReply).toBeNull();
      const otherDevice = await desktopBoundClient(stack, requests, sockets);
      clients.push(otherDevice);
      await otherDevice.load();
      await vi.waitFor(() => expect(entryOf(otherDevice)).toBeDefined(), { timeout: 15_000 });

      const turn = await stack.sendMessage({
        text: "Find a venue for twelve.",
        threadId: taskId,
        workspaceId: research.id,
      });
      expect(turn.assistantText).toBe("Completed by Codex.");
      for (const client of [reader, otherDevice]) {
        await vi.waitFor(
          () => {
            expect(entryOf(client)).toMatchObject({
              failure: null,
              lastReply: "Completed by Codex.",
              thread: { status: "idle", workspaceId: research.id },
            });
            const state = client.getSnapshot().threadReadStates[taskId];
            expect(state?.unreadSequence).not.toBeNull();
            expect(state?.readSequence).toBeNull();
          },
          { timeout: 15_000 },
        );
      }

      const done = await reader.setTaskDone(taskId, true);
      expect(done.doneAt).not.toBeNull();
      // Done is the task's, so the other device sees it; reading stays each device's own.
      for (const client of [reader, otherDevice]) {
        await vi.waitFor(() => expect(entryOf(client)?.thread.doneAt).toBe(done.doneAt), {
          timeout: 15_000,
        });
        expect(client.getSnapshot().threadReadStates[taskId]?.readSequence).toBeNull();
      }
      const doneOnOtherDevice = entryOf(otherDevice)?.thread.doneAt ?? null;

      const history = hold("Done task history");
      failures.holdResponse = { operation: "/v1/rpc/thread.events.list", enter: history.enter };
      // History read while the task is Done lands only after the other device reopens it.
      const staleHistory = reader.loadLatestTranscript(taskId);
      await history.entered;
      await otherDevice.setTaskDone(taskId, false);
      await vi.waitFor(() => expect(entryOf(reader)?.thread.doneAt).toBeNull(), {
        timeout: 15_000,
      });
      history.release();
      await staleHistory;
      expect(entryOf(reader)?.thread.doneAt).toBeNull();
      expect(reader.getSnapshot().threads.find(({ id }) => id === taskId)?.doneAt ?? null).toBe(
        null,
      );

      const taskReads = requests.filter(({ path }) => path.startsWith("/v1/rpc/tasks.list"));
      expect(taskReads.every(({ status }) => status === 200)).toBe(true);
      expect(requests.some(({ path }) => path.startsWith("/v1/rpc/bootstrap.get"))).toBe(true);
      const evidenceRoot =
        process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
        join(tmpdir(), "opensteer-home-viewer-sync", randomUUID());
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, "task-list-sync.json"),
        JSON.stringify(
          {
            taskWorkspaceFollowedByEitherDevice: false,
            lastReplyOnBothDevices: [reader, otherDevice].map(
              (client) => entryOf(client)?.lastReply,
            ),
            doneSeenByOtherDevice: doneOnOtherDevice,
            doneSeenByReaderAfterReopen: entryOf(reader)?.thread.doneAt ?? null,
            staleHistoryPreservedReopen: entryOf(reader)?.thread.doneAt === null,
            taskListReads: taskReads.length,
            requests: requests.map(({ method, path, status }) => ({
              method,
              operation: path.split("?")[0],
              status,
            })),
          },
          null,
          2,
        ),
      );
      console.info(`Task list sync evidence: ${evidenceRoot}`);
    }, 180_000);
  },
);

function responseCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0]!)
    .filter(Boolean);
}

async function subscribeRaw(
  origin: URL,
  cookie: string,
  workspaceId: string,
  frames: HostToClientMessage[],
): Promise<WebSocket> {
  const url = new URL("/v1/realtime", origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, { headers: { cookie, origin: origin.origin } });
  socket.on("message", (raw) =>
    frames.push(HostToClientMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      afterSequence: zeroSequence,
      apiVersion: hostApiVersion,
      threadId: null,
      type: "client.subscribe",
      workspaceId,
    }),
  );
  await vi.waitFor(
    () => expect(frames.some((frame) => frame.type === "host.synchronized")).toBe(true),
    {
      timeout: 10_000,
    },
  );
  return socket;
}

async function desktopBoundClient(
  stack: VerticalStack,
  requests: Array<{ method: string; path: string; status: number }>,
  sockets: WebSocket[],
  failures?: BridgeFailures,
  sessionCookie: string | (() => string) = stack.sessionCookie,
): Promise<ViewerClient> {
  // Host's project cannot statically import Web's source tree. Vitest resolves
  // the production renderer adapter at runtime while Host typechecks remain scoped.
  const modulePath = "../../../web/src/desktop/desktop-host-transport.js";
  const { createDesktopHostFetch } = (await import(modulePath)) as {
    createDesktopHostFetch: (
      bridge: OpensteerDesktopBridge,
      canonicalOrigin: string,
    ) => typeof globalThis.fetch;
  };
  const clientModulePath = "@opensteer/client/host";
  const { HttpHostClient } = (await import(clientModulePath)) as {
    HttpHostClient: new (options: {
      readonly prefetchHome?: boolean;
      readonly capabilities?: readonly string[];
      readonly baseUrl: URL;
      readonly fetch: typeof globalThis.fetch;
      readonly reconnectBaseDelayMs: number;
      readonly reconnectMaxDelayMs: number;
      readonly refreshIntervalMs: number;
      readonly webSocketFactory: (url: string) => unknown;
    }) => ViewerClient;
  };
  const bridge = {
    hostRequest: async (input: unknown) => {
      const request = DesktopHostHttpRequestSchema.parse(input);
      const operation = request.path.split("?")[0]!;
      if (operation === "/v1/rpc/bootstrap.get" && failures?.failNextBootstrap) {
        failures.failNextBootstrap = false;
        requests.push({ method: request.method, path: request.path, status: 0 });
        throw new Error("Injected initial bridge transport failure");
      }
      if (failures?.transportOperations.delete(operation)) {
        requests.push({ method: request.method, path: request.path, status: 0 });
        throw new Error("Injected operation transport failure");
      }
      if (failures?.httpOperations.delete(operation)) {
        requests.push({ method: request.method, path: request.path, status: 500 });
        return {
          data: DesktopHostHttpResponseSchema.parse({
            body: JSON.stringify({
              error: { code: "internal", message: "Injected operation failure", retryable: true },
              ok: false,
            }),
            headers: { contentType: "application/json" },
            status: 500,
          }),
          ok: true,
        };
      }
      const currentCookie = typeof sessionCookie === "string" ? sessionCookie : sessionCookie();
      const headers = new Headers({ cookie: currentCookie, origin: stack.hostOrigin.origin });
      if (request.headers.accept) headers.set("accept", request.headers.accept);
      if (request.headers.apiVersion)
        headers.set("x-opensteer-api-version", request.headers.apiVersion);
      if (request.headers.contentType) headers.set("content-type", request.headers.contentType);
      if (request.headers.idempotencyKey)
        headers.set("idempotency-key", request.headers.idempotencyKey);
      const response = await fetch(new URL(request.path, stack.hostOrigin), {
        ...(request.body === undefined ? {} : { body: request.body }),
        headers,
        method: request.method,
      });
      requests.push({ method: request.method, path: request.path, status: response.status });
      const body = await response.text();
      const gate = failures?.holdResponse;
      if (gate?.operation === operation && failures) {
        delete failures.holdResponse;
        await gate.enter();
      }
      return {
        data: DesktopHostHttpResponseSchema.parse({
          body,
          headers: { contentType: response.headers.get("content-type") },
          status: response.status,
        }),
        ok: true,
      };
    },
  } as unknown as OpensteerDesktopBridge;
  return new HttpHostClient({
    prefetchHome: failures?.prefetchHome === true,
    baseUrl: stack.hostOrigin,
    capabilities: ["shared-task-done-v1"],
    fetch: createDesktopHostFetch(bridge, stack.hostOrigin.origin),
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 100,
    refreshIntervalMs: 0,
    webSocketFactory: (url) => {
      const currentCookie = typeof sessionCookie === "string" ? sessionCookie : sessionCookie();
      const socket = new WebSocket(url, {
        headers: { cookie: currentCookie, origin: stack.hostOrigin.origin },
      });
      sockets.push(socket);
      return socket;
    },
  });
}
