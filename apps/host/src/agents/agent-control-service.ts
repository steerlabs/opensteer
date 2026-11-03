import { SpecialistStore } from "@opensteer/database";
import type { PersonShowMessage } from "@opensteer/protocol";
import {
  AgentToolIdSchema,
  capabilityProfileAcceptsTool,
  type AgentToolId,
} from "@opensteer/agent-tools";
import {
  isPlaceContentPart,
  OpensteerError,
  placeContentLabel,
  provisionalThreadTitle,
  ThreadIdSchema,
  threadInReach,
  type AgentEvent,
  type EnvironmentId,
  type HarnessId,
  type Message,
  type Thread,
  type Workspace,
  type WorkspaceBackingKind,
} from "@opensteer/core";
import type {
  AgentControlAdmissionResult,
  AgentThreadListScope,
  BrowserUsageCredit,
  OpensteerStore,
} from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import {
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  agentWorkspaceView,
  computerAppIdentityKey,
  type AgentControlRequest,
  type AgentControlResponse,
} from "@opensteer/protocol";
import type { TriggerControlInput } from "@opensteer/triggers";
import { createHash } from "node:crypto";
import type { BrowserService } from "../browser/browser-service.js";
import type { BrowserSourceService } from "../browser/browser-source-service.js";
import type { BrowserTabGroupService } from "../browser/browser-tab-group-service.js";
import type { PlaceContextService } from "../computer-use/place-context-service.js";
import type { ComputerUseService } from "../computer-use/computer-use-service.js";
import type { SignedTokenService } from "../identity/host-keys.js";
import type { MachineFullDiskAccessService } from "../shell/machine-full-disk-access-service.js";
import { specialistPlacement } from "./specialist-placement.js";
import { delegationPlacement } from "./delegation-placement.js";
import { environmentDiscovery } from "./environment-discovery.js";
import {
  RunCapabilityTokenService,
  type RunCapabilityBindingAuthorizer,
  type RunCapabilityClaims,
} from "./run-capability.js";

export type AgentControlRunScope = RunCapabilityClaims<"opensteer-agent-control">;

export interface AgentWorkspaceMountService {
  mount(input: {
    readonly requestId: string;
    readonly scope: AgentControlRunScope;
    readonly workspace: Workspace;
  }): Promise<{ readonly path: string }>;
}

export interface AgentWorkspaceCreator {
  create(input: {
    readonly createdBy: AgentControlRunScope["requestedBy"];
    readonly idempotencyKey: string;
    readonly kind: "project";
    readonly name: string;
  }): Promise<Workspace>;
}

export interface AgentTriggerManager {
  manage(
    ownerId: AgentControlRunScope["requestedBy"],
    input: TriggerControlInput,
    actorThreadId: Thread["id"] | null,
  ): Promise<unknown>;
}

type AgentControlBindingAuthorizer = RunCapabilityBindingAuthorizer;

export class AgentControlTokenService extends RunCapabilityTokenService<"opensteer-agent-control"> {
  constructor(options: {
    readonly authorizer: AgentControlBindingAuthorizer;
    readonly lifetimeSeconds?: number;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-agent-control" });
  }
}

export class AgentControlService {
  readonly #computerUse:
    Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay"> | undefined;
  readonly #personShow:
    | ((userId: AgentControlRunScope["requestedBy"], message: PersonShowMessage) => Promise<number>)
    | undefined;
  readonly #supportsLoginFill: (scope: AgentControlRunScope) => boolean;
  readonly #browserSources: Pick<BrowserSourceService, "agentSignIn">;
  readonly #machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
  readonly #browser: Pick<
    BrowserService,
    | "createProfile"
    | "drainRunPlaces"
    | "closeAgentSession"
    | "listAgentSessions"
    | "listGrantedProfiles"
    | "openAgentSession"
    | "requestAccess"
  >;
  readonly #browserTabs: BrowserTabGroupService | undefined;
  readonly #canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
  readonly #commands: CommandService;
  readonly #environmentWorkspaceBackings: (
    environmentId: EnvironmentId,
  ) => readonly WorkspaceBackingKind[];
  readonly #isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #store: OpensteerStore;
  readonly #onBrowserUsage: ((credits: readonly BrowserUsageCredit[]) => void) | undefined;
  readonly #placeContext: Pick<PlaceContextService, "assertDelegated"> | undefined;
  readonly #tokens: AgentControlTokenService;
  readonly #triggers: AgentTriggerManager | undefined;
  readonly #workspaceMounts: AgentWorkspaceMountService;

  readonly #workspaces: AgentWorkspaceCreator;

