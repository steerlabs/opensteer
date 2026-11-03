import {
  CHAT_THREAD_TITLE,
  DEFAULT_THREAD_ACCESS_MODE,
  isPlaceContentPart,
  OpensteerError,
  type UserId,
  type EnvironmentId,
  type HarnessId,
  type ThreadAccessMode,
  type ModelSelection,
  type ThreadId,
  harnessDriverLabel,
} from "@opensteer/core";
import { isRetryableHarnessCatalogStatus } from "@opensteer/harness";
import type {
  OpensteerStore,
  EnqueueThreadInputRequest,
  ThreadMutationAdmission,
  RunnerControlInput,
} from "@opensteer/database";
import type { CommandService, RunnerRegistry } from "@opensteer/orchestration";
import type { HarnessInstanceCatalog, HarnessModelDescriptor } from "@opensteer/protocol";
import {
  matchModelSelection,
  modelOptionUnavailableMessage,
  storedModelSelection,
} from "../agents/model-selection.js";
import type { HostApiCommand } from "@opensteer/protocol";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { threadCallerAuthority, messageSource } from "../mcp/operations.js";
import { thread as assertThreadAccess } from "../mcp/tool-access.js";
import type { PlaceContextService } from "../computer-use/place-context-service.js";
import type { BrowserService } from "../browser/browser-service.js";

