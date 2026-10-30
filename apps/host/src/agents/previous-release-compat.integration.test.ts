import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId, ModelSelectionSchema } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { HttpHostClient, taskCanBeDone, taskList } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  HostToClientMessageSchema,
  HostToRunnerMessageSchema,
  type WorkspaceSnapshot,
} from "@opensteer/protocol";
import type { HostClient } from "@opensteer/client/host";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  previousPublicRelease,
  releasedClientReader,
} from "./previous-release-reader.test-support.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const evidence =
  process.env.OPENSTEER_PREVIOUS_RELEASE_EVIDENCE_DIR ??
  join(tmpdir(), "opensteer-previous-release", randomUUID());
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

// Failure modes: descriptor/header/subscription epoch mismatch; removed required read
// fields; additive fields rejected by released readers; old command reinterpreted;
// stale read-state responses; missing cross-viewer notices; Done without a capability.
integration.sequential("previous public release client journeys", () => {
  let stack: VerticalStack | undefined;
  const clients: HostClient[] = [];
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await stack?.close();
    stack = undefined;
    for (const close of cleanups.splice(0)) await close();
  }, 60_000);

  for (const revision of [previousPublicRelease]) {
    it(`serves discovery, subscription, reads and ordinary mutations to ${revision}`, async () => {
      const released = await releasedClientReader(revision);
      cleanups.push(released.close);
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(
        new CodexHarnessDriver({
          launch: {
            arguments: [
              fileURLToPath(
                new URL(
                  "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
                  import.meta.url,
                ),
              ),
              "--scenario=notifications",
              "--unique-threads",
            ],
            executable: process.execPath,
          },
        }),
      );
      stack = await startVerticalStack({
        databaseUrl: databaseUrl!,
        runnerWire: {},
        harnesses,
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "isolated",
        },
        catalogTimeoutMs: 30_000,
        runTimeoutMs: 15_000,
      });
      const active = stack;
      const transcript: unknown[] = [
        { readerRevision: released.sourceRevision, hostRevision: released.hostRevision },
      ];
      let commandRequests = 0;
      await mkdir(evidence, { recursive: true });
      try {
        const descriptor = await (
          await fetch(new URL("/.well-known/opensteer", active.hostOrigin))
        ).json();
        transcript.push({ descriptor });
        expect(released.reader.HostDescriptorSchema.parse(descriptor).apiVersion).toBe(48);
        expect(released.reader.hostApiCompatibility(descriptor)).toBe("compatible");
        // As each release's deployment catalog does: the client keeps the
        // advertised capabilities it knows, and newer ones are noise to it.
        const releasedCapabilities = released.reader.knownHostCapabilities(
          released.reader.HostDescriptorSchema.parse(descriptor).capabilities,
        );
        // The launch client already sets shared Done itself.
        expect(releasedCapabilities).toContain("shared-task-done-v1");
        expect(releasedCapabilities).not.toContain("snapshot-messages-omit-v1");
        const threadId = await active.createThread({
          modelSelection,
          title: "Previous release compatibility",
          workspaceId: active.mainWorkspaceId,
        });
        await active.sendMessage({
          text: "History for the released subscriber",
          threadId,
          workspaceId: active.mainWorkspaceId,
        });
        const snapshots: WorkspaceSnapshot[] = [];
        const headers = { cookie: active.sessionCookie, origin: active.hostOrigin.origin };
        const transport: typeof fetch = async (input, init) => {
          const request = new Request(
            input instanceof Request ? input : new URL(String(input), active.hostOrigin),
            init,
          );
          for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
          if (request.url.endsWith("/commands.dispatch")) commandRequests += 1;
          const response = await fetch(request);
          if (request.url.includes("/v1/rpc/"))
            transcript.push({ request: request.url, response: await response.clone().json() });
          return response;
        };
        const sockets: WebSocket[] = [];
        const readerErrors: unknown[] = [];
        const options = {
          baseUrl: active.hostOrigin,
          capabilities: releasedCapabilities,
          fetch: transport,
          refreshIntervalMs: 0,
          webSocketFactory: (url: string) => {
            const socket = new WebSocket(url, { headers });
            sockets.push(socket);
            socket.on("message", (data) => {
              const message = JSON.parse(data.toString());
              try {
                released.reader.HostToClientMessageSchema.parse(message);
                const frame = HostToClientMessageSchema.parse(message);
                if (frame.type === "host.snapshot") snapshots.push(frame.snapshot);
              } catch (error) {
                readerErrors.push(error);
              }
              transcript.push({ realtime: message });
            });
            return socket;
          },
        };
        const old = new released.reader.HttpHostClient(options);
        clients.push(old);
        await old.load();
        await vi.waitFor(() => expect(old.getSnapshot().connection).toBe("connected"), {
          timeout: 15_000,
        });
        expect(snapshots.length).toBeGreaterThan(0);
        expect(snapshots.every((snapshot) => snapshot.messagesOmitted === undefined)).toBe(true);
        expect(snapshots.flatMap((snapshot) => snapshot.messages)).toContainEqual(
          expect.objectContaining({ threadId }),
        );
        old.activateWorkspace(active.mainWorkspaceId);
        old.activateThread(threadId);
        await old.loadLatestTranscript(threadId);
        await old.renameThread(threadId, "Renamed by released client");
        await active.sendMessage({
          text: "Compatibility reply",
          threadId,
          workspaceId: active.mainWorkspaceId,
        });
        await old.loadLatestTranscript(threadId);
        await vi.waitFor(() => expect(old.getSnapshot().threadReadStates[threadId]).toBeDefined());
        const beforeRead = old.getSnapshot().threadReadStates[threadId]!;
        transcript.push({ beforeRead });
        // The Host still serves epoch-48 placement; 0.1.219 drops it while merging,
        // so read it from what the Host answers this client.
        const hostReadState = async (client: HostClient) => {
          const result = await client.rpc["thread.readState.get"]({ threadId });
          if (!result.ok) throw new Error(result.error.message);
          return result.data;
        };
        expect(beforeRead.readSequence).toBeNull();
        expect((await hostReadState(old)).placement).toBeNull();
        expect(beforeRead.unreadSequence).not.toBeNull();
        await old.markThreadRead(threadId, beforeRead.unreadSequence!);
        await vi.waitFor(() =>
          expect(old.getSnapshot().threadReadStates[threadId]?.readSequence).toBe(
            beforeRead.unreadSequence,
          ),
        );
        const stale = old.getSnapshot().threadReadStates[threadId];
        transcript.push({ stale });
        const CurrentClient = HttpHostClient as unknown as typeof released.reader.HttpHostClient;
        const current = new CurrentClient({
          ...options,
          // Simulate an older Host's advertisement. Its actual released
          // strict request reader must accept every frame from this client.
          capabilities: releasedCapabilities,
          webSocketFactory: (url: string) => {
            const socket = options.webSocketFactory(url);
            socket.binaryType = "arraybuffer";
            return {
              binaryType: "arraybuffer" as const,
              get readyState() {
                return socket.readyState;
              },
              addEventListener: socket.addEventListener.bind(socket),
              close: socket.close.bind(socket),
              send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
                if (typeof data !== "string") throw new Error("Expected JSON client frame");
                released.reader.ClientToHostMessageSchema.parse(JSON.parse(data));
                socket.send(data);
              },
            };
          },
        });
        clients.push(current);
        await current.load();
        await vi.waitFor(() => expect(current.getSnapshot().connection).toBe("connected"), {
          timeout: 15_000,
        });
        current.activateWorkspace(active.mainWorkspaceId);
        current.activateThread(threadId);
        const ordinary = await old.dispatch({
          type: "thread.sendMessage",
          content: [{ type: "text", text: "Sent by the released client" }],
          idempotencyKey: `released-send-${revision}`,
          threadId,
        });
        if (ordinary.type !== "thread.sendMessage" || !ordinary.run)
          throw new Error("No released-client Run");
        await vi.waitFor(
          async () =>
            expect(
              await active.host.store.database
                .selectFrom("runs")
                .select("status")
                .where("id", "=", ordinary.run!.id)
                .executeTakeFirst(),
            ).toEqual({ status: "completed" }),
          { timeout: 15_000 },
        );

        // A read task older than a day remains open in the released list.
        await active.host.store.database
          .updateTable("threads")
          .set({ updatedAt: new Date(Date.now() - 48 * 3_600_000) })
          .where("id", "=", threadId)
          .execute();
        await old.loadWorkspaceTasks(active.mainWorkspaceId);
        const aged = old
          .getSnapshot()
          .workspaceTasks[active.mainWorkspaceId]!.entries.find(
            ({ thread }) => thread.id === threadId,
          )!;
        expect(Date.parse(aged.thread.updatedAt)).toBeLessThan(Date.now() - 24 * 3_600_000);
        const agedList = released.reader.workspaceTaskList(
          old.getSnapshot(),
          active.mainWorkspaceId,
        );
        expect(agedList.done.some((row) => row.threadId === threadId)).toBe(false);
        // An open task stays working or ready.
        expect(
          [...agedList.working, ...agedList.ready].some((row) => row.threadId === threadId),
        ).toBe(true);

        // A second member has independent actual read markers and a real signed-in subscription.
        const ownerId = current.getSnapshot().user!.id;
        const memberId = await active.host.store.createUser("Previous release collaborator");
        const tokenHash = `sha256:${randomUUID()}`;
        const invitation = await active.host.store.createWorkspaceInvitation({
          createdBy: ownerId,
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: randomUUID(),
          intendedEmail: null,
          requestFingerprint: `sha256:${randomUUID()}`,
          role: "collaborator",
          selector: randomUUID(),
          tokenHash,
          type: "link",
          workspaceId: active.mainWorkspaceId,
        });
        await active.host.store.acceptWorkspaceInvitation({
          selector: invitation.selector,
          tokenHash,
          userEmail: "previous-release@example.test",
          userEmailVerified: true,
          userId: memberId,
        });
        const ownerSession = await active.host.store.database
          .selectFrom("authSessions")
          .selectAll()
          .where("userId", "=", ownerId)
          .executeTakeFirstOrThrow();
        const token = randomUUID();
        await active.host.store.database
          .insertInto("authSessions")
          .values({ ...ownerSession, id: createId("authSession"), userId: memberId, token })
          .execute();
        const signature = createHmac("sha256", "vertical-auth-secret".padEnd(40, "x"))
          .update(token)
          .digest("base64");
        const memberHeaders = {
          ...headers,
          cookie: `opensteer.session=${encodeURIComponent(`${token}.${signature}`)}`,
        };
        const member = new released.reader.HttpHostClient({
          ...options,
          fetch: (input, init) => {
            const request = new Request(
              input instanceof Request ? input : new URL(String(input), active.hostOrigin),
              init,
            );
            for (const [key, value] of Object.entries(memberHeaders))
              request.headers.set(key, value);
            return fetch(request);
          },
          webSocketFactory: (url) => {
            const socket = new WebSocket(url, { headers: memberHeaders });
            socket.on("message", (data) => {
              const message = JSON.parse(data.toString());
              try {
                released.reader.HostToClientMessageSchema.parse(message);
              } catch (error) {
                readerErrors.push(error);
              }
              transcript.push({ memberRealtime: message });
            });
            return socket;
          },
        });
        clients.push(member);
        await member.load();
        member.activateWorkspace(active.mainWorkspaceId);
        member.activateThread(threadId);
        await member.loadLatestTranscript(threadId);
        await member.markThreadRead(threadId, beforeRead.unreadSequence!);
        await vi.waitFor(() => expect(member.getSnapshot().connection).toBe("connected"), {
          timeout: 15_000,
        });

        // The real Runner opens a pending approval; shared Done must cancel it readably.
        const asking = await old.dispatch({
          type: "thread.sendMessage",
          content: [{ type: "text", text: "[[ask]]" }],
          idempotencyKey: `released-ask-${revision}`,
          threadId,
        });
        if (asking.type !== "thread.sendMessage" || !asking.run) throw new Error("No approval Run");
        const askingRunId = asking.run.id;
        await vi.waitFor(
          () =>
            expect(
              old.getSnapshot().requests[threadId]?.some((request) => request.status === "pending"),
            ).toBe(true),
          { timeout: 15_000 },
        );
        const request = old
          .getSnapshot()
          .requests[threadId]!.find((item) => item.status === "pending")!;
        const execution = active
          .wire!.frames.map(({ frame }) => frame)
          .filter((frame) => frame.type === "host.command")
          .map((frame) => HostToRunnerMessageSchema.parse(frame))
          .find(
            (frame) =>
              frame.type === "host.command" &&
              frame.command.type === "run.execute" &&
              frame.command.context.runId === askingRunId,
          );
        if (execution?.type !== "host.command" || execution.command.type !== "run.execute")
          throw new Error("No execution frame");
        const control = execution.command.context.agentControl;
        const callControl = async (body: object) => {
          const response = await fetch(control.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${control.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ ...body, requestId: randomUUID() }),
          });
          expect(response.status, await response.clone().text()).toBe(200);
          return response.json();
        };
        const runner = await active.host.store.database
          .selectFrom("runners")
          .select(["id", "capabilities"])
          .executeTakeFirstOrThrow();
        await active.host.store.database
          .updateTable("runners")
          .set({
            capabilities: sql<typeof runner.capabilities>`${JSON.stringify(
              runner.capabilities.filter((capability) => capability !== "task-done-v1"),
            )}::jsonb`,
          })
          .where("id", "=", runner.id)
          .execute();
        const oldRunnerList = await callControl({ type: "thread.list" });
        released.reader.AgentControlResponseSchema.parse(oldRunnerList);
        transcript.push({ oldRunnerList });
        expect(
          oldRunnerList.threads.every((thread: Record<string, unknown>) => !("doneAt" in thread)),
        ).toBe(true);
        await active.host.store.database
          .updateTable("runners")
          .set({
            capabilities: sql<
              typeof runner.capabilities
            >`${JSON.stringify(runner.capabilities)}::jsonb`,
          })
          .where("id", "=", runner.id)
          .execute();
        const newRunnerList = await callControl({ type: "thread.list" });
        expect(
          newRunnerList.threads.every((thread: Record<string, unknown>) => "doneAt" in thread),
        ).toBe(true);
        const delegated = await callControl({
          type: "thread.delegate",
          task: "[[hold]]",
          title: "Compatibility delegate",
          workspaceId: active.mainWorkspaceId,
        });
        const delegatedThreadId = delegated.result.thread.id;
        transcript.push({ newRunnerList, delegated });

        await current.dispatch({
          type: "thread.shared-done.set",
          threadId,
          done: true,
          idempotencyKey: `shared-done-${revision}`,
        });
        const cancelled = await active.host.store.requests.get(request.id);
        expect(cancelled).toMatchObject({
          status: "cancelled",
          cancellationReason: "thread-archived",
        });
        released.reader.RequestViewSchema.parse(cancelled);
        expect(
          (await active.host.store.getThreadForOwner(delegatedThreadId, ownerId))?.doneAt,
        ).not.toBeNull();
        transcript.push({ cancelled });
        // The launch client shows Done from the Thread, not epoch-48 placement.
        const releasedDoneAt = (client: HostClient) =>
          released.reader.heldThread(client.getSnapshot(), threadId)?.doneAt;
        await vi.waitFor(() => expect(releasedDoneAt(old)).toEqual(expect.any(String)));
        await vi.waitFor(() => expect(releasedDoneAt(member)).toEqual(expect.any(String)));
        for (const client of [old, member])
          await vi.waitFor(async () =>
            expect(await hostReadState(client)).toMatchObject({ placement: { done: true } }),
          );
        const afterDoneHost = await hostReadState(old);
        expect(afterDoneHost.placementRevision).toBe(afterDoneHost.asOfSequence);
        const afterDone = old.getSnapshot().threadReadStates[threadId]!;
        expect(released.reader.mergeThreadReadState(afterDone, stale)).toMatchObject({
          readSequence: afterDone.readSequence,
          asOfSequence: afterDone.asOfSequence,
        });
        await current.setTaskDone(threadId, false);
        await vi.waitFor(() => expect(releasedDoneAt(old)).toBeNull());
        await vi.waitFor(() => expect(releasedDoneAt(member)).toBeNull());
        for (const client of [old, member])
          await vi.waitFor(async () =>
            expect(await hostReadState(client)).toMatchObject({ placement: { done: false } }),
          );
        // Only what a Done command could write: the shared fact and Done command
        // receipts. The waiting Run keeps touching the Thread row and event head,
        // and the active released client may advance its read marker meanwhile.
        const durable = async () => ({
          doneAt: (
            await active.host.store.database
              .selectFrom("threads")
              .select("doneAt")
              .where("id", "=", threadId)
              .executeTakeFirstOrThrow()
          ).doneAt,
          doneCommands: await active.host.store.database
            .selectFrom("commands")
            .select(["id", "type", "idempotencyKey", "status"])
            .where("threadId", "=", threadId)
            .where("type", "in", ["thread.done.set", "thread.shared-done.set"])
            .orderBy("id")
            .execute(),
        });
        const beforeRefusal = await durable();
        for (const key of [`shared-done-${revision}`, `legacy-${revision}`]) {
          const result = await old.rpc["commands.dispatch"]({
            type: "thread.done.set",
            threadId,
            done: true,
            idempotencyKey: key,
          });
          expect(result).toMatchObject({
            ok: false,
            error: { code: "bad_request", reason: "shared-task-done-required", retryable: false },
          });
        }
        expect(
          (await current.loadLatestTranscript(threadId),
          current.getSnapshot().threads.find(({ id }) => id === threadId)?.doneAt),
        ).toBeNull();
        expect(await durable()).toEqual(beforeRefusal);
        expect(
          await active.host.store.database
            .selectFrom("commands")
            .select("id")
            .where("idempotencyKey", "=", `legacy-${revision}`)
            .execute(),
        ).toEqual([]);
        // The released client's own Done is shared Done, and so is its Reopen.
        expect((await old.setTaskDone(threadId, true)).doneAt).toEqual(expect.any(String));
        expect((await durable()).doneAt).toEqual(expect.any(Date));
        expect((await old.setTaskDone(threadId, false)).doneAt).toBeNull();
        expect((await durable()).doneAt).toBeNull();
        const noCapability = new CurrentClient({
          ...options,
          capabilities: [],
        });
        clients.push(noCapability);
        await noCapability.load();
        await noCapability.loadWorkspaceTasks(active.mainWorkspaceId);
        const noCapabilityThread = current.getSnapshot().threads.find(({ id }) => id === threadId)!;
        expect(taskCanBeDone(noCapability.getSnapshot(), noCapabilityThread)).toBe(false);
        expect(taskList(noCapability.getSnapshot()).done).toHaveLength(0);
        const beforeUnsupported = commandRequests;
        await expect(noCapability.setTaskDone(threadId, true)).rejects.toThrow(
          "does not support shared task Done",
        );
        expect(commandRequests).toBe(beforeUnsupported);
        const preview = new MockHostClient({ latencyMs: 0, sharedTaskDoneAvailable: false });
        clients.push(preview);
        const previewTask = preview
          .getSnapshot()
          .threads.find(
            ({ role, id }) => role === "work" && id !== preview.getSnapshot().homeThreadId,
          )!;
        await expect(preview.setTaskDone(previewTask.id, true)).rejects.toThrow(
          "does not support shared task Done",
        );
        expect(taskCanBeDone(preview.getSnapshot(), previewTask)).toBe(false);
        expect(readerErrors).toEqual([]);
        sockets[0]?.terminate();
        await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(3), { timeout: 15_000 });
        await vi.waitFor(() => expect(old.getSnapshot().connection).toBe("connected"), {
          timeout: 15_000,
        });
      } finally {
        await writeFile(
          join(evidence, `${revision}.json`),
          JSON.stringify(transcript, null, 2) + "\n",
        );
        console.info(`Previous release transcript: ${join(evidence, `${revision}.json`)}`);
      }
    }, 120_000);
  }
});
