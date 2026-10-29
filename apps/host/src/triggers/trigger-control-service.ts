import { environmentDiscovery } from "../agents/environment-discovery.js";
import { createHash } from "node:crypto";
import {
  provisionalThreadTitle,
  EnvironmentIdSchema,
  OpensteerError,
  RunnerIdSchema,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type EnvironmentId,
  type WorkspaceBackingKind,
  type HarnessId,
  type UserId,
  type ThreadId,
} from "@opensteer/core";
import type {
  OpensteerStore,
  TriggerControlAdmissionResult,
  TriggerStore,
} from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import {
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  agentWorkspaceView,
  type AgentControlRequest,
  type AgentControlResponse,
} from "@opensteer/protocol";
import type { TriggerControlInput } from "@opensteer/triggers";
import { z } from "zod";
import { SignedTokenClaimsSchema, type SignedTokenService } from "../identity/host-keys.js";
import { runCapabilityLifetimeSeconds } from "../agents/run-capability.js";
import {
  delegationEngines,
  delegationHarnessPage,
  delegationPlacement,
} from "../agents/delegation-placement.js";
import { requestFingerprintForToolContract, requestForToolContract } from "./tool-contract.js";
import {
  assertProgramToolAllowed,
  assertProgramThreadScope,
  assertProgramMessageScope,
  assertProgramDelegationScope,
} from "./program-authority.js";
import { callerWorkspaceStorage } from "../workspace/workspace-service.js";

const TriggerCapabilityScopeSchema = z.strictObject({
  environmentId: EnvironmentIdSchema,
  executionGeneration: z.number().int().positive(),
  occurrenceId: TriggerOccurrenceIdSchema,
  requestedBy: UserIdSchema,
  runnerBootId: z.string().min(1).max(255),
  runnerId: RunnerIdSchema,
  threadId: ThreadIdSchema,
  toolContractVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  workspaceId: WorkspaceIdSchema,
});
type TriggerCapabilityScope = z.infer<typeof TriggerCapabilityScopeSchema>;
export type TriggerCapabilityClaims<Audience extends string> = TriggerCapabilityScope & {
  readonly aud: Audience;
  readonly exp: number;
  readonly iat: number;
  readonly iss: "opensteer-host";
  readonly jti: string;
};
export type TriggerControlScope = TriggerCapabilityClaims<"opensteer-trigger-control">;

export class TriggerCapabilityTokenService<Audience extends string> {
  readonly #audience: Audience;
  readonly #schema: z.ZodType<TriggerCapabilityClaims<Audience>>;
  readonly #store: Pick<TriggerStore, "assertActiveExecutionBinding">;
  readonly #tokens: SignedTokenService;

  constructor(options: {
    readonly audience: Audience;
    readonly store: Pick<TriggerStore, "assertActiveExecutionBinding">;
    readonly tokens: SignedTokenService;
  }) {
    this.#audience = options.audience;
    this.#schema = SignedTokenClaimsSchema.extend({
      ...TriggerCapabilityScopeSchema.shape,
      aud: z.literal(options.audience),
    }) as z.ZodType<TriggerCapabilityClaims<Audience>>;
    this.#store = options.store;
    this.#tokens = options.tokens;
  }

  issue(input: TriggerCapabilityScope): string {
    return this.#tokens.issue({ ...input, aud: this.#audience }, runCapabilityLifetimeSeconds);
  }

  async authenticate(token: string): Promise<TriggerCapabilityClaims<Audience>> {
    const claims = this.#tokens.verify(token, this.#schema);
    await this.#store.assertActiveExecutionBinding(claims);
    return claims;
  }
}

