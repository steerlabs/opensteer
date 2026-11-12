import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { createId, type NotificationView } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import {
  HarnessInstanceCatalogViewSchema,
  HostToClientMessageSchema,
  type HostApiCommandInput,
  type HostApiCommandOutput,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { startPersonalRuntime } from "./personal-startup.test-support.js";
import {
  createPersonalVerticalStack,
  type VerticalStack,
  type VerticalStackOptions,
} from "../agents/vertical-stack.test-support.js";
import { RunnerWire } from "../agents/runner-wire.test-support.js";

export async function startPersonalVertical(options: VerticalStackOptions): Promise<VerticalStack> {
  const database = await cloneTestDatabase("host", { serverUrl: options.databaseUrl });
  const directory = await realpath(await mkdtemp(join(tmpdir(), "personal-vertical-")));
  const agentHome = options.agentHome ?? {
    computerId: createId("runner"),
    path: join(directory, "agent-home"),
  };
  let runtime: Awaited<ReturnType<typeof startPersonalRuntime>> | undefined,
    socket: WebSocket | undefined;
  let closed = false;
  const children = new Set<VerticalStack>();
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const stop of [
      async () => {
        for (const child of children) await child.close();
      },
      async () => {
        socket?.terminate();
      },
      async () => {
        if (runtime) await options.beforeHostClose?.(runtime.host);
      },
      async () => runtime?.close(),
      () => database.drop(),
      () => rm(directory, { recursive: true, force: true }),
    ])
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, "Personal vertical cleanup failed");
  };
  try {
    const owned = await ownTestDatabaseProducer(database.url, async () => {
      const runtime = await startPersonalRuntime({
        databaseUrl: database.url,
        agentHome,
        vertical: options,
      });
      return { runtime, close: () => runtime.close() };
    });
    runtime = owned.runtime;
    const current = runtime;
    const command = async (input: HostApiCommandInput): Promise<HostApiCommandOutput> => {
      const result = await current.api["commands.dispatch"](input);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    };
    const observe = <Value>(
      read: () => Promise<Value | undefined>,
      label: string,
      timeout = options.runTimeoutMs,
    ) => current.observe(read, AbortSignal.timeout(timeout), label);
    const catalog = async () => {
      const held = await current.host.store.getHarnessCatalog(
        current.environmentId,
        current.harnessInstanceId,
      );
      return held ? HarnessInstanceCatalogViewSchema.parse(held) : undefined;
    };
    const initialCatalog = HarnessInstanceCatalogViewSchema.parse(current.initialCatalog);
    if (initialCatalog.status === "authentication-required" && options.harnessInstance.apiKey) {
      const key = options.harnessInstance.apiKey;
      await command({
        type: "harness.authentication.begin",
        environmentId: current.environmentId,
        harnessInstanceId: current.harnessInstanceId,
        idempotencyKey: crypto.randomUUID(),
        methodId: key.methodId,
        ...(key.connectionSlot ? { connectionSlot: key.connectionSlot } : {}),
      });
      if (key.value !== undefined)
        await command({
          type: "harness.authentication.submit",
          environmentId: current.environmentId,
          harnessInstanceId: current.harnessInstanceId,
          idempotencyKey: crypto.randomUUID(),
          value: key.value,
        });
    }
    if (initialCatalog.status !== "ready" && !options.harnessInstance.apiKey)
      throw new Error(
        `${initialCatalog.status}: ${"detail" in initialCatalog ? initialCatalog.detail : "Account unavailable"}`,
      );
    const ready = await observe(
      async () => {
        const held = await catalog();
        return held?.status === "ready" ? held : undefined;
      },
      "Personal account never became ready",
      options.catalogTimeoutMs,
    );
    const notifications: NotificationView[] = [];
    socket = new WebSocket(
      new URL(`/v1/realtime?opensteer_api_version=${hostApiVersion}`, current.hostOrigin)
        .toString()
        .replace(/^http/u, "ws"),
      { headers: { cookie: current.sessionCookie, origin: current.hostOrigin.origin } },
    );
    socket.on("message", (data) => {
      const frame = HostToClientMessageSchema.parse(JSON.parse(data.toString()));
      if (frame.type === "host.notification") notifications.push(frame.notification);
    });
    await withTimeout(once(socket, "open"), options.catalogTimeoutMs, {
      timeoutError: () => new Error("Notification socket never opened"),
    });
    const deploymentId = current.host.deployment.id;
    socket.send(
      JSON.stringify({
        type: "client.subscribe",
        cursor: { deploymentId, apiVersion: hostApiVersion, afterSequence: "0" },
        threadId: null,
        apiVersion: hostApiVersion,
        snapshotMessages: "omit",
      }),
    );
    const basic = createPersonalVerticalStack(agentHome, current);
    const stack: VerticalStack = {
      ...basic,
      get host() {
        return current.host;
      },
      get sessionCookie() {
        return current.sessionCookie;
      },
      environmentId: current.environmentId,
      harnessInstanceId: current.harnessInstanceId,
      additionalHarnessInstanceIds: current.additionalHarnessInstanceIds,
      catalog: ready,
      initialCatalog,
      notifications,
      runnerDataDirectory: current.runnerDataDirectory,
      network: current.network,
      ...(current.network instanceof RunnerWire ? { wire: current.network } : {}),
      folderPreparations: current.folderPreparations,
      settledRunEvent: (runId) => current.runner?.settledRunEvent(runId),
      async crashRunner(beforeRestart) {
        await current.crashRunner(beforeRestart);
      },
      async createFolder(_name) {
        const path = await mkdtemp(join(directory, "task-"));
        await mkdir(path, { recursive: true });
        return { computerId: agentHome.computerId, path };
      },
      async startAdditionalPersonal() {
        const { agentHome: _home, ...additional } = options;
        const child = await startPersonalVertical(additional);
        children.add(child);
        return child;
      },
      async configureModel(nativeModelId, settings) {
        await command({
          type: "harness.model.configure",
          environmentId: current.environmentId,
          harnessInstanceId: current.harnessInstanceId,
          idempotencyKey: crypto.randomUUID(),
          nativeModelId,
          settings,
        });
        return observe(
          async () => {
            const held = await catalog();
            if (held?.status !== "ready") return;
            const model = held.models.find(
              (row) => (row.nativeModelId ?? row.modelId) === nativeModelId,
            );
            return model &&
              (settings?.contextWindow === undefined ||
                model.contextWindow === settings.contextWindow)
              ? model
              : undefined;
          },
          "Configured model never appeared",
          options.catalogTimeoutMs,
        );
      },
      async updateThreadExecution(threadId, modelSelection, selection) {
        await command({
          type: "thread.execution.update",
          threadId,
          harnessInstanceId: selection?.harnessInstanceId ?? current.harnessInstanceId,
          modelSelection,
          idempotencyKey: selection?.idempotencyKey ?? crypto.randomUUID(),
          ...(selection?.expectedProviderSessionId !== undefined
            ? { continuation: { expectedProviderSessionId: selection.expectedProviderSessionId } }
            : {}),
        });
      },
      async updateThreadAccess(threadId, accessMode) {
        await command({
          type: "thread.access.update",
          threadId,
          accessMode,
          idempotencyKey: crypto.randomUUID(),
        });
      },
      async interruptRun(threadId, runId) {
        await command({
          type: "run.interrupt",
          threadId,
          runId,
          idempotencyKey: crypto.randomUUID(),
        });
      },
      async resumeThreadInputQueue(threadId) {
        await command({
          type: "thread.inputQueue.resume",
          threadId,
          idempotencyKey: crypto.randomUUID(),
        });
      },
      async uploadAttachment({ bytes, mediaType, name }) {
        const reserved = await command({
          type: "attachment.upload.create",
          mediaType,
          name,
          sizeBytes: bytes.length,
          idempotencyKey: crypto.randomUUID(),
        });
        if (reserved.type !== "attachment.upload.create")
          throw new Error("Attachment reservation receipt mismatch");
        const uploaded = await current.api["attachment.upload"](
          { attachmentId: reserved.attachment.id },
          { body: new Blob([Uint8Array.from(bytes)]) },
        );
        if (!uploaded.ok) throw new Error(uploaded.error.message);
        return uploaded.data;
      },
      async waitForToolStart(runId, count = 1) {
        await observe(async () => {
          const events = await current.host.store.database
            .selectFrom("deploymentEvents")
            .select("eventId")
            .where("runId", "=", runId)
            .where("type", "=", "tool.started")
            .execute();
          return events.length >= count ? true : undefined;
        }, `Run never started ${count} tools`);
      },
      async steerMessage({ threadId, text, attachments }) {
        const result = await command({
          type: "thread.sendMessage",
          threadId,
          idempotencyKey: crypto.randomUUID(),
          delivery: "steer",
          content: [{ type: "text", text }, ...(attachments ?? [])],
        });
        if (result.type !== "thread.sendMessage") throw new Error("Steer receipt mismatch");
        return { messageId: result.message.id, runId: result.run?.id ?? null };
      },
      async sendMessage(input) {
        const response = await command({
          type: "thread.sendMessage",
          threadId: input.threadId,
          idempotencyKey: crypto.randomUUID(),
          delivery: "queue",
          content: [{ type: "text", text: input.text }, ...(input.attachments ?? [])],
        });
        if (response.type !== "thread.sendMessage") throw new Error("Task input receipt mismatch");
        const replacement =
          input.onQueued && response.run ? await input.onQueued(response.run.id) : undefined;
        return current.waitForInput(
          response.message.id,
          AbortSignal.timeout(options.runTimeoutMs),
          replacement ?? undefined,
        );
      },
      restartHost: (outage) => current.restartHost(outage),
      close,
    };
    return stack;
  } catch (error) {
    await close();
    throw error;
  }
}