  constructor(options: {
    readonly computerUse?: Pick<ComputerUseService, "sessionsForRunner" | "authorizeDisplay">;
    readonly personShow?: (
      userId: AgentControlRunScope["requestedBy"],
      message: PersonShowMessage,
    ) => Promise<number>;
    readonly supportsLoginFill?: (scope: AgentControlRunScope) => boolean;
    readonly browserSources: Pick<BrowserSourceService, "agentSignIn">;
    readonly machineFullDiskAccess: Pick<MachineFullDiskAccessService, "request">;
    readonly browser: Pick<
      BrowserService,
      | "createProfile"
      | "drainRunPlaces"
      | "closeAgentSession"
      | "listAgentSessions"
      | "listGrantedProfiles"
      | "openAgentSession"
      | "requestAccess"
    >;
    readonly browserTabs?: BrowserTabGroupService;
    readonly canRunHarness: (environmentId: EnvironmentId, driverKind: HarnessId) => boolean;
    readonly commands: CommandService;
    readonly defaultWorkspaceBacking: WorkspaceBackingKind;
    readonly environmentWorkspaceBackings: (
      environmentId: EnvironmentId,
    ) => readonly WorkspaceBackingKind[];
    readonly isEnvironmentConnected: (environmentId: EnvironmentId) => boolean;
    readonly onWorkspaceEvent: (event: AgentEvent) => void;
    readonly store: OpensteerStore;
    readonly onBrowserUsage?: (credits: readonly BrowserUsageCredit[]) => void;
    readonly placeContext?: Pick<PlaceContextService, "assertDelegated">;
    readonly tokens: AgentControlTokenService;
    readonly triggers?: AgentTriggerManager;
    readonly workspaceMounts: AgentWorkspaceMountService;
    readonly workspaces: AgentWorkspaceCreator;
  }) {
    this.#computerUse = options.computerUse;
    this.#personShow = options.personShow;
    this.#supportsLoginFill = options.supportsLoginFill ?? (() => false);
    this.#browserSources = options.browserSources;
    this.#machineFullDiskAccess = options.machineFullDiskAccess;
    this.#browser = options.browser;
    this.#browserTabs = options.browserTabs;
    this.#canRunHarness = options.canRunHarness;
    this.#commands = options.commands;
    this.#environmentWorkspaceBackings = options.environmentWorkspaceBackings;
    this.#isEnvironmentConnected = options.isEnvironmentConnected;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#store = options.store;
    this.#placeContext = options.placeContext;
    this.#onBrowserUsage = options.onBrowserUsage;
    this.#tokens = options.tokens;
    this.#triggers = options.triggers;
    this.#workspaceMounts = options.workspaceMounts;
    this.#workspaces = options.workspaces;
  }