export class TriggerControlTokenService extends TriggerCapabilityTokenService<"opensteer-trigger-control"> {
  constructor(options: {
    readonly store: Pick<TriggerStore, "assertActiveExecutionBinding">;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-trigger-control" });
  }
}

export interface TriggerManager {
  manage(
    ownerId: UserId,
    input: TriggerControlInput,
    actorThreadId: ThreadId | null,
  ): Promise<unknown>;
}

type TriggerWorkspaceCreator = Pick<
  import("../workspace/workspace-service.js").WorkspaceService,
  "create"
>;

export class TriggerControlService {
  readonly #canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
  readonly #commands: CommandService;
  readonly #defaultWorkspaceBacking: WorkspaceBackingKind;
  readonly #environmentWorkspaceBackings: (
    environmentId: EnvironmentId,
  ) => readonly WorkspaceBackingKind[];
  readonly #isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
  readonly #store: OpensteerStore;
  readonly #tokens: TriggerControlTokenService;
  readonly #triggers: TriggerManager;
  readonly #workspaces: TriggerWorkspaceCreator;

  constructor(options: {
    readonly canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
    readonly commands: CommandService;
    readonly defaultWorkspaceBacking: WorkspaceBackingKind;
    readonly environmentWorkspaceBackings: (
      environmentId: EnvironmentId,
    ) => readonly WorkspaceBackingKind[];
    readonly isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
    readonly store: OpensteerStore;
    readonly tokens: TriggerControlTokenService;
    readonly triggers: TriggerManager;
    readonly workspaces: TriggerWorkspaceCreator;
  }) {
    this.#canRunHarness = options.canRunHarness;
    this.#commands = options.commands;
    this.#defaultWorkspaceBacking = options.defaultWorkspaceBacking;
    this.#environmentWorkspaceBackings = options.environmentWorkspaceBackings;
    this.#isEnvironmentConnected = options.isEnvironmentConnected;
    this.#store = options.store;
    this.#tokens = options.tokens;
    this.#triggers = options.triggers;
    this.#workspaces = options.workspaces;
  }

