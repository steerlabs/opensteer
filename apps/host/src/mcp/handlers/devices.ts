import { immediateRequestResult, requestResult as domainRequestResult } from "../request-result.js";
import type { z } from "zod";
import type { AppAccessRequestInputSchema } from "@opensteer/agent-tools/tools";
import type { IntegrationRequester } from "@opensteer/database";
import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import {
  refused,
  requestOperationCallsMaxLength,
  ThreadIdSchema,
  type Request,
  type DeviceId,
} from "@opensteer/core";
import {
  OperationOutcomeUnknown,
  type AgentSessionService,
  type DirectOperationResult,
  type DirectOperationContext,
} from "../../agent-sessions/agent-session-service.js";
import type { ConnectionCaller } from "../agent-caller.js";
import { directResult, failedScriptOutput, requireDirectWork, scriptFailure } from "./direct.js";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { ComputerInventoryAuthority } from "../../computer-use/computer-use-service.js";
import type { DeviceService } from "../../devices/device-service.js";
import type {
  AccessAsker,
  AccessRequestOrigin,
  AccessRequestOutcome,
  AccessRequests,
} from "../../devices/access-requests.js";
import {
  computerAppRequestShape,
  noComputerUseMac,
  noPhone,
  phoneRequestShape,
  unknownComputerUseMac,
  unknownPhone,
} from "../../devices/computer-use-discovery.js";
import type { ToolCall } from "./types.js";
import { operationId, requireRun } from "../operations.js";

type DeviceToolDevices = Pick<
  DeviceService,
  | "computerAccess"
  | "computerAppApprovals"
  | "computerToolEnabled"
  | "computerUseVersion"
  | "listCallableTools"
  | "runComputerCode"
  | "runSessionComputerCode"
  | "sessionComputerTarget"
  | "runSessionInventory"
  | "store"
>;

/**
 * The device tools: `computer_use`, the listing of Macs, phones and their apps it works from, and
 * the one way a task asks for an app, a phone, a device data app or a local server.
 */
export class DeviceToolHandlers {
  readonly #devices: DeviceToolDevices;
  readonly #access: Pick<AccessRequests, "requestDataApp" | "requestLocalServer">;
  readonly #sessions: AgentSessionService | undefined;
  constructor(options: {
    readonly devices: DeviceToolDevices;
    readonly access: Pick<AccessRequests, "requestDataApp" | "requestLocalServer">;
    /** The session pipeline a connected agent's own `computer_use` runs through. */
    readonly sessions?: AgentSessionService;
  }) {
    this.#devices = options.devices;
    this.#access = options.access;
    this.#sessions = options.sessions;
  }