  async #readableMessages(
    runId: AgentControlRunScope["runId"],
    messages: readonly Message[],
  ): Promise<readonly Message[]> {
    if (!messages.some((message) => message.content.some(isPlaceContentPart))) return messages;
    const capabilities = await this.#store.runPlaceCapabilities(runId);
    return messages.map((message) => ({
      ...message,
      content: message.content.map((part) => {
        if (!isPlaceContentPart(part)) return part;
        const capability =
          part.type === "browser-page" ? "browser-page-input-v1" : "native-place-input-v1";
        return capabilities.includes(capability)
          ? part
          : { type: "text" as const, text: placeContentLabel(part) };
      }),
    }));
  }
  async #readableMessage(runId: AgentControlRunScope["runId"], message: Message): Promise<Message> {
    return (await this.#readableMessages(runId, [message]))[0]!;
  }

  async handle(token: string, input: unknown): Promise<AgentControlResponse> {
    const claims = await this.#tokens.authenticate(token);
    const request = AgentControlRequestSchema.parse(input);
    if (request.type === "browser.sign-in")
      throw badRequest("This agent operation has been removed");
    if (request.type === "thread.delegate" && request.places)
      request.places = request.places.map((part) => {
        if (part.type !== "browser-page") return part;
        const { auto: _auto, documentId: _documentId, ...forwarded } = part;
        return forwarded;
      });
    const isMainProfile = claims.capabilityProfileId === "main";
    const [currentThread, mainMembership] = await Promise.all([
      this.#store.getThreadForOwner(claims.threadId, claims.requestedBy),
      isMainProfile
        ? this.#store.workspaceMembershipForUser(claims.workspaceId, claims.requestedBy)
        : null,
    ]);
    if (
      !currentThread ||
      currentThread.workspaceId !== claims.workspaceId ||
      currentThread.environmentId !== claims.environmentId ||
      currentThread.capabilityProfileId !== claims.capabilityProfileId
    ) {
      throw forbidden("Run no longer belongs to its claimed Workspace and environment");
    }
    if (isMainProfile) {
      if (!mainMembership || mainMembership.state !== "active" || mainMembership.role !== "owner") {
        throw forbidden("Main coordination requires active owner authority in this Workspace");
      }
    }

    assertToolAllowed(claims.capabilityProfileId, request);

    if (request.type === "person.show") {
      if (!this.#personShow) throw badRequest("Showing places is unavailable on this Host.");
      let target: PersonShowMessage["target"];
      if ("current" in request.target) {
        await this.#browser.drainRunPlaces(claims.runId);
        const current = await this.#store.latestRunPlace(claims.runId);
        if (!current) throw badRequest("This Run has no current place to show.");
        target = { place: current.data.place };
        const place = current.data.place;
        if (place.kind !== "browser") {
          const session = this.#computerUse
            ?.sessionsForRunner(place.machineId)
            .find(
              (session) =>
                session.runId === claims.runId &&
                (place.kind === "phone"
                  ? session.display && place.display === "main"
                  : session.apps.some((app) => computerAppIdentityKey(app) === place.appKey)),
            );
          if (!session || !this.#computerUse)
            throw forbidden("This Run's current place is unavailable.");
          await this.#computerUse.authorizeDisplay(
            session.sessionId,
            claims.requestedBy,
            place.kind === "app" ? place.appKey : undefined,
          );
        }
      } else target = request.target;
      const tabId =
        "tabId" in target
          ? target.tabId
          : "place" in target && target.place.kind === "browser"
            ? target.place.surfaceId
            : null;
      if (tabId !== null) {
        if (!this.#browserTabs) throw badRequest("Saved tabs are unavailable on this Host.");
        await this.#browserTabs.authorizeShow(
          {
            kind: "agent",
            ownerId: claims.requestedBy,
            workspaceId: claims.workspaceId,
            threadId: claims.threadId,
            agentBindingId: `run:${claims.runId}`,
          },
          tabId,
        );
      } else if ("threadId" in target) {
        const targetThread = await this.#store.getThreadForOwner(
          target.threadId,
          claims.requestedBy,
        );
        if (!targetThread) throw forbidden("Thread is unavailable to this user");
        this.#assertThreadScope(currentThread, targetThread);
      }
      const admission = await this.#admit(claims, request);
      const connectedDevices = admission.wasDuplicate
        ? 0
        : await this.#personShow(claims.requestedBy, {
            type: "host.show",
            workspaceId: claims.workspaceId,
            threadId: claims.threadId,
            runId: claims.runId,
            target,
          });
      return AgentControlResponseSchema.parse({
        type: "person.show.result",
        requestId: request.requestId,
        connectedDevices,
        status: admission.wasDuplicate
          ? "already-requested"
          : connectedDevices > 0
            ? "sent-unconfirmed"
            : "no-device-connected",
      });
    }

    if (request.type === "person.notify") {
      if (!(await this.#store.runnerCapabilities(claims.runnerId))?.includes("person-notify-v1"))
        throw forbidden("Runner does not support person notifications");
      const result = await this.#commands.publishPersonNotification({
        admission: this.#admissionRequest(claims, request),
        message: request.message,
      });
      return AgentControlResponseSchema.parse({
        type: "person.notify.result",
        requestId: request.requestId,
        messageId: result.message.id,
      });
    }

    if (request.type === "trigger.control") {
      await this.#admit(claims, request);
      if (!this.#triggers) throw new Error("Trigger management is not configured");
      const result = await this.#triggers.manage(
        claims.requestedBy,
        triggerControlInput(claims, request),
        currentThread.id,
      );
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result,
        type: "trigger.control.result",
      });
    }

    if (request.type === "environment.list") {
      await this.#admit(claims, request);
      const result = await environmentDiscovery({
        store: this.#store,
        userId: claims.requestedBy,
        parent: currentThread,
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
    if (request.type === "project.list") {
      await this.#admit(claims, request);
      const page = await this.#store.workspacePageForOwner({
        ownerId: claims.requestedBy,
        maxBytes: 64 * 1_024,
        maxItems: request.limit,
        ...(request.before ? { before: request.before } : {}),
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type: "project.list.result",
        window: page.window,
        workspaces: page.workspaces.map(({ id, kind, name, status }) => ({
          id,
          kind,
          name,
          status,
        })),
      });
    }

    if (request.type === "project.create") {
      await this.#admit(claims, request);
      const workspace = await this.#workspaces.create({
        createdBy: claims.requestedBy,
        ...(request.icon ? { icon: request.icon } : {}),
        ...(request.color ? { color: request.color } : {}),
        idempotencyKey: idempotencyKey(claims, request.requestId, "workspace"),
        kind: "project",
        name: request.name,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type: "project.create.result",
        workspace: agentWorkspaceView(workspace),
        slug: workspace.slug,
        path: (
          await this.#workspaceMounts.mount({
            requestId: request.requestId,
            scope: claims,
            workspace,
          })
        ).path,
      });
    }

    if (request.type === "thread.list") {
      const scope = threadListScope(currentThread);
      if (request.workspaceId) {
        const workspace = await this.#store.getWorkspaceForOwner(
          request.workspaceId,
          claims.requestedBy,
        );
        if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
        if (scope.kind === "workspace" && workspace.id !== currentThread.workspaceId) {
          throw forbidden("This capability profile can list Threads only in its Workspace");
        }
      }
      await this.#admit(claims, request);
      const page = await this.#store.agentThreadPageForOwner({
        ...(request.before ? { before: request.before } : {}),
        maxBytes: 128 * 1_024,
        maxItems: request.limit,
        ownerId: claims.requestedBy,
        ...(request.query ? { query: request.query } : {}),
        scope,
        scopeId: claims.threadId,
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      });
      const response = AgentControlResponseSchema.parse({
        requestId: request.requestId,
        threads: page.threads.map((summary) => ({
          environmentConnected: this.#isEnvironmentConnected(summary.environmentId),
          environmentId: summary.environmentId,
          id: summary.id,
          parentThreadId: summary.parentThreadId,
          pendingRequests: summary.pendingRequests,
          status: summary.status,
          doneAt: summary.doneAt,
          title: summary.title,
          updatedAt: summary.updatedAt,
          workspaceId: summary.workspaceId,
          workspaceName: summary.workspaceName,
        })),
        type: "thread.list.result",
        window: page.window,
      });
      if (response.type !== "thread.list.result") throw new Error("Thread list response mismatch");
      if ((await this.#store.runnerCapabilities(claims.runnerId))?.includes("task-done-v1"))
        return response;
      return {
        ...response,
        threads: response.threads.map(({ doneAt: _doneAt, ...summary }) => summary),
      };
    }

    if (request.type === "thread.read") {
      const thread = await this.#store.getThreadForOwner(request.threadId, claims.requestedBy);
      if (!thread) throw forbidden("Thread is unavailable to this user");
      this.#assertThreadScope(currentThread, thread);
      await this.#admit(claims, request);
      const page = await this.#store.threadMessagePageForOwner({
        ...(request.query ? { query: request.query } : {}),
        ...(request.aroundMessageId ? { aroundMessageId: request.aroundMessageId } : {}),
        ...(request.before ? { before: request.before } : {}),
        maxItems: request.maxMessages,
        maxBytes: 400 * 1_024,
        ownerId: claims.requestedBy,
        threadId: request.threadId,
      });
      if (!page) throw forbidden("Thread is unavailable to this user");
      const assignments = await this.#store.listThreadAssignmentsForOwner({
        threadId: thread.id,
        ownerId: claims.requestedBy,
        maxItems: 25,
        maxBytes: 128 * 1_024,
        ...(request.assignmentBefore ? { before: request.assignmentBefore } : {}),
      });
      if (!assignments) throw forbidden("Thread is unavailable to this user");
      return AgentControlResponseSchema.parse({
        assignments: assignments.assignments,
        assignmentWindow: assignments.window,
        messages: await this.#readableMessages(
          claims.runId,
          page.messages.map(({ addressedToUserId: _addressedToUserId, ...message }) => message),
        ),
        requestId: request.requestId,
        thread,
        type: "thread.read.result",
        window: page.window,
      });
    }

    if (request.type === "thread.write") {
      if (!(await this.#store.runnerCapabilities(claims.runnerId))?.includes("task-done-v1"))
        throw forbidden("This Runner does not support task-done-v1");
      const write = request.input;
      const threadId = write.threadId ?? claims.threadId;
      const input = {
        threadId,
        requestedBy: claims.requestedBy,
        actorRunId: claims.runId,
        idempotencyKey: idempotencyKey(claims, request.requestId, "thread.write"),
      };
      if (write.action === "done" || write.action === "reopen") {
        const result = await this.#commands.setThreadDone({
          ...input,
          done: write.action === "done",
          admission: this.#admissionRequest(claims, request),
        });
        return AgentControlResponseSchema.parse({
          type: "thread.write.result",
          requestId: request.requestId,
          thread: await this.#writtenThreadSummary(result.thread, claims.requestedBy),
          doneWhenRunEnds: result.doneWhenRunEnds,
        });
      }
      const result =
        write.action === "rename"
          ? await this.#commands.renameThread({
              ...input,
              admission: this.#admissionRequest(claims, request),
              title: write.title!,
            })
          : await this.#commands.setThreadIcon({
              ...input,
              admission: this.#admissionRequest(claims, request),
              icon: write.icon!,
            });
      return AgentControlResponseSchema.parse({
        type: "thread.write.result",
        requestId: request.requestId,
        thread: await this.#writtenThreadSummary(result.thread, claims.requestedBy),
        doneWhenRunEnds: false,
      });
    }

    if (request.type === "assignment.cancel") {
      const cancelled = await this.#commands.cancelAssignment({
        assignmentId: request.assignmentId,
        requestedBy: claims.requestedBy,
        actorRunId: claims.runId,
        idempotencyKey: idempotencyKey(claims, request.requestId, "assignment.cancel"),
        admission: this.#admissionRequest(claims, request),
      });
      return AgentControlResponseSchema.parse({
        assignment: cancelled.assignment,
        requestId: request.requestId,
        type: "assignment.cancel.result",
      });
    }

    if (request.type === "request.list") {
      await this.#admit(claims, request);
      const page = await this.#store.requests.visiblePage({
        ...(request.before ? { before: request.before } : {}),
        limit: request.limit,
        originatingThreadId: claims.threadId,
        targetWorkspaceId: claims.workspaceId,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        requests: page.requests,
        type: "request.list.result",
        window: page.window,
      });
    }

    if (request.type === "request.withdraw") {
      await this.#admit(claims, request);
      const withdrawn = await this.#store.requests.withdraw({
        requestId: request.targetRequestId,
        threadId: claims.threadId,
        withdrawnBy: claims.requestedBy,
      });
      for (const event of withdrawn.events) this.#onWorkspaceEvent(event);
      return AgentControlResponseSchema.parse({
        request: withdrawn.request,
        requestId: request.requestId,
        type: "request.withdraw.result",
      });
    }

    if (request.type === "thread.delegate") {
      return this.#commands.withInputAdmission(
        claims.requestedBy,
        idempotencyKey(claims, request.requestId, "delegate"),
        async () => {
          const existingThread = request.threadId
            ? await this.#store.getThreadForOwner(request.threadId, claims.requestedBy)
            : null;
          if (request.threadId && !existingThread) throw forbidden("Target Thread is unavailable");
          if (existingThread) {
            this.#assertThreadScope(currentThread, existingThread);
            if (existingThread.role !== "work" || existingThread.id === currentThread.id) {
              throw badRequest("Choose another work Thread for the assignment");
            }
          }
          const targetWorkspaceId =
            existingThread?.workspaceId ??
            request.workspaceId ??
            (request.specialist ? currentThread.workspaceId : undefined);
          if (!targetWorkspaceId) throw badRequest("Choose a target Workspace or work Thread");
          const workspace = await this.#store.getWorkspaceForOwner(
            targetWorkspaceId,
            claims.requestedBy,
          );
          if (!workspace) throw forbidden("Target Workspace is unavailable to this user");
          if (!isMainProfile && workspace.id !== currentThread.workspaceId) {
            throw forbidden("This capability profile can delegate only inside its Workspace");
          }
          const registrations =
            request.specialist || existingThread?.specialistId
              ? await new SpecialistStore(this.#store.database).list(
                  workspace.id,
                  claims.requestedBy,
                )
              : [];
          const specialist = registrations.find((r) =>
            existingThread?.specialistId
              ? r.id === existingThread.specialistId
              : r.id === request.specialist || r.plugin === request.specialist,
          );
          if ((request.specialist || existingThread?.specialistId) && !specialist)
            throw badRequest("Specialist is not registered in this Workspace");
          if (
            existingThread &&
            request.specialist &&
            request.specialist !== specialist?.id &&
            request.specialist !== specialist?.plugin
          )
            throw badRequest("An existing Thread keeps its specialist binding");
          if (specialist?.status === "pending")
            throw badRequest(
              `Specialist is pending: ${specialist.access
                .filter((a) => a.state !== "bound")
                .map((a) => `${a.type}: ${a.state} (${a.reason})`)
                .join("; ")}`,
            );
          if (specialist && (request.model || request.harnessInstanceId || request.environmentId))
            throw badRequest("Specialist execution is selected by its registration");
          const chosenEnvironmentId = request.environmentId;
          const environmentId =
            existingThread?.environmentId ??
            chosenEnvironmentId ??
            (specialist && workspace.backing.kind === "local-directory"
              ? workspace.backing.ownerEnvironmentId
              : currentThread.environmentId);
          const environment = await this.#store.getEnvironment(environmentId);
          if (!environment) throw badRequest("Selected execution environment does not exist");
          if (
            chosenEnvironmentId &&
            !(await this.#store.environmentIsAvailableToUser(environment.id, claims.requestedBy))
          ) {
            throw forbidden("Selected execution environment is unavailable to this user");
          }
          // The owning-machine fence is a fact about the Workspace, not about how
          // the environment was named: an inherited environment lands on the wrong
          // disk exactly as easily as a chosen one, and the Run would be queued
          // before the dispatcher could refuse it.
          if (
            workspace.backing.kind === "local-directory" &&
            workspace.backing.ownerEnvironmentId !== environment.id
          ) {
            throw badRequest("A local-directory Workspace can run only in its owning environment");
          }
          const placement =
            specialist && !existingThread
              ? await specialistPlacement(this.#store, {
                  environment,
                  parent: currentThread,
                  specialist,
                  canRun: (engine) => this.#canRunHarness(environment.id, engine),
                })
              : await delegationPlacement(this.#store, {
                  environment,
                  existingThread,
                  harnessInstanceId: request.harnessInstanceId,
                  model: request.model,
                  parent: currentThread,
                });
          const delegateInput = {
            ...(specialist ? { specialistId: specialist.id } : {}),
            callerIntent: {
              requestId: request.requestId,
              requestFingerprint: this.#admissionRequest(claims, request).requestFingerprint,
            },
            accessMode: existingThread?.accessMode ?? currentThread.accessMode,
            ...(existingThread ? { threadId: existingThread.id } : {}),
            createdBy: claims.requestedBy,
            environmentId: environment.id,
            harnessInstanceId: placement.harnessInstanceId,
            idempotencyKey: idempotencyKey(claims, request.requestId, "delegate"),
            modelSelection: placement.modelSelection,
            origin: {
              kind: "run",
              parentRunId: claims.runId,
              parentThreadId: claims.threadId,
            },
            task: [{ text: request.task, type: "text" }, ...(request.places ?? [])],
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
                message: await this.#readableMessage(claims.runId, replayed.message),
                run: replayed.run,
                thread: replayed.thread,
              },
              type: "thread.delegate.result",
            });
          }
          if (request.places?.length) {
            if (!this.#placeContext) throw conflict("Place forwarding is unavailable on this Host");
            await this.#placeContext.assertDelegated({
              ownerId: claims.requestedBy,
              parent: currentThread,
              parts: request.places,
              ...(existingThread ? { targetThread: existingThread } : {}),
              workspaceId: workspace.id,
            });
          }
          if (workspace.status !== "ready") {
            throw conflict(
              "Target Workspace filesystem is not ready",
              workspace.status === "provisioning" || workspace.status === "unavailable",
            );
          }
          if (!chosenEnvironmentId && !this.#isEnvironmentConnected(environment.id)) {
            throw conflict("Selected execution environment is not connected", true);
          }
          const harness = await this.#store.getHarnessInstance(delegateInput.harnessInstanceId);
          if (!harness?.enabled) throw badRequest("Selected harness is disabled or unavailable");
          if (
            this.#isEnvironmentConnected(environment.id) &&
            !this.#canRunHarness(environment.id, harness.driverKind)
          ) {
            throw badRequest(
              `Selected execution environment cannot run harness driver ${harness.driverKind}`,
            );
          }
          const delegated = await this.#commands.delegateAdmittedThread({
            admission: { kind: "agent", request: this.#admissionRequest(claims, request) },
            input: delegateInput,
          });
          if (delegated.browserUsage) this.#onBrowserUsage?.(delegated.browserUsage);
          return AgentControlResponseSchema.parse({
            requestId: request.requestId,
            result: {
              assignmentId: delegated.assignment.id,
              input: delegated.input,
              message: await this.#readableMessage(claims.runId, delegated.message),
              run: delegated.run,
              thread: delegated.thread,
            },
            type: "thread.delegate.result",
          });
        },
      );
    }

    if (request.type === "browser.profile.create") {
      await this.#admit(claims, request);
      const profile = await this.#browser.createProfile({
        name: request.name,
        ownerId: claims.requestedBy,
        idempotencyKey: idempotencyKey(claims, request.requestId, "browserProfile"),
        workspaceId: claims.workspaceId,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        profile: { id: profile.id, name: profile.name },
        type: "browser.profile.create.result",
      });
    }
    if (request.type === "browser.profile.list") {
      await this.#admit(claims, request);
      const profiles = await this.#browser.listGrantedProfiles(
        claims.requestedBy,
        claims.workspaceId,
        `run:${claims.runId}`,
      );
      return AgentControlResponseSchema.parse({
        profiles,
        requestId: request.requestId,
        type: "browser.profile.list.result",
      });
    }
    if (request.type === "sign-in") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        result: await this.#browserSources.agentSignIn({
          loginFill: this.#supportsLoginFill(claims),
          callId: request.requestId,
          // Delegated Threads use sites already allowed; only Threads that own
          // their Workspace's objective may ask the owner for a new one.
          canRequest:
            claims.capabilityProfileId === "main" || claims.capabilityProfileId === "workspace",
          ownerId: claims.requestedBy,
          reason: request.reason,
          runId: claims.runId,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          site: request.site,
          threadId: claims.threadId,
          workspaceId: claims.workspaceId,
        }),
        type: "sign-in.result",
      });
    }

    if (request.type === "machine.full-disk-access.request") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        result: await this.#machineFullDiskAccess.request({
          callId: request.requestId,
          computer: request.computer,
          reason: request.reason,
          claims,
        }),
        requestId: request.requestId,
        type: "machine.full-disk-access.request.result",
      });
    }

    if (request.type === "browser.access.request") {
      const workspaceId = request.workspaceId ?? claims.workspaceId;
      if (!isMainProfile && workspaceId !== claims.workspaceId) {
        throw forbidden(
          "This capability profile can request browser access only for its Workspace",
        );
      }
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        result: await this.#browser.requestAccess({
          callId: request.requestId,
          originatingWorkspaceId: claims.workspaceId,
          ownerId: claims.requestedBy,
          reason: request.reason,
          runId: claims.runId,
          suggestion: request.suggestion,
          threadId: claims.threadId,
          workspaceId,
        }),
        requestId: request.requestId,
        type: "browser.access.request.result",
      });
    }

    const agentBindingId = `run:${claims.runId}`;
    if (request.type === "browser.tab.read" || request.type === "browser.tab.write") {
      await this.#admit(claims, request);
      if (!this.#browserTabs)
        throw badRequest("Saved tab organization is unavailable on this Host.");
      const actor = {
        kind: "agent" as const,
        ownerId: claims.requestedBy,
        workspaceId: claims.workspaceId,
        threadId: claims.threadId,
        agentBindingId,
      };
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        type:
          request.type === "browser.tab.read"
            ? "browser.tab.read.result"
            : "browser.tab.write.result",
        result:
          request.type === "browser.tab.read"
            ? await this.#browserTabs.read(actor, request.input)
            : await this.#browserTabs.write(
                actor,
                request.input,
                idempotencyKey(claims, request.requestId, "browser.tab.write"),
              ),
      });
    }
    if (request.type === "browser.session.list") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        sessions: await this.#browser.listAgentSessions({
          agentBindingId,
          ownerId: claims.requestedBy,
          workspaceId: claims.workspaceId,
        }),
        type: "browser.session.list.result",
      });
    }
    if (request.type === "browser.session.open") {
      const chosenEnvironmentId = request.environmentId;
      if (chosenEnvironmentId) {
        const environment = await this.#store.getEnvironment(chosenEnvironmentId);
        if (!environment) throw badRequest("Selected execution environment does not exist");
        if (
          !(await this.#store.environmentIsAvailableToUser(chosenEnvironmentId, claims.requestedBy))
        ) {
          throw forbidden("Selected execution environment is unavailable to this user");
        }
      }
      await this.#admit(claims, request);
      const opened = await this.#browser.openAgentSession({
        agentBindingId,
        ...(chosenEnvironmentId ? { chosenEnvironmentId } : {}),
        environmentId: claims.environmentId,
        ...(request.fresh ? { fresh: request.fresh } : {}),
        ownerId: claims.requestedBy,
        ...(request.profileId ? { profileId: request.profileId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        workspaceId: claims.workspaceId,
      });
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        session: opened.session,
        type: "browser.session.open.result",
        wasExisting: opened.wasExisting,
      });
    }
    if (request.type === "browser.session.close") {
      await this.#admit(claims, request);
      return AgentControlResponseSchema.parse({
        requestId: request.requestId,
        sessionId: await this.#browser.closeAgentSession({
          agentBindingId,
          ownerId: claims.requestedBy,
          sessionId: request.sessionId,
          workspaceId: claims.workspaceId,
        }),
        type: "browser.session.close.result",
      });
    }

    // Only delegation forwards structured references; an ordinary agent message grants none.
    if (request.content.some(isPlaceContentPart)) {
      throw badRequest(
        "A message from an agent cannot include a place reference. Forward selected references with thread_delegate places; ordinary messages use text instead.",
      );
    }
    const home = request.threadId === "home";
    const destination = home
      ? (await this.#store.findMainWorkspaceForOwner(claims.requestedBy))?.homeThreadId
      : ThreadIdSchema.parse(request.threadId);
    if (!destination) throw badRequest("Chat has not been started yet");
    if (destination === claims.threadId) {
      throw badRequest("An agent cannot message its own active Thread");
    }
    const thread = await this.#store.getThreadForOwner(destination, claims.requestedBy);
    if (!thread) throw forbidden("Thread is unavailable to this user");
    // Any Thread may leave its person's Home a report. Work there needs the
    // same reach as addressing Home by id.
    if (!home || request.delivery !== "report") this.#assertThreadScope(currentThread, thread);
    const delivered = await this.#commands.enqueueAdmittedThreadInput({
      admission: { kind: "agent", request: this.#admissionRequest(claims, request) },
      input: {
        content: request.content,
        idempotencyKey: idempotencyKey(claims, request.requestId, "message"),
        policy: request.delivery,
        requestedBy: claims.requestedBy,
        source: { kind: "agent", runId: claims.runId },
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

  async #writtenThreadSummary(thread: Thread, requestedBy: AgentControlRunScope["requestedBy"]) {
    const workspace = await this.#store.getWorkspaceForOwner(thread.workspaceId, requestedBy);
    if (!workspace) throw forbidden("Workspace is unavailable to this user");
    return {
      doneAt: thread.doneAt,
      environmentConnected: this.#isEnvironmentConnected(thread.environmentId),
      environmentId: thread.environmentId,
      id: thread.id,
      parentThreadId: thread.parentThreadId,
      pendingRequests: thread.pendingRequests,
      status: thread.status,
      title: thread.title,
      updatedAt: thread.updatedAt,
      workspaceId: thread.workspaceId,
      workspaceName: workspace.name,
    };
  }

  #assertThreadScope(current: Thread, target: Thread): void {
    if (threadInReach(current, target)) return;
    throw forbidden(
      current.capabilityProfileId === "workspace"
        ? "This capability profile can access Threads only in its Workspace"
        : "A delegated Thread can read only Threads in its delegation lineage",
    );
  }

  async #admit(
    claims: AgentControlRunScope,
    request: AgentControlRequest,
  ): Promise<AgentControlAdmissionResult> {
    return this.#store.admitAgentControlRequest(this.#admissionRequest(claims, request));
  }

  #admissionRequest(claims: AgentControlRunScope, request: AgentControlRequest) {
    return {
      action:
        request.type === "trigger.control"
          ? request.tool
          : request.type === "sign-in"
            ? "browser.sign-in"
            : request.type,
      bindingGeneration: claims.bindingGeneration,
      environmentId: claims.environmentId,
      membershipGeneration: claims.membershipGeneration,
      requestFingerprint: createHash("sha256")
        .update(JSON.stringify(request), "utf8")
        .digest("hex"),
      requestId: request.requestId,
      requestedBy: claims.requestedBy,
      runId: claims.runId,
      runnerBootId: claims.runnerBootId,
      runnerId: claims.runnerId,
      sourceThreadId: claims.threadId,
      workspaceId: claims.workspaceId,
    } as const;
  }
}