  async handle(token: string, value: unknown): Promise<AgentControlResponse> {
    const claims = await this.#tokens.authenticate(token);
    const request = AgentControlRequestSchema.parse(
      requestForToolContract(claims.toolContractVersion, value),
    );
    const anchor = await this.#store.getThreadForOwner(claims.threadId, claims.requestedBy);
    if (
      !anchor ||
      anchor.environmentId !== claims.environmentId ||
      anchor.workspaceId !== claims.workspaceId
    ) {
      throw forbidden("Trigger no longer belongs to its anchor Thread");
    }
    assertProgramToolAllowed("trigger", anchor, request);
    if (request.type !== "thread.delegate" && request.type !== "thread.message") {
      await this.#admit(claims, request);
    }

    if (request.type === "environment.list") {
      const result = await environmentDiscovery({
        store: this.#store,
        userId: claims.requestedBy,
        parent: anchor,
        input: request,
        connected: this.#isEnvironmentConnected,
        canRun: this.#canRunHarness,
        workspaceBackings: this.#environmentWorkspaceBackings,
      });
      return AgentControlResponseSchema.parse({
        ...result,
        requestId: request.requestId,
        type: "environment.list.result",
      });
    }
    if (request.type === "workspace.list") {
      const page = await this.#store.workspacePageForOwner({
        ownerId: claims.requestedBy,
        maxBytes: 64 * 1_024,
        maxItems: request.limit,
        ...(request.before ? { before: request.before } : {}),
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type: "workspace.list.result",
        window: page.window,
        workspaces: page.workspaces.map(({ id, kind, name, status }) => ({
          id,
          kind,
          name,
          status,
        })),
      });
    }

    if (request.type === "workspace.inspect") {
      const [workspacePage, threadPage, environmentRows] = await Promise.all([
        this.#store.workspacePageForOwner({
          ...(request.workspaceBefore ? { before: request.workspaceBefore } : {}),
          maxBytes: 64 * 1_024,
          maxItems: request.maxWorkspaces ?? 25,
          ownerId: claims.requestedBy,
        }),
        this.#store.ownerThreadPageForOwner({
          ...(request.threadBefore ? { before: request.threadBefore } : {}),
          maxBytes: 64 * 1_024,
          maxItems: request.maxThreads ?? 50,
          ownerId: claims.requestedBy,
        }),
        this.#store.listEnvironmentsForUser(claims.requestedBy, 65),
      ]);
      const environments = environmentRows.slice(0, 64);
      const harnessPage = await delegationHarnessPage(this.#store, claims.requestedBy, request);
      const harnesses = harnessPage.harnesses;
      return AgentControlResponseSchema.parse({
        environments: environments.map(({ id, kind, name }) => ({
          compatibleHarnessInstanceIds: harnesses
            .filter(
              (harness) =>
                harness.environmentId === id && this.#canRunHarness(id, harness.driverKind),
            )
            .map((harness) => harness.id),
          connected: this.#isEnvironmentConnected(id),
          id,
          kind,
          name,
          workspaceBackings: this.#environmentWorkspaceBackings(id),
        })),
        environmentsTruncated: environmentRows.length > 64,
        delegationDefault: {
          environmentId: anchor.environmentId,
          harnessInstanceId: anchor.harnessInstanceId,
          model: {
            modelId: anchor.modelSelection.modelId,
            options: anchor.modelSelection.options,
            providerId: anchor.modelSelection.providerId,
          },
        },
        harnesses: await delegationEngines(this.#store, harnesses, request.modelPage),
        harnessesTruncated: harnessPage.nextCursor !== undefined,
        ...(harnessPage.nextCursor !== undefined
          ? { harnessesNextCursor: harnessPage.nextCursor }
          : {}),
        requestId: request.requestId,
        threadWindow: threadPage.window,
        threads: threadPage.threads,
        type: "workspace.inspect.result",
        workspaceWindow: workspacePage.window,
        workspaces: workspacePage.workspaces.map(({ id, kind, name, status }) => ({
          id,
          kind,
          name,
          status,
        })),
      });
    }

    if (request.type === "workspace.create") {
      const workspace = await this.#workspaces.create({
        createdBy: claims.requestedBy,
        ...(request.icon ? { icon: request.icon } : {}),
        ...(request.color ? { color: request.color } : {}),
        idempotencyKey: idempotencyKey(claims, request.requestId, "workspace"),
        kind: "specialized",
        name: request.name,
        storage: callerWorkspaceStorage({
          callerEnvironmentId: claims.environmentId,
          defaultBacking: this.#defaultWorkspaceBacking,
          requested: request.storage,
        }),
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type: "workspace.create.result",
        workspace: agentWorkspaceView(workspace),
      });
    }

    if (request.type === "thread.read") {
      const thread = await this.#store.getThreadForOwner(request.threadId, claims.requestedBy);
      if (!thread) throw forbidden("Thread is unavailable to this user");
      assertProgramThreadScope(anchor, thread);
      const page = await this.#store.threadMessagePageForOwner({
        ...(request.query ? { query: request.query } : {}),
        ...(request.aroundMessageId ? { aroundMessageId: request.aroundMessageId } : {}),
        ...(request.before ? { before: request.before } : {}),
        maxBytes: 400 * 1_024,
        maxItems: request.maxMessages,
        ownerId: claims.requestedBy,
        threadId: request.threadId,
      });
      if (!page) throw forbidden("Thread is unavailable to this user");
      const assignments = await this.#store.listThreadAssignmentsForOwner({
        ...(request.assignmentBefore ? { before: request.assignmentBefore } : {}),
        maxBytes: 128 * 1_024,
        maxItems: 25,
        ownerId: claims.requestedBy,
        threadId: thread.id,
      });
      if (!assignments) throw forbidden("Thread is unavailable to this user");
      return AgentControlResponseSchema.parse({
        assignments: assignments.assignments,
        assignmentWindow: assignments.window,
        messages: page.messages,
        requestId: request.requestId,
        thread,
        type: "thread.read.result",
        window: page.window,
      });
    }

    if (request.type === "thread.delegate") {
      if (request.places?.length)
        throw badRequest("Trigger delegation cannot forward place references.");
      const existingThread = request.threadId
        ? await this.#store.getThreadForOwner(request.threadId, claims.requestedBy)
        : null;
      if (request.threadId && !existingThread) throw forbidden("Target Thread is unavailable");
      if (existingThread && (existingThread.role !== "work" || existingThread.id === anchor.id)) {
        throw badRequest("Choose another work Thread for the assignment");
      }
      const targetWorkspaceId = existingThread?.workspaceId ?? request.workspaceId;
      if (!targetWorkspaceId) throw badRequest("Choose a target Workspace or work Thread");
      assertProgramDelegationScope(anchor, targetWorkspaceId, existingThread);
      const workspace = await this.#store.getWorkspaceForOwner(
        targetWorkspaceId,
        claims.requestedBy,
      );
      if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
      const environmentId =
        existingThread?.environmentId ?? request.environmentId ?? anchor.environmentId;
      const environment = await this.#store.getEnvironment(environmentId);
      if (!environment) throw forbidden("Selected execution environment does not exist");
      if (
        request.environmentId &&
        !(await this.#store.environmentIsAvailableToUser(environment.id, claims.requestedBy))
      ) {
        throw forbidden("Selected execution environment is unavailable to this user");
      }
      if (
        workspace.backing.kind === "local-directory" &&
        workspace.backing.ownerEnvironmentId !== environment.id
      ) {
        throw forbidden("A local-directory Workspace can run only in its owning environment");
      }
      const placement = await delegationPlacement(this.#store, {
        environment,
        existingThread,
        harnessInstanceId: request.harnessInstanceId,
        model: request.model,
        parent: anchor,
      });
      const delegateInput = {
        callerIntent: {
          requestId: request.requestId,
          requestFingerprint: this.#admissionRequest(claims, request).requestFingerprint,
        },
        accessMode: existingThread?.accessMode ?? anchor.accessMode,
        ...(existingThread ? { threadId: existingThread.id } : {}),
        createdBy: claims.requestedBy,
        environmentId: environment.id,
        harnessInstanceId: placement.harnessInstanceId,
        idempotencyKey: idempotencyKey(claims, request.requestId, "delegate"),
        modelSelection: placement.modelSelection,
        origin: {
          kind: "trigger",
          occurrenceId: claims.occurrenceId,
          parentThreadId: anchor.id,
        },
        task: [
          {
            text: request.task,
            type: "text",
          },
        ],
        title: request.title ?? provisionalThreadTitle(request.task),
        titleSource: request.title === undefined ? "provisional" : "chosen",
        ...(request.icon ? { icon: request.icon } : {}),
        workspaceId: workspace.id,
      } as const;
      const replayed = await this.#store.findDelegatedThreadByIdempotency(delegateInput);
      if (replayed) {
        return AgentControlResponseSchema.parse({
          requestId: request.requestId,
          result: {
            assignmentId: replayed.assignment.id,
            input: replayed.input,
            message: replayed.message,
            run: replayed.run,
            thread: replayed.thread,
          },
          type: "thread.delegate.result",
        });
      }
      if (workspace.status !== "ready") throw conflict("Target Workspace is not ready", true);
      const harness = await this.#store.getHarnessInstance(placement.harnessInstanceId);
      const connected = this.#isEnvironmentConnected(environment.id);
      if (!connected) {
        throw conflict("Selected execution environment is not connected", true);
      }
      if (
        !harness?.enabled ||
        (connected && !this.#canRunHarness(environment.id, harness.driverKind))
      ) {
        throw conflict("Selected AI engine is not available on the requested work location");
      }
      const delegated = await this.#commands.delegateAdmittedThread({
        admission: { kind: "trigger", request: this.#admissionRequest(claims, request) },
        input: delegateInput,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result: {
          assignmentId: delegated.assignment.id,
          input: delegated.input,
          message: delegated.message,
          run: delegated.run,
          thread: delegated.thread,
        },
        type: "thread.delegate.result",
      });
    }

    if (request.type === "thread.message") {
      const destination =
        request.threadId === "home"
          ? (await this.#store.findMainWorkspaceForOwner(claims.requestedBy))?.homeThreadId
          : request.threadId;
      if (!destination) throw conflict("Chat has not been started yet");
      const thread = await this.#store.getThreadForOwner(destination, claims.requestedBy);
      if (!thread) throw forbidden("Thread is unavailable to this user");
      assertProgramMessageScope(anchor, thread, request);
      const delivered = await this.#commands.enqueueAdmittedThreadInput({
        admission: { kind: "trigger", request: this.#admissionRequest(claims, request) },
        input: {
          content: request.content,
          idempotencyKey: idempotencyKey(claims, request.requestId, "message"),
          policy: request.delivery,
          requestedBy: claims.requestedBy,
          source: { kind: "trigger", occurrenceId: claims.occurrenceId },
          threadId: thread.id,
        },
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result: {
          assignmentId: delivered.input.assignmentId,
          disposition: delivered.disposition,
          input: delivered.input,
          message: delivered.message,
          run: delivered.run,
          thread,
        },
        type: "thread.message.result",
      });
    }

    if (request.type === "trigger.control") {
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result: await this.#triggers.manage(
          claims.requestedBy,
          triggerControlInput(claims, request),
          anchor.id,
        ),
        type: "trigger.control.result",
      });
    }

    throw forbidden(`Trigger profile does not allow ${request.type}`);
  }

  /**
   * A Trigger program has no Run, so its Occurrence is the admission ledger's
   * scope. Every control call is admitted before it acts; a replayed requestId
   * with identical input is admitted again as a duplicate and re-executed
   * against the same derived idempotency keys, exactly as on the Run path.
   */
  async #admit(
    claims: TriggerControlScope,
    request: AgentControlRequest,
  ): Promise<TriggerControlAdmissionResult> {
    return this.#store.admitTriggerControlRequest(this.#admissionRequest(claims, request));
  }

  #admissionRequest(claims: TriggerControlScope, request: AgentControlRequest) {
    return {
      action:
        request.type === "trigger.control"
          ? request.tool
          : request.type === "sign-in"
            ? "browser.sign-in"
            : request.type,
      environmentId: claims.environmentId,
      executionGeneration: claims.executionGeneration,
      occurrenceId: claims.occurrenceId,
      requestFingerprint: createHash("sha256")
        .update(
          JSON.stringify(requestFingerprintForToolContract(claims.toolContractVersion, request)),
          "utf8",
        )
        .digest("hex"),
      requestId: request.requestId,
      requestedBy: claims.requestedBy,
      runnerBootId: claims.runnerBootId,
      runnerId: claims.runnerId,
      threadId: claims.threadId,
      workspaceId: claims.workspaceId,
    } as const;
  }
}

/**
 * A Trigger create carries no model-supplied idempotency key: the Occurrence
 * that asked for it is the authority, so the key is derived from it.
 */
function triggerControlInput(
  claims: TriggerControlScope,
  request: Extract<AgentControlRequest, { readonly type: "trigger.control" }>,
): TriggerControlInput {
  if (request.input.operation !== "create") {
    return request.input;
  }
  return {
    ...request.input,
    idempotencyKey: idempotencyKey(claims, request.requestId, "trigger.create"),
  };
}

function idempotencyKey(claims: TriggerControlScope, requestId: string, action: string): string {
  return `trigger:${claims.occurrenceId}:${requestId}:${action}`;
}

function forbidden(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}

function badRequest(message: string): OpensteerError {
  return new OpensteerError({ code: "bad_request", message });
}

function conflict(message: string, retryable = false): OpensteerError {
  return new OpensteerError({ code: "conflict", message, retryable });
}
