import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createId, zeroSequence, type MessageId, type RunId } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { CommandService, KeyedAdmissionQueue, RealtimeHub } from "@opensteer/orchestration";
import { HostToClientMessageSchema, type HostToClientMessage } from "@opensteer/protocol";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import {
  describeStore,
  testModelSelection,
  pendingEvent,
} from "@opensteer/database/test-support/store";
import { expect, vi } from "vitest";
import {
  AgentControlService,
  type AgentControlRunScope,
  type AgentControlTokenService,
} from "../agents/agent-control-service.js";
import { createHostServer } from "../server.js";
import { hostServerTestDependencies } from "../server/host-server-test-harness.js";
import { testHostApiContext } from "../server/test-host-api-context.js";
import { testRpcRequest } from "../server/test-host-api-request.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { ScreenPresentationService } from "./screen-presentation-service.js";

/** Real PostgreSQL and the production HTTP/socket/command/tool boundaries; execution is explicitly driven. */
describeStore("screen presentation authority", (it) => {
  it("binds before wakeup and HTTP return, uses one exact socket, and cannot rebind a retry", async ({
    storeFixture: f,
  }) => {
    const fixture = await f.createRunFixture("screen-human");
    const { thread } = await f.store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      home: true,
      idempotencyKey: "screen-home",
      modelSelection: testModelSelection,
      title: "Chat",
      workspaceId: fixture.workspace.id,
    });
    await f.database
      .updateTable("runners")
      .set({ capabilities: sql`${JSON.stringify(["screen-show-v1", "steer-answer-v1"])}::jsonb` })
      .where("id", "=", fixture.runnerId)
      .execute();
    const session = testHostApiContext(fixture.userId).session!;
    const secondUser = await f.store.createUser("Other person");
    const otherSession = testHostApiContext(secondUser).session!;
    const screen = new ScreenPresentationService({
      store: f.store,
      browser: { readTabCatalog: vi.fn() },
      computerUse: {
        presentableSurfaces: async () => [],
        sessionsForRunner: () => [],
        authorizeDisplay: vi.fn(),
      },
      computerViews: { authorizePresentation: vi.fn() },
      places: { assertUsable: vi.fn() },
    });
    const admission = new KeyedAdmissionQueue({
      maxInFlight: 8,
      maxQueuedBytes: 1_000_000,
      maxQueuedCommands: 32,
    });
    let activeClaims: AgentControlRunScope | undefined;
    const tokens = {
      authenticate: async () => {
        if (!activeClaims) throw new Error("Run not dispatched");
        await f.store.assertActiveGrant(activeClaims);
        return activeClaims;
      },
    } as unknown as AgentControlTokenService;
    let currentMessage: MessageId | undefined;
    let currentRun: RunId | undefined;
    let dispatch: Promise<unknown> | undefined;
    let control!: AgentControlService;
    let publicationSawContext = false;
    const realtime = new RealtimeHub({ store: f.store });
    const commands = new CommandService({
      store: f.store,
      admission,
      onWorkspaceEvent: (event) => {
        if (event.type === "message.created" && event.data.message.author.kind === "human") {
          currentMessage = event.data.message.id;
          publicationSawContext = screen.contextFor(currentMessage) !== undefined;
        }
      },
      onExecutionQueued: () => {
        dispatch = (async () => {
          expect(publicationSawContext).toBe(true);
          const command = await f.database
            .selectFrom("commands")
            .selectAll()
            .where("threadId", "=", thread.id)
            .where("type", "=", "run.execute")
            .where("status", "=", "pending")
            .executeTakeFirstOrThrow();
          await f.store.claimCommand(command.id, "screen-fast-dispatch");
          currentRun = command.runId!;
          const binding = await f.bindAgentControlRun(
            { ...fixture, thread },
            currentRun,
            "screen-fast",
            thread.id,
          );
          screen.registry.noteInputsSending(
            [currentMessage!],
            currentRun,
            binding.bindingGeneration,
          );
          activeClaims = {
            ...binding,
            threadId: thread.id,
            capabilityProfileId: "main",
            runId: currentRun,
            aud: "opensteer-agent-control",
            exp: 9_999_999_999,
            iat: 0,
            iss: "opensteer-host",
            jti: randomUUID(),
          };
          return control.handle("test-token", {
            type: "screen.show",
            requestId: randomUUID(),
            messageId: currentMessage,
            target: { conversationId: fixture.thread.id },
          });
        })();
      },
    });
    const enqueue = commands.enqueueThreadInput.bind(commands);
    vi.spyOn(commands, "enqueueThreadInput").mockImplementation(async (input, options) => {
      const result = await enqueue(input, options);
      await dispatch;
      return result;
    });
    const controlOptions = {
      screenPresentation: screen,
      store: f.store,
      tokens,
      commands,
      browser: {} as never,
      browserSources: {} as never,
      machineFullDiskAccess: {} as never,
      canRunHarness: () => true,
      defaultWorkspaceBacking: "portablefs",
      environmentWorkspaceBackings: () => ["portablefs"],
      isEnvironmentConnected: () => true,
      onWorkspaceEvent: () => undefined,
      workspaceMounts: {} as never,
      workspaces: {} as never,
    } satisfies ConstructorParameters<typeof AgentControlService>[0];
    control = new AgentControlService({ ...controlOptions, allowMainChatRunScreenShow: true });
    const sockets: WebSocket[] = [];
    const app = await ownTestDatabaseProducer(f.databaseUrl, async () => {
      const server = await createHostServer(
        hostServerTestDependencies({
          store: f.store,
          commands,
          realtime,
          screenPresentation: screen,
          agentControl: control,
          portablefs: {
            mountExchange: {} as never,
            workspaceActivity: { note: () => undefined },
            workspaceWake: { wake: async () => undefined },
          },
          runners: { attachmentInputFailure: () => null } as never,
          authenticator: {
            authenticateSession: async (headers: Record<string, unknown>) =>
              headers["x-test-other"] ? otherSession : session,
            authenticateSessionContext: async (headers: Record<string, unknown>) => ({
              session: headers["x-test-other"] ? otherSession : session,
              credentialKind: "native-oauth",
              surface: "canonical",
            }),
            requireExactOrigin: () => undefined,
            identity: {
              configuration: async () => ({ localPasswordEnabled: true, oidcProviders: [] }),
              nativeOpenIdConfiguration: () => undefined,
            },
          } as never,
          discovery: signHostDiscovery(generateKeyPairSync("ed25519"), {
            canonicalOrigin: "https://screen.example",
            deploymentId: createId("deployment"),
            deploymentShape: { kind: "server", defaultWorkspaceBacking: "portablefs" },
            hostInstanceId: createId("hostInstance"),
            hostKey: { algorithm: "Ed25519" },
          }),
        }),
      );
      return {
        server,
        close: async () => {
          for (const socket of sockets) socket.close();
          screen.close();
          await server.close();
          await admission.close();
        },
      };
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
    async function connect() {
      const socket = new WebSocket(origin.replace("http:", "ws:") + "/v1/realtime");
      sockets.push(socket);
      const messages: HostToClientMessage[] = [];
      socket.on("message", (frame) =>
        messages.push(HostToClientMessageSchema.parse(JSON.parse(frame.toString()))),
      );
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        }),
        1000,
        { timeoutError: () => new Error("Presentation socket never opened") },
      );
      socket.send(
        JSON.stringify({
          type: "client.subscribe",
          workspaceId: fixture.workspace.id,
          threadId: null,
          afterSequence: zeroSequence,
          apiVersion: hostApiVersion,
          screenShow: true,
        }),
      );
      await vi.waitFor(
        () =>
          expect(
            messages.some((message) => message.type === "host.screen.ready"),
            "Main subscription never issued a presentation endpoint",
          ).toBe(true),
        { timeout: 2000 },
      );
      const ready = messages.find((message) => message.type === "host.screen.ready")!;
      if (ready.type !== "host.screen.ready") throw new Error("No ready frame");
      return { socket, messages, ready };
    }
    const first = await connect();
    const second = await connect();
    expect(second.ready.endpointRef).not.toBe(first.ready.endpointRef);
    const command = {
      type: "thread.sendMessage" as const,
      threadId: thread.id,
      content: [{ type: "text" as const, text: "Show my task" }],
      idempotencyKey: "screen-first-human",
      screenPresentation: {
        endpointRef: first.ready.endpointRef,
        voiceSessionId: "00000000-0000-4000-8000-000000000001",
        utteranceSequence: 1,
        interactionRevision: 0,
        currentThreadId: fixture.thread.id,
      },
    };
    let httpFinished = false;
    const sending = testRpcRequest(origin, "commands.dispatch", command).then((response) => {
      httpFinished = true;
      return response;
    });
    void sending.catch(() => undefined);
    await vi.waitFor(
      () =>
        expect(
          first.messages.some((message) => message.type === "host.screen.show"),
          "Committed human input never reached its exact socket",
        ).toBe(true),
      { timeout: 2000 },
    );
    expect(httpFinished).toBe(false);
    const shown = first.messages.find((message) => message.type === "host.screen.show")!;
    if (shown.type !== "host.screen.show") throw new Error("No show frame");
    expect(second.messages.some((message) => message.type === "host.screen.show")).toBe(false);
    const ack = JSON.stringify({
      type: "client.screen.done",
      operationId: shown.operationId,
      receipt: { outcome: "applied" },
    });
    second.socket.send(ack);
    second.socket.send(JSON.stringify({ type: "client.ping", nonce: "forged-ack-processed" }));
    await vi.waitFor(
      () =>
        expect(
          second.messages.some(
            (message) => message.type === "host.pong" && message.nonce === "forged-ack-processed",
          ),
        ).toBe(true),
      { timeout: 1000 },
    );
    expect(screen.registry.pendingCount).toBe(1);
    first.socket.send(ack);
    expect((await sending).status).toBe(200);
    await expect(dispatch).resolves.toMatchObject({
      type: "screen.show.result",
      receipt: { outcome: "applied" },
    });
    const disabledControl = new AgentControlService(controlOptions);
    await expect(
      disabledControl.handle("test-token", {
        type: "screen.show",
        requestId: randomUUID(),
        messageId: shown.messageId,
        target: { conversationId: fixture.thread.id },
      }),
    ).resolves.toMatchObject({ type: "screen.show.result", receipt: { outcome: "unsupported" } });
    expect(first.messages.filter((message) => message.type === "host.screen.show")).toHaveLength(1);
    const changedEndpointRetry = await testRpcRequest(origin, "commands.dispatch", {
      ...command,
      screenPresentation: {
        ...command.screenPresentation,
        endpointRef: second.ready.endpointRef,
        utteranceSequence: 9,
      },
    });
    expect((await changedEndpointRetry.json()).data.wasDuplicate).toBe(true);
    expect(second.messages.some((message) => message.type === "host.screen.show")).toBe(false);
    const row = await f.database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", shown.messageId)
      .executeTakeFirstOrThrow();
    const storedCommands = await f.database
      .selectFrom("commands")
      .selectAll()
      .where("threadId", "=", thread.id)
      .execute();
    expect(JSON.stringify([row, storedCommands])).not.toContain(first.ready.endpointRef);
    expect(JSON.stringify([row, storedCommands])).not.toContain(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(
      JSON.stringify(
        await f.store.threadMessagePageForOwner({
          threadId: thread.id,
          ownerId: fixture.userId,
          maxItems: 10,
          maxBytes: 10000,
        }),
      ),
    ).not.toContain(first.ready.endpointRef);
    const forged = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        ...command,
        idempotencyKey: "other-user-forges",
        screenPresentation: { ...command.screenPresentation },
      },
      { headers: { "x-test-other": "yes" } },
    );
    expect(forged.status).toBe(403);
    expect(await f.store.hasAcceptedThreadInput(secondUser, "other-user-forges")).toBe(false);
    expect(
      await f.store.screenPresentationInput({ ...activeClaims!, messageId: createId("message") }),
    ).toBeNull();
    await f.store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      runnerId: fixture.runnerId,
      runnerBootId: activeClaims!.runnerBootId,
      event: pendingEvent({
        bindingGeneration: activeClaims!.bindingGeneration,
        data: { status: "running" },
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: currentRun!,
        threadId: thread.id,
        type: "run.started",
        workspaceId: fixture.workspace.id,
      }),
    });
    // An unsent steer is merely queued for the Runner; its message is not tool authority.
    const steer = await f.store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      content: [{ type: "text", text: "Show another task" }],
      policy: "steer",
      source: { kind: "human" },
      idempotencyKey: "screen-unsent-steer",
    });
    expect(steer.command?.type).toBe("run.steer");
    expect(
      await f.store.screenPresentationInput({ ...activeClaims!, messageId: steer.message.id }),
    ).toBeNull();
    await f.store.claimCommand(steer.command!.id, "screen-steer-dispatcher");
    const admittedSteer = await f.store.screenPresentationInput({
      ...activeClaims!,
      messageId: steer.message.id,
    });
    expect(admittedSteer?.steerCommandId).toBe(steer.command!.id);
    expect(
      screen.registry.inputWasSent(
        steer.message.id,
        currentRun!,
        activeClaims!.bindingGeneration,
        steer.command!.id,
      ),
    ).toBe(false);
    const context = { ...command.screenPresentation, utteranceSequence: 2 };
    screen.registry.register({
      ownerId: fixture.userId,
      sessionId: session.id,
      threadId: thread.id,
      messageId: steer.message.id,
      context,
    });
    const showSteer = () =>
      control.handle("test-token", {
        type: "screen.show",
        requestId: randomUUID(),
        messageId: steer.message.id,
        target: { conversationId: fixture.thread.id },
      });
    await expect(showSteer()).resolves.toMatchObject({
      receipt: { outcome: "unavailable", reason: "forbidden" },
    });
    screen.registry.noteInputsSending(
      [steer.message.id],
      currentRun!,
      activeClaims!.bindingGeneration,
    );
    screen.registry.noteInputsSending(
      [steer.message.id],
      currentRun!,
      activeClaims!.bindingGeneration,
      steer.command!.id,
    );
    const beforeSteerAck = showSteer();
    await vi.waitFor(
      () =>
        expect(
          first.messages.some(
            (message) =>
              message.type === "host.screen.show" && message.messageId === steer.message.id,
          ),
          "The sent steer could not present before its Runner acknowledgement",
        ).toBe(true),
      { timeout: 1000 },
    );
    const steeredFrame = first.messages.find(
      (message) => message.type === "host.screen.show" && message.messageId === steer.message.id,
    )!;
    if (steeredFrame.type !== "host.screen.show") throw new Error("Missing steer presentation");
    expect(
      (
        await f.database
          .selectFrom("commands")
          .select("status")
          .where("id", "=", steer.command!.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("dispatched");
    first.socket.send(
      JSON.stringify({
        type: "client.screen.done",
        operationId: steeredFrame.operationId,
        receipt: { outcome: "applied" },
      }),
    );
    await expect(beforeSteerAck).resolves.toMatchObject({ receipt: { outcome: "applied" } });
    await f.store.markSteerUnknown(steer.command!.id, "Acknowledgement lost");
    expect(
      await f.store.screenPresentationInput({ ...activeClaims!, messageId: steer.message.id }),
    ).not.toBeNull();
    await expect(showSteer()).resolves.toMatchObject({ receipt: { outcome: "applied" } });
    expect(
      first.messages.filter(
        (message) => message.type === "host.screen.show" && message.messageId === steer.message.id,
      ),
    ).toHaveLength(1);
    await expect(
      f.store.screenPresentationInput({
        ...activeClaims!,
        bindingGeneration: activeClaims!.bindingGeneration + 1,
        messageId: shown.messageId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const revoked = await f.store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      content: [{ type: "text", text: "Revoked before target resolution" }],
      policy: "steer",
      source: { kind: "human" },
      idempotencyKey: "screen-revoked-during-target",
    });
    await f.store.claimCommand(revoked.command!.id, "screen-revocation-dispatch");
    screen.registry.register({
      ownerId: fixture.userId,
      sessionId: session.id,
      threadId: thread.id,
      messageId: revoked.message.id,
      context: { ...context, utteranceSequence: 3 },
    });
    screen.registry.noteInputsSending(
      [revoked.message.id],
      currentRun!,
      activeClaims!.bindingGeneration,
    );
    screen.registry.noteInputsSending(
      [revoked.message.id],
      currentRun!,
      activeClaims!.bindingGeneration,
      revoked.command!.id,
    );
    vi.spyOn(screen, "authorizeTarget").mockImplementationOnce(async () => {
      await f.store.refuseSteer(revoked.command!.id, "Refused during target authorization");
    });
    await expect(
      control.handle("test-token", {
        type: "screen.show",
        requestId: randomUUID(),
        messageId: revoked.message.id,
        target: { conversationId: fixture.thread.id },
      }),
    ).resolves.toMatchObject({ receipt: { outcome: "unavailable", reason: "forbidden" } });
    expect(
      first.messages.some(
        (message) =>
          message.type === "host.screen.show" && message.messageId === revoked.message.id,
      ),
    ).toBe(false);
    const quoted = await f.store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      content: [{ type: "text", text: "Quote is context" }],
      quotedMessageId: shown.messageId,
      policy: "steer",
      source: { kind: "human" },
      idempotencyKey: "screen-quoted-input",
    });
    await f.store.claimCommand(quoted.command!.id, "screen-quoted-dispatch");
    expect(quoted.message.quote).toBeDefined();
    expect(
      await f.store.screenPresentationInput({ ...activeClaims!, messageId: quoted.message.id }),
    ).toBeNull();
    await f.store.refuseSteer(quoted.command!.id, "Quoted context cannot present");
    const passive = await f.store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      content: [{ type: "text", text: "Passive history" }],
      policy: "report",
      source: { kind: "human" },
      idempotencyKey: "screen-passive-input",
    });
    expect(passive.input.policy).toBe("report");
    expect(
      await f.store.screenPresentationInput({ ...activeClaims!, messageId: passive.message.id }),
    ).toBeNull();
    await f.database
      .updateTable("runners")
      .set({ capabilities: sql`${JSON.stringify(["screen-show-v1"])}::jsonb` })
      .where("id", "=", fixture.runnerId)
      .execute();
    const queued = await f.store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      content: [{ type: "text", text: "Waiting input" }],
      policy: "queue",
      source: { kind: "human" },
      idempotencyKey: "screen-pending-input",
    });
    expect(queued.input.state).toBe("pending");
    expect(
      await f.store.screenPresentationInput({ ...activeClaims!, messageId: queued.message.id }),
    ).toBeNull();
    await f.store.cancelThreadInput({
      threadId: thread.id,
      messageId: queued.message.id,
      requestedBy: fixture.userId,
      idempotencyKey: "screen-cancel-input",
    });
    expect(
      await f.store.screenPresentationInput({ ...activeClaims!, messageId: queued.message.id }),
    ).toBeNull();
    screen.close();
    await expect(
      control.handle("test-token", {
        type: "screen.show",
        requestId: randomUUID(),
        messageId: shown.messageId,
        target: { conversationId: fixture.thread.id },
      }),
    ).resolves.toMatchObject({ receipt: { outcome: "unavailable" } });
    await app.close();
  });
});