const toolForAction: Readonly<
  Partial<Record<Exclude<AgentControlRequest["type"], "trigger.control">, AgentToolId>>
> = {
  "machine.full-disk-access.request": "machine.full-disk-access.request",
  "browser.access.request": "browser.access.request",
  "sign-in": "sign-in",
  "browser.profile.create": "browser.profile.create",
  "browser.profile.list": "browser.profile.list",
  "browser.session.close": "browser.session.close",
  "browser.session.list": "browser.session.list",
  "browser.tab.read": "browser.tab.read",
  "browser.tab.write": "browser.tab.write",
  "browser.session.open": "browser.session.open",
  "request.list": "request.list",
  "request.withdraw": "request.withdraw",
  "assignment.cancel": "assignment.cancel",
  "thread.delegate": "thread.delegate",
  "thread.list": "thread.list",
  "thread.message": "thread.message",
  "person.notify": "person.notify",
  "person.show": "person.show",
  "thread.read": "thread.read",
  "thread.write": "thread.write",
  "project.create": "project.create",
  "project.list": "project.list",
  "environment.list": "environment.list",
};

function assertToolAllowed(
  profileId: AgentControlRunScope["capabilityProfileId"],
  request: AgentControlRequest,
): void {
  const toolId = AgentToolIdSchema.parse(
    request.type === "trigger.control" ? request.tool : toolForAction[request.type],
  );
  if (!capabilityProfileAcceptsTool(profileId, toolId)) {
    throw forbidden(`Capability profile ${profileId} does not allow ${toolId}`);
  }
}

/**
 * A Trigger create has no model-supplied idempotency key: the Run that asked
 * for it is the authority, so the key is derived from that Run exactly like
 * every other agent-initiated create.
 */
function triggerControlInput(
  claims: AgentControlRunScope,
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

function threadListScope(current: Thread): AgentThreadListScope {
  switch (current.capabilityProfileId) {
    case "main":
      return { kind: "user" };
    case "workspace":
      return { kind: "workspace", workspaceId: current.workspaceId };
    case "specialist":
    case "delegated":
    case "trigger":
      return { kind: "lineage", threadId: current.id };
  }
}

function idempotencyKey(claims: AgentControlRunScope, requestId: string, action: string): string {
  return `agent:${claims.runId}:${requestId}:${action}`;
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