  async computer_use(call: ToolCall<"computer_use">) {
    if (call.caller.kind === "connection") return this.#sessionComputerUse(call.caller, call);
    const run = requireRun(call.caller).claims;
    if (!(await this.#devices.computerToolEnabled(run)))
      throw refused(
        "conflict",
        "computer_use is not available on this computer yet. Update Opensteer on it to use it.",
      );
    return this.#devices.runComputerCode(
      { run, threadId: run.threadId, agentBindingId: `run:${run.runId}` },
      call.input.code,
      call.signal ?? AbortSignal.timeout(100_000),
    );
  }

  /**
   * A connected agent drives the one app or phone screen it names, reviewed as one operation on
   * that target: the script is shown in full, and every callback stays on that target.
   */
  async #sessionComputerUse(caller: ConnectionCaller, call: ToolCall<"computer_use">) {
    const { code, computerId, app, taskId, reason, readOnly = false } = call.input;
    if (!computerId)
      throw refused(
        "bad_request",
        "Name the app or phone screen shared with you: computerId, and app for a Mac app, from computer_apps.",
      );
    if (code.length > requestOperationCallsMaxLength)
      throw refused(
        "bad_request",
        `Use at most ${requestOperationCallsMaxLength.toLocaleString("en-US")} characters per connected computer operation.`,
      );
    const named = await this.#devices.sessionComputerTarget(
      { ownerUserId: caller.userId, connectionId: caller.connectionId },
      computerId,
      app,
    );
    if (!readOnly && named.access === "read")
      throw refused("forbidden", "This target allows observation only. Use readOnly: true.");
    return sessionScriptOutput(
      await requireDirectWork(this.#sessions).run({
        ownerUserId: caller.userId,
        agentConnectionId: caller.connectionId,
        taskId,
        reason,
        operationKey: call.operationKey,
        tool: "computer_use",
        input: call.input,
        target: named.target,
        targetGeneration: named.generation,
        effect: readOnly ? "read" : "write",
        calls: code,
        execute: async (context) => {
          await context.recheck();
          const result = await this.#devices.runSessionComputerCode(
            {
              ownerUserId: context.ownerUserId,
              sessionId: context.sessionId,
              taskId: context.taskId,
              bindingId: context.bindingId,
              target: named.connectionId,
              deviceId: named.deviceId,
              ...(named.driver ? { driver: named.driver } : {}),
              generation: named.generation,
              readOnly,
              recheck: context.recheck,
            },
            code,
            context.signal,
          );
          context.signal.throwIfAborted();
          const failure = result.structuredContent?.error;
          if (failure?.code === "outcome-unknown")
            throw new OperationOutcomeUnknown(failure.message);
          return result;
        },
        scriptFailure,
        summarize: (result) => ({
          failed: result.isError === true,
          content: result.content.length,
        }),
      }),
    );
  }

  async computer_apps(call: ToolCall<"computer_apps">) {
    const caller = call.caller;
    if (caller.kind === "connection")
      await this.#devices.store.connectionDiscoveryScope(caller.userId, caller.connectionId);
    const requester: IntegrationRequester & { readonly direct?: true } =
      caller.kind === "connection"
        ? // A connected agent drives what it holds itself, through computer_use.
          { ownerUserId: caller.userId, connectionId: caller.connectionId, direct: true }
        : { ownerUserId: caller.userId, agentBindingId: caller.key };
    const run = caller.kind === "run" ? caller.claims : null;
    const { computerId, query, limit } = call.input;
    const offset = call.input.cursor ?? 0;
    return computerId
      ? this.#installedApps(requester, run, computerId, query, limit, offset, call)
      : this.#overview(requester, run);
  }

  async app_access_request(call: ToolCall<"app_access_request">) {
    const caller = call.caller;
    const { operationKey: _operationKey, ...input } = call.input;
    const callId = operationId(caller, call.operationKey, "app_access_request");
    if (input.dataApp === undefined && input.server === undefined) {
      const { claims } = requireRun(caller);
      return (
        (await this.#replay({ originatingRunId: claims.runId }, callId)) ??
        (input.app === undefined
          ? this.#requestPhone(claims, input, callId)
          : this.#requestComputerApp(claims, { ...input, app: input.app }, callId))
      );
    }
    const scope =
      caller.kind === "run"
        ? caller.claims
        : caller.kind === "program" && caller.program.kind === "trigger"
          ? caller.program
          : null;
    if (!scope)
      throw refused(
        "forbidden",
        "Only a running task or Trigger occurrence can ask for local access.",
      );
    const origin =
      "runId" in scope
        ? { originatingRunId: scope.runId }
        : { originatingOccurrenceId: scope.occurrenceId };
    const replay = await this.#replay(origin, callId);
    if (replay) return replay;
    const asker: AccessAsker = {
      origin,
      callId,
      reason: input.reason,
      requestedBy: scope.requestedBy,
      threadId: scope.threadId,
    };
    const outcome =
      input.dataApp !== undefined
        ? await this.#access.requestDataApp(asker, {
            dataApp: input.dataApp,
            computerId: input.computerId,
            access: input.access,
          })
        : await this.#access.requestLocalServer(asker, {
            server: input.server!,
            access: input.access,
          });
    return accessResult(outcome, caller.kind === "run");
  }

  /**
   * Asks for one app on one Mac. Which Mac is decided here rather than by the model: the id it
   * named, otherwise the Mac this task is already running on, and otherwise nothing — a
   * Deployment with several Macs is a choice a person makes, so the refusal names the eligible
   * ones instead of picking.
   */
  async #requestComputerApp(
    scope: RunToolScope,
    input: { readonly app: string; readonly computerId?: DeviceId | undefined } & Pick<
      z.infer<typeof AppAccessRequestInputSchema>,
      "access" | "reason"
    >,
    callId: string,
  ) {
    const { machines: macs, phones } =
      await this.#devices.computerAppApprovals.computerUseInventory(scope.requestedBy);
    const executingDeviceId = await this.#devices.store.requireSelfDeviceId(scope.runnerId);
    const named = input.computerId
      ? macs.find(({ deviceId }) => deviceId === input.computerId)
      : (macs.find(({ deviceId }) => deviceId === executingDeviceId) ??
        (macs.length === 1 ? macs[0] : undefined));
    if (!named) {
      const phone = input.computerId
        ? phones.find(({ deviceId }) => deviceId === input.computerId)
        : undefined;
      if (phone)
        throw refused(
          "bad_request",
          `${phone.name} is a phone, which is asked for whole: call ${phoneRequestShape} without app.`,
        );
      if (macs.length === 0) throw refused("conflict", noComputerUseMac);
      throw refused(
        "bad_request",
        input.computerId
          ? `That computer is not one of yours set up for computer use. These are: ${macs.map(({ name }) => name).join(", ")}.`
          : `This task is not running on a Mac set up for computer use, so name one with computerId. These are set up: ${macs
              .map(({ name, deviceId }) => `${name} (${deviceId})`)
              .join(", ")}.`,
      );
    }
    const created = await this.#devices.computerAppApprovals.requestComputerAppAccess({
      access: input.access,
      app: input.app,
      reason: input.reason,
      callId,
      originatingRunId: scope.runId,
      ownerUserId: scope.requestedBy,
      deviceId: named.deviceId,
      threadId: scope.threadId,
    });
    return computerAccessResult(created);
  }

  /**
   * Asks for a whole phone, which only ever means one of this person's phones on this
   * Deployment, named by its id: nothing here picks a phone, and a phone of somebody else's is
   * the same unknown id as a typo.
   */
  async #requestPhone(
    scope: RunToolScope,
    input: Omit<z.infer<typeof AppAccessRequestInputSchema>, "operationKey">,
    callId: string,
  ) {
    const { machines, phones } = await this.#devices.computerAppApprovals.computerUseInventory(
      scope.requestedBy,
    );
    const phone = phones.find(({ deviceId }) => deviceId === input.computerId);
    if (!phone) {
      const mac = machines.find(({ deviceId }) => deviceId === input.computerId);
      throw refused(
        "bad_request",
        mac
          ? `${mac.name} is a Mac, whose apps are asked for one at a time: call ${computerAppRequestShape}.`
          : phones.length === 0
            ? noPhone
            : unknownPhone(input.computerId ?? ""),
      );
    }
    const created = await this.#devices.computerAppApprovals.requestComputerAppAccess({
      access: input.access,
      app: null,
      reason: input.reason,
      callId,
      originatingRunId: scope.runId,
      ownerUserId: scope.requestedBy,
      deviceId: phone.deviceId,
      threadId: scope.threadId,
    });
    return computerAccessResult(created);
  }

  /** A retried ask answers with the Request it already opened. */
  async #replay(origin: AccessRequestOrigin, callId: string) {
    const replay = await this.#devices.store.requests.findByCallIdentity({
      ...origin,
      callId,
    });
    if (!replay) return null;
    if (replay.kind !== "integration.access" && replay.kind !== "computer.app.access")
      throw new Error("MCP call identity belongs to another Request kind");
    return requestResult(replay, true, origin.originatingRunId !== undefined);
  }

  /**
   * Approvals already waiting for this person: app setup requests on a Mac, phone access
   * Requests, and grant requests by requested connection. The listing reads them so it never
   * tells the model to ask a second time.
   */

  async #installedApps(
    requester: IntegrationRequester,
    run: RunToolScope | null,
    deviceId: DeviceId,
    query: string,
    limit: number,
    offset: number,
    call: ToolCall<"computer_apps">,
  ) {
    const approvals = this.#devices.computerAppApprovals;
    const access = await this.#devices.computerAccess(requester, run ?? undefined);
    const nextCursor = (total: number, count: number) =>
      offset + count < total ? String(offset + limit) : null;
    const phone = access.phones.find((candidate) => candidate.deviceId === deviceId);
    if (phone && isPhoneDisplayDefinitionId(phone.definitionId)) {
      const definitionId = phone.definitionId;
      return this.#liveInventory(call, deviceId, phone.name, true, async (authority) => {
        const installed = await approvals.installedComputerApps(
          {
            actorUserId: requester.ownerUserId,
            deviceId,
            query,
            limit,
            offset,
            definitionId,
          },
          access.phones,
          authority,
        );
        return {
          apps: installed.apps,
          total: installed.total,
          nextCursor: nextCursor(installed.total, installed.apps.length),
        };
      });
    }
    const machine = access.machines.find((candidate) => candidate.deviceId === deviceId);
    if (!machine)
      throw refused(
        "not_found",
        access.grantScoped
          ? "That computer is unavailable to this connected agent."
          : unknownComputerUseMac(deviceId),
      );
    if (access.grantScoped) {
      // A selected grant learns nothing else installed on the Mac: only its own apps, paged.
      const needle = query.toLowerCase();
      const granted = access
        .appEntries(machine)
        .filter(
          (app) =>
            !needle ||
            app.name.toLowerCase().includes(needle) ||
            app.bundleId.toLowerCase().includes(needle),
        )
        .map(({ id: _id, ...app }) => app);
      const apps = granted.slice(offset, offset + limit);
      return {
        computer: { computerId: deviceId, name: machine.name, ...access.machine(machine), apps },
        total: granted.length,
        nextCursor: nextCursor(granted.length, apps.length),
      };
    }
    return this.#liveInventory(call, deviceId, machine.name, false, async (authority) => {
      const installed = await approvals.installedComputerApps(
        { actorUserId: requester.ownerUserId, deviceId, query, limit, offset, icons: false },
        access.machines,
        authority,
      );
      const apps = installed.apps.map(({ identity }) => ({
        name: identity.displayName,
        bundleId: identity.bundleId,
        ...access.app(machine, identity),
      }));
      return {
        computer: { computerId: deviceId, name: machine.name, ...access.machine(machine), apps },
        total: installed.total,
        nextCursor: nextCursor(installed.total, apps.length),
      };
    });
  }

  async #liveInventory<Result extends { readonly total: number }>(
    call: ToolCall<"computer_apps">,
    deviceId: DeviceId,
    name: string,
    phone: boolean,
    read: (authority?: ComputerInventoryAuthority) => Promise<Result>,
  ) {
    const caller = call.caller;
    if (caller.kind !== "connection") return read();
    const named = phone
      ? await this.#devices.sessionComputerTarget(
          { ownerUserId: caller.userId, connectionId: caller.connectionId },
          deviceId,
          undefined,
        )
      : null;
    return directResult(
      await requireDirectWork(this.#sessions).run({
        ownerUserId: caller.userId,
        agentConnectionId: caller.connectionId,
        taskId: ThreadIdSchema.optional().parse(
          "taskId" in call.input ? call.input.taskId : undefined,
        ),
        operationKey: call.operationKey,
        tool: "computer_apps",
        input: call.input,
        target: named?.target ?? null,
        targetName: name,
        targetGeneration: named?.generation ?? null,
        effect: "read",
        calls: "List installed apps",
        execute: async (context: DirectOperationContext) => {
          await context.recheck();
          const result = await this.#devices.runSessionInventory(
            deviceId,
            context,
            context.signal,
            named
              ? {
                  ...context,
                  target: named.connectionId,
                  deviceId,
                  generation: named.generation,
                  readOnly: true,
                  ...(named.driver ? { driver: named.driver } : {}),
                }
              : undefined,
            read,
          );
          context.signal.throwIfAborted();
          return result;
        },
        summarize: ({ total }) => ({ count: total }),
      }),
    );
  }

  // Cached discovery only; no device receives a lookup.
  async #overview(requester: IntegrationRequester, run: RunToolScope | null) {
    const access = await this.#devices.computerAccess(requester, run ?? undefined);
    return {
      ...(access.machines.length && access.phones.length
        ? {}
        : {
            guidance: {
              ...(!access.machines.length ? { computers: noComputerUseMac } : {}),
              ...(!access.phones.length ? { phones: noPhone } : {}),
            },
          }),
      computers: access.machines.map((machine) => ({
        computerId: machine.deviceId,
        name: machine.name,
        ...access.machine(machine),
        apps: access.appEntries(machine).map(({ id: _id, ...app }) => app),
      })),
      phones: access.phones.map((phone) => ({
        computerId: phone.deviceId,
        definitionId: phone.definitionId,
        name: phone.name,
        ...access.phone(phone),
      })),
    };
  }
}