type ThreadActor = { readonly kind: "person"; readonly userId: UserId } | AgentCaller;
type Command<K extends HostApiCommand["type"]> = Extract<HostApiCommand, { readonly type: K }>;
export class ThreadService {
  readonly options: {
    readonly store: OpensteerStore;
    readonly commands: CommandService;
    readonly runners: Pick<
      RunnerRegistry,
      | "isAvailable"
      | "canRunHarness"
      | "harnessAccessModes"
      | "identityForEnvironment"
      | "attachmentInputFailure"
    >;
    readonly placeContext: Pick<PlaceContextService, "assertIncludable">;
    readonly browser: Pick<BrowserService, "announceUsage">;
  };
  constructor(options: ThreadService["options"]) {
    this.options = options;
  }
  async assertTarget(actor: ThreadActor, threadId: ThreadId) {
    const thread = await this.options.store.getThreadForOwner(threadId, actor.userId);
    if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
    if (actor.kind !== "person") assertThreadAccess(actor, [thread]);
    return thread;
  }
  async create(
    actor: ThreadActor,
    command: Command<"thread.create">,
    selection: {
      readonly specialistId?: string;
      readonly icon?: import("@opensteer/core").WorkspaceIconName;
    } = {},
  ) {
    if (actor.kind !== "person" && command.accessMode && command.accessMode !== actor.accessMode)
      throw new OpensteerError({
        code: "forbidden",
        message: "New work must use the caller’s approved access mode",
      });
    const parent = command.parentThreadId
      ? await this.options.store.getThreadForOwner(command.parentThreadId, actor.userId)
      : null;
    if (command.parentThreadId && !parent) {
      throw new OpensteerError({ code: "not_found", message: "Parent thread not found" });
    }
    const input = {
      ...selection,
      ...(actor.kind === "person" ? {} : { authority: threadCallerAuthority(actor) }),
      accessMode:
        command.accessMode ??
        (actor.kind === "person"
          ? (parent?.accessMode ?? DEFAULT_THREAD_ACCESS_MODE)
          : actor.accessMode),
      createdBy: actor.userId,
      environmentId: command.environmentId,
      harnessInstanceId: command.harnessInstanceId,
      idempotencyKey: command.idempotencyKey,
      modelSelection: command.modelSelection,
      ...(command.parentThreadId ? { parentThreadId: command.parentThreadId } : {}),
      ...(command.home ? { home: true } : {}),
      ...(command.generateTitle ? { generateTitle: true as const } : {}),
      title: command.home ? CHAT_THREAD_TITLE : command.title,
      workspaceId: command.workspaceId,
    } as const;
    const workspace = await this.options.store.getWorkspaceForOwner(
      command.workspaceId,
      actor.userId,
    );
    if (!workspace) {
      throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
    }
    if (command.home) {
      if (workspace.createdBy !== actor.userId || command.parentThreadId)
        throw new OpensteerError({
          code: "bad_request",
          message: "Chat must be an owner’s root conversation",
        });
      if (workspace.homeThreadId) {
        const existingHome = await this.options.commands.createThread(input);
        return { ...existingHome, type: command.type };
      }
    }
    const existing = await this.options.store.findThreadCreationByIdempotency(input);
    if (existing) {
      if (actor.kind !== "person") await this.options.commands.createThread(input);
      return { ...existing, type: command.type };
    }
    const harness = await this.options.store.getHarnessInstance(command.harnessInstanceId);
    if (!harness?.enabled || harness.environmentId !== command.environmentId) {
      throw new OpensteerError({
        code: "conflict",
        message: "The selected AI engine is not available",
      });
    }
    const environment = await this.options.store.getEnvironment(command.environmentId);
    if (!environment) {
      throw new OpensteerError({
        code: "not_found",
        message: "The selected place to run this work no longer exists",
      });
    }
    if (!this.options.runners.isAvailable(command.environmentId)) {
      throw new OpensteerError({
        code: "conflict",
        message: "The selected place to run this work is not connected",
        retryable: true,
      });
    }
    if (!this.options.runners.canRunHarness(command.environmentId, harness.driverKind)) {
      throw new OpensteerError({
        code: "conflict",
        message: "The selected AI engine is not available where this work will run",
      });
    }
    assertAccessModeEnforceable(
      this.options.runners,
      command.environmentId,
      harness.driverKind,
      input.accessMode,
    );
    const available = assertModelSelectionAvailable(
      (await this.options.store.getHarnessCatalog(environment.id, harness.id)) ?? undefined,
      command.modelSelection,
    );
    const created = await this.options.commands.createThread({
      ...input,
      modelSelection: storedModelSelection(command.modelSelection, available.model),
    });
    return {
      asOfSequence: created.asOfSequence,
      thread: created.thread,
      type: command.type,
      wasDuplicate: created.wasDuplicate,
    };
  }
  async sendMessage(actor: ThreadActor, command: Command<"thread.sendMessage">) {
    return this.options.commands.withInputAdmission(
      actor.userId,
      command.idempotencyKey,
      async () => {
        if (
          command.content.some(isPlaceContentPart) &&
          !(await this.options.store.hasAcceptedThreadInput(actor.userId, command.idempotencyKey))
        ) {
          const thread = await this.options.store.getThreadForOwner(command.threadId, actor.userId);
          if (!thread) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
          await this.options.placeContext.assertIncludable({
            ownerId: actor.userId,
            parts: command.content,
            threadId: thread.id,
            workspaceId: thread.workspaceId,
          });
        }
        const result = await this.sendInput(actor, {
          ...(command.quotedMessageId ? { quotedMessageId: command.quotedMessageId } : {}),
          content: command.content,
          idempotencyKey: command.idempotencyKey,
          policy: command.delivery ?? "queue",
          requestedBy: actor.userId,
          source:
            actor.kind === "person"
              ? { kind: "human" }
              : messageSource(actor, command.idempotencyKey),
          threadId: command.threadId,
          validateNewAttachmentInput: (selection) => {
            const failure = this.options.runners.attachmentInputFailure({
              content: command.content,
              ...selection,
            });
            if (failure) throw new OpensteerError({ code: "conflict", message: failure });
          },
        });
        // The message's transaction credited its pages to the conversation.
        if (result.browserUsage) this.options.browser.announceUsage(result.browserUsage);
        return {
          input: result.input,
          message: result.message,
          run: result.run,
          type: command.type,
          wasDuplicate: result.wasDuplicate,
        };
      },
    );
  }
  async configure(actor: ThreadActor, command: Command<"thread.execution.update">) {
    const thread = await this.assertTarget(actor, command.threadId);
    if (
      command.continuation &&
      !this.options.runners
        .identityForEnvironment(thread.environmentId)
        ?.capabilities.includes("native-session-continuation-v1")
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Connect an updated Runner before changing this conversation's AI engine",
      });
    }
    const harness = await this.options.store.getHarnessInstance(command.harnessInstanceId);
    if (!harness?.enabled || harness.environmentId !== thread.environmentId) {
      throw new OpensteerError({ code: "conflict", message: "AI engine is unavailable" });
    }
    // The Thread keeps its access mode across an engine change, so the
    // engine it lands on must be one that can keep that promise.
    assertAccessModeEnforceable(
      this.options.runners,
      thread.environmentId,
      harness.driverKind,
      thread.accessMode,
    );
    const available = assertModelSelectionAvailable(
      (await this.options.store.getHarnessCatalog(thread.environmentId, harness.id)) ?? undefined,
      command.modelSelection,
    );
    return {
      ...(await this.options.commands.updateThreadExecutionSelection({
        ...(actor.kind === "person" ? {} : { authority: threadCallerAuthority(actor) }),
        ...(command.continuation ? { continuation: command.continuation } : {}),
        idempotencyKey: command.idempotencyKey,
        continuationIdentity: available.catalog.continuationIdentity,
        harnessInstanceId: command.harnessInstanceId,
        modelSelection: storedModelSelection(command.modelSelection, available.model),
        requestedBy: actor.userId,
        threadId: command.threadId,
      })),
      type: command.type,
    };
  }

  async sendInput(
    actor: ThreadActor,
    input: EnqueueThreadInputRequest,
    admission?: ThreadMutationAdmission,
  ) {
    if (actor.kind !== "person") await this.assertTarget(actor, input.threadId);
    const request = {
      ...input,
      ...(actor.kind === "person" || admission ? {} : { authority: threadCallerAuthority(actor) }),
    };
    return admission
      ? this.options.commands.enqueueAdmittedThreadInput({ input: request, admission })
      : this.options.commands.enqueueThreadInput(request);
  }
  async resume(actor: ThreadActor, command: Command<"thread.inputQueue.resume">) {
    if (actor.kind !== "person") await this.assertTarget(actor, command.threadId);
    const result = await this.options.commands.resumeThreadInputQueue({
      ...command,
      requestedBy: actor.userId,
      ...(actor.kind === "person" ? {} : { authority: threadCallerAuthority(actor) }),
    });
    return { thread: result.thread, asOfSequence: result.asOfSequence };
  }
  async steer(actor: ThreadActor, command: Command<"thread.input.steer">) {
    await this.assertTarget(actor, command.threadId);
    const result = await this.options.commands.steerThreadInput({
      ...command,
      requestedBy: actor.userId,
      ...(actor.kind === "person" ? {} : { authority: threadCallerAuthority(actor) }),
    });
    return { input: result.input };
  }
  async cancel(actor: ThreadActor, command: Command<"thread.input.cancel">) {
    if (actor.kind !== "person") await this.assertTarget(actor, command.threadId);
    const result = await this.options.commands.cancelThreadInput({
      ...command,
      requestedBy: actor.userId,
      ...(actor.kind === "person" ? {} : { authority: threadCallerAuthority(actor) }),
    });
    return { input: result.input };
  }
  async move(actor: ThreadActor, command: Command<"thread.input.move">) {
    if (actor.kind !== "person") await this.assertTarget(actor, command.threadId);
    await this.options.commands.moveThreadInput({
      ...command,
      requestedBy: actor.userId,
      ...(actor.kind === "person" ? {} : { authority: threadCallerAuthority(actor) }),
    });
    return {};
  }
  async interrupt(
    actor: ThreadActor,
    command: Command<"run.interrupt">,
    commitReceipt?: Extract<RunnerControlInput, { type: "run.interrupt" }>["commitReceipt"],
  ) {
    if (actor.kind !== "person") await this.assertTarget(actor, command.threadId);
    const result = await this.options.commands.sendControl({
      ...command,
      requestedBy: actor.userId,
      ...(actor.kind === "person" ? {} : { authority: threadCallerAuthority(actor) }),
      ...(commitReceipt ? { commitReceipt } : {}),
    });
    return { wasDuplicate: result.wasDuplicate };
  }
}
interface AvailableModelSelection {
  readonly catalog: Extract<HarnessInstanceCatalog, { readonly status: "ready" }>;
  readonly model: HarnessModelDescriptor;
}