/**
 * A connected agent's `computer_use` answer in the tool's own shape: the script's content, or a
 * line saying what to do next, with the task and operation receipt beside it.
 */
function sessionScriptOutput(
  outcome: DirectOperationResult<Awaited<ReturnType<DeviceService["runSessionComputerCode"]>>>,
) {
  if (outcome.status === "failed" && outcome.scriptError) {
    const { status, taskId, operationId, next } = outcome;
    return failedScriptOutput(
      { status, taskId, operationId, next },
      outcome.scriptError,
      outcome.result?.content,
    );
  }
  const receipt = directResult(
    outcome.status === "completed"
      ? { status: outcome.status, taskId: outcome.taskId, operationId: outcome.operationId }
      : outcome,
  );
  if (outcome.status === "completed")
    return outcome.result
      ? {
          ...outcome.result,
          structuredContent: { ...outcome.result.structuredContent, ...receipt },
        }
      : {
          content: [{ type: "text" as const, text: "This script already ran." }],
          structuredContent: receipt,
        };
  return {
    content: [{ type: "text" as const, text: outcome.next }],
    structuredContent: receipt,
  };
}

/** What a task's ask for an app or a phone answers. */
function computerAccessResult(
  created: Awaited<ReturnType<DeviceService["computerAppApprovals"]["requestComputerAppAccess"]>>,
) {
  if (created.status === "pending") return requestResult(created.request, created.replayed);
  return {
    ...immediateRequestResult(
      "computer.app.access",
      "fulfilled",
      created.app
        ? `${created.app.displayName} on ${created.computer} is ready. Use app(${JSON.stringify(created.app.displayName)}, {computer:${JSON.stringify(created.computer)}}) in computer_use.`
        : `${created.computer} is ready. Use phone(${JSON.stringify(created.computerId)}) in computer_use.`,
    ),
    computerId: created.computerId,
    computer: created.computer,
    app: created.app,
  };
}
function accessResult(outcome: AccessRequestOutcome, fromRun: boolean) {
  if (outcome.kind === "request") return requestResult(outcome.request, outcome.replayed, fromRun);
  return {
    ...immediateRequestResult(
      "integration.access",
      "fulfilled",
      `${outcome.name} has a personal ${outcome.access} grant. This task's access mode still limits execution. Use plugin_search for its tools.`,
    ),
    replayed: false,
  };
}
function requestResult(
  request: Pick<Request, "id" | "kind" | "status">,
  replayed: boolean,
  fromRun = true,
) {
  return domainRequestResult(request, requestGuidance(request, replayed, fromRun), replayed);
}
function requestGuidance(
  request: Pick<Request, "kind" | "status">,
  replayed: boolean,
  fromRun: boolean,
): string {
  switch (request.status) {
    case "pending":
      if (!fromRun)
        return `${replayed ? "An equivalent Request is already pending. " : ""}The person can approve this Request from any Opensteer app. Nothing is granted until they answer. A later occurrence can check access.`;
      return `${replayed ? "An equivalent Request is already pending; its outcome goes to the task that opened it. " : ""}The person has been asked to approve from any Opensteer app. Nothing is granted until they answer; you will be told in the originating task when they answer.`;
    case "fulfilled":
      return request.kind === "computer.app.access"
        ? "This request was fulfilled. Use computer_use with the approved app or phone."
        : "This request was fulfilled. Use plugin_search for its tools.";
    case "declined":
      return "The person declined this request. Continue without it.";
    case "withdrawn":
      return "This request was withdrawn. Continue without it.";
    case "cancelled":
      return "This request was cancelled. Check current access if the task still needs it.";
  }
}