/**
 * A Thread's access mode is a promise about what its Runs may do without
 * asking, and only the engine can keep it. The driver's own declaration — the
 * same advertisement `harness.create` validates a source against — is the
 * authority; the Host carries no list of its own and never quietly substitutes
 * a mode the engine does support. Silence (an away work location, a driver that
 * cannot run) is not a declaration, so nothing is refused on it: that Thread is
 * already blocked from running by the checks that care about reachability.
 */
export function assertAccessModeEnforceable(
  runners: Pick<RunnerRegistry, "harnessAccessModes">,
  environmentId: EnvironmentId,
  driverKind: HarnessId,
  accessMode: ThreadAccessMode,
): void {
  const advertised = runners.harnessAccessModes(environmentId, driverKind);
  if (!advertised || advertised.includes(accessMode)) return;
  throw new OpensteerError({
    code: "bad_request",
    message: `${harnessDriverLabel(driverKind)} cannot enforce the ${accessMode} access mode`,
  });
}

/**
 * Proves a selection is one this account can actually run, and hands back the
 * catalog descriptor it matched — the only place that knows the native id the
 * account's endpoint answers to.
 */
export function assertModelSelectionAvailable(
  catalog: HarnessInstanceCatalog | undefined,
  selection: ModelSelection,
): AvailableModelSelection {
  if (!catalog) {
    throw new OpensteerError({
      code: "conflict",
      message: "The selected AI engine has not reported its available models",
      retryable: true,
    });
  }
  if (catalog.status !== "ready") {
    throw new OpensteerError({
      code: "conflict",
      message: catalog.detail,
      retryable: isRetryableHarnessCatalogStatus(catalog.status),
    });
  }
  const match = matchModelSelection(catalog.models, selection, "refuse");
  if (match.kind === "model-unavailable") {
    throw new OpensteerError({
      code: "conflict",
      message:
        match.reason ?? "The selected model is not available in this AI engine on this Runner",
    });
  }
  if (match.kind === "option-unavailable") {
    throw new OpensteerError({ code: "conflict", message: modelOptionUnavailableMessage(match) });
  }
  return { catalog, model: match.model };
}
