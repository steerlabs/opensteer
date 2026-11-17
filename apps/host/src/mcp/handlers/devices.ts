import type { z } from "zod";
import type { AppAccessRequestInputSchema } from "@opensteer/agent-tools/tools";
import { computerAppIdentityKey } from "@opensteer/integration-core";
import type { IntegrationRequester } from "@opensteer/database";
import { androidPhoneDefinitionId } from "@opensteer/protocol";
import { formatReferenceLink, refused, type Request, type RunnerId } from "@opensteer/core";
import {
  computerUseDefinitionId,
  computerUseHolderKey,
} from "../../computer-use/computer-use-service.js";
import type { RunToolScope } from "../../agents/run-tool-tokens.js";
import type { DeviceService } from "../../devices/device-service.js";
import type { AccessRequestOutcome, AccessRequests } from "../../devices/access-requests.js";
import {
  computerAppDiscovery,
  computerAppRequestShape,
  computerToolRefs,
  noComputerUseMac,
  noPhone,
  pendingOnComputerNextAction,
  phoneDiscovery,
  phoneRequestShape,
  unknownComputerUseMac,
  unknownPhone,
} from "../../devices/computer-use-discovery.js";
import type { ToolCall } from "./types.js";
import { operationId, requireRun } from "../operations.js";

type DeviceToolDevices = Pick<
  DeviceService,
  | "computerAppApprovals"
  | "computerToolEnabled"
  | "computerUseVersion"
  | "listCallableTools"
  | "runComputerCode"
  | "store"
>;

/**
 * The device tools: `computer_use`, the listing of Macs, phones and their apps it works from, and
 * the one way a task asks for an app, a phone, a device data app or a local server.
 */
export class DeviceToolHandlers {
  readonly #devices: DeviceToolDevices;
  readonly #access: Pick<AccessRequests, "requestDataApp" | "requestLocalServer">;
  constructor(options: {
    readonly devices: DeviceToolDevices;
    readonly access: Pick<AccessRequests, "requestDataApp" | "requestLocalServer">;
  }) {
    this.#devices = options.devices;
    this.#access = options.access;
  }

  async computer_use(call: ToolCall<"computer_use">) {
    const run = requireRun(call.caller).claims;
    if (!(await this.#devices.computerToolEnabled(run)))
      throw refused(
        "conflict",
        "computer_use is not available on this computer yet. Update Opensteer on it to use it.",
      );
    return this.#devices.runComputerCode(
      { run, threadId: run.threadId },
      call.input.code,
      call.signal ?? AbortSignal.timeout(100_000),
    );
  }

  async computer_apps(call: ToolCall<"computer_apps">) {
    const caller = call.caller;
    if (caller.kind === "connection")
      await this.#devices.store.connectionDiscoveryScope(caller.userId, caller.connectionId);
    const requester: IntegrationRequester =
      caller.kind === "connection"
        ? { ownerUserId: caller.userId, connectionId: caller.connectionId }
        : {
            ownerUserId: caller.userId,
            threadId: caller.kind === "run" ? caller.thread.id : caller.anchor.id,
          };
    const run = caller.kind === "run" ? caller.claims : null;
    const { computerId, query, limit } = call.input;
    const offset = call.input.cursor ?? 0;
    return computerId
      ? this.#installedApps(requester, run, computerId, query, limit, offset)
      : this.#overview(requester, run);
  }

  async app_access_request(call: ToolCall<"app_access_request">) {
    const { operationKey: _operationKey, ...input } = call.input;
    const scope = requireRun(call.caller).claims;
    const callId = operationId(call.caller, call.operationKey, "app_access_request");
    return (await this.#replay(scope, callId)) ?? (await this.#request(scope, input, callId));
  }

  async #request(
    scope: RunToolScope,
    input: Omit<z.infer<typeof AppAccessRequestInputSchema>, "operationKey">,
    callId: string,
  ) {
    const asker = {
      callId,
      reason: input.reason,
      requestedBy: scope.requestedBy,
      runId: scope.runId,
      threadId: scope.threadId,
    };
    if (input.dataApp !== undefined)
      return accessResult(
        await this.#access.requestDataApp(asker, {
          dataApp: input.dataApp,
          computerId: input.computerId,
          access: input.access,
        }),
      );
    if (input.server !== undefined)
      return accessResult(
        await this.#access.requestLocalServer(asker, {
          server: input.server,
          access: input.access,
        }),
      );
    if (input.app === undefined) return this.#requestPhone(scope, input, callId);
    return this.#requestComputerApp(scope, { ...input, app: input.app }, callId);
  }

  /**
   * Asks for one app on one Mac. Which Mac is decided here rather than by the model: the id it
   * named, otherwise the Mac this task is already running on, and otherwise nothing — a
   * Deployment with several Macs is a choice a person makes, so the refusal names the eligible
   * ones instead of picking.
   */
  async #requestComputerApp(
    scope: RunToolScope,
    input: { readonly app: string; readonly computerId?: RunnerId | undefined } & Pick<
      z.infer<typeof AppAccessRequestInputSchema>,
      "access" | "reason"
    >,
    callId: string,
  ) {
    const { machines: macs, phones } =
      await this.#devices.computerAppApprovals.computerUseInventory(scope.requestedBy);
    const named = input.computerId
      ? macs.find(({ runnerId }) => runnerId === input.computerId)
      : (macs.find(({ runnerId }) => runnerId === scope.runnerId) ??
        (macs.length === 1 ? macs[0] : undefined));
    if (!named) {
      const phone = input.computerId
        ? phones.find(({ runnerId }) => runnerId === input.computerId)
        : undefined;
      if (phone)
        throw refused(
          "bad_request",
          `${phone.name} is an Android phone, which is asked for whole: call ${phoneRequestShape} without app.`,
        );
      if (macs.length === 0) throw refused("conflict", noComputerUseMac);
      throw refused(
        "bad_request",
        input.computerId
          ? `That computer is not one of yours set up for computer use. These are: ${macs.map(({ name }) => name).join(", ")}.`
          : `This task is not running on a Mac set up for computer use, so name one with computerId. These are set up: ${macs
              .map(({ name, runnerId }) => `${name} (${runnerId})`)
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
      runnerId: named.runnerId,
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
    const phone = phones.find(({ runnerId }) => runnerId === input.computerId);
    if (!phone) {
      const mac = machines.find(({ runnerId }) => runnerId === input.computerId);
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
      runnerId: phone.runnerId,
      threadId: scope.threadId,
    });
    return computerAccessResult(created);
  }

  /** A retried ask answers with the Request it already opened. */
  async #replay(scope: RunToolScope, callId: string) {
    const replay = await this.#devices.store.requests.findByCallIdentity({
      originatingRunId: scope.runId,
      callId,
    });
    if (!replay) return null;
    if (replay.kind !== "integration.access" && replay.kind !== "computer.app.access")
      throw new Error("MCP call identity belongs to another Request kind");
    if (replay.payload?.kind === "computer.app.access" && replay.status === "pending") {
      const runnerId = replay.payload.runnerId;
      const { machines, phones } = await this.#devices.computerAppApprovals.computerUseInventory(
        scope.requestedBy,
      );
      const computer = [...machines, ...phones].find((machine) => machine.runnerId === runnerId);
      if (computer)
        return pendingResult(replay, true, pendingOnComputerNextAction(computer.name));
    }
    return requestResult(replay, true);
  }

  /**
   * Approvals already waiting for this person: app setup requests on a Mac, phone access
   * Requests, and grant requests by requested connection. The listing reads them so it never
   * tells the model to ask a second time.
   */
  async #pendingApprovals(ownerUserId: IntegrationRequester["ownerUserId"]) {
    const store = this.#devices.store;
    const [setupRequests, accessRequests] = await Promise.all([
      store.listComputerAppSetupRequests(ownerUserId),
      store.integrationRequests.listPendingIntegrationAccessRequests(ownerUserId),
    ]);
    const onMacRequests = setupRequests.flatMap(({ kind, definitionId, runnerId, app, access }) =>
      kind === "app" && definitionId === computerUseDefinitionId && app
        ? [{ runnerId, app, access }]
        : [],
    );
    const phoneAccessRunners = new Set(
      setupRequests.flatMap(({ kind, definitionId, runnerId }) =>
        kind === "app" && definitionId === androidPhoneDefinitionId ? [runnerId] : [],
      ),
    );
    const grants = new Set(
      accessRequests.flatMap(({ requestedConnectionId }) =>
        requestedConnectionId ? [requestedConnectionId] : [],
      ),
    );
    return {
      onMacRequests,
      onMac: (runnerId: RunnerId, appKey: string) =>
        onMacRequests.some(
          (request) =>
            request.runnerId === runnerId && computerAppIdentityKey(request.app) === appKey,
        ),
      phoneAccess: (runnerId: RunnerId) => phoneAccessRunners.has(runnerId),
      grant: (connectionId: string) => grants.has(connectionId as never),
    };
  }

  async #installedApps(
    requester: IntegrationRequester,
    run: RunToolScope | null,
    runnerId: RunnerId,
    query: string,
    limit: number,
    offset: number,
  ) {
    const approvals = this.#devices.computerAppApprovals;
    const computerEnabled = run !== null && (await this.#devices.computerToolEnabled(run));
    const nextCursor = (more: boolean) => (more ? String(offset + limit) : null);
    const inventory = await approvals.computerUseInventory(requester.ownerUserId);
    const phone = inventory.phones.find((candidate) => candidate.runnerId === runnerId);
    if (phone) {
      const installed = await approvals.installedComputerApps(
        {
          actorUserId: requester.ownerUserId,
          runnerId,
          query,
          limit,
          offset,
          definitionId: androidPhoneDefinitionId,
        },
        inventory.phones,
      );
      return {
        apps: installed.apps,
        total: installed.total,
        nextCursor: nextCursor(offset + installed.apps.length < installed.total),
      };
    }
    const machine = inventory.machines.find((candidate) => candidate.runnerId === runnerId);
    if (!machine) throw refused("not_found", unknownComputerUseMac(runnerId));
    const [installed, callable, pending] = await Promise.all([
      approvals.installedComputerApps(
        { actorUserId: requester.ownerUserId, runnerId, query, limit, offset, icons: false },
        inventory.machines,
      ),
      this.#devices.listCallableTools(requester),
      this.#pendingApprovals(requester.ownerUserId),
    ]);
    if (installed.unavailableReason)
      throw refused(
        "conflict",
        installed.unavailableReason === "offline"
          ? `${machine.name} is offline.`
          : `${machine.name} isn’t ready to list apps yet.`,
      );
    const holders = approvals.computerAppHolders(runnerId);
    const apps = installed.apps.map(({ identity }) => {
      const key = computerAppIdentityKey(identity);
      const approved = machine.apps.find(({ bundleId }) => bundleId.toLowerCase() === key);
      const toolRefs =
        approved?.status === "approved" ? computerToolRefs(callable, approved.connectionId) : {};
      const holder = holders.get(key);
      const discovery = computerAppDiscovery({
        app: identity.displayName,
        machine,
        approval: approved ?? null,
        callable: !!toolRefs.observe,
        pendingOnMac: pending.onMac(runnerId, key),
        pendingPersonalGrant: !!approved && pending.grant(approved.connectionId),
        heldByAnotherRun: holder && !(run && holder.runId === run.runId) ? holder : null,
      });
      return {
        name: identity.displayName,
        bundleId: identity.bundleId,
        status: discovery.status,
        callable:
          !!toolRefs.observe &&
          !discovery.pending &&
          !discovery.inUse &&
          computerEnabled &&
          machine.state === "ready" &&
          this.#devices.computerUseVersion(runnerId) === 2,
        ...(approved?.status === "approved" ? { access: approved.access } : {}),
        ...(discovery.pending ? { pending: discovery.pending } : {}),
        ...(discovery.inUse ? { inUse: discovery.inUse } : {}),
        ...(discovery.inUse && holder?.threadTitle ? { heldByTask: holder.threadTitle } : {}),
      };
    });
    return {
      guidance: { computers: computerGuidance },
      computer: {
        computerId: runnerId,
        name: machine.name,
        state: machine.state,
        computerToolEnabled: computerEnabled,
        computerUseVersion: this.#devices.computerUseVersion(runnerId),
        appApproval: machine.appApproval,
      },
      apps,
      total: installed.total,
      nextCursor: nextCursor(offset + apps.length < installed.total),
    };
  }

  async #overview(requester: IntegrationRequester, run: RunToolScope | null) {
    const approvals = this.#devices.computerAppApprovals;
    const computerEnabled = run !== null && (await this.#devices.computerToolEnabled(run));
    const [{ machines, phones }, callable, pending] = await Promise.all([
      approvals.computerUseInventory(requester.ownerUserId),
      this.#devices.listCallableTools(requester),
      this.#pendingApprovals(requester.ownerUserId),
    ]);
    const heldElsewhere = <Holder extends { readonly runId: string }>(holder: Holder | undefined) =>
      holder && !(run && holder.runId === run.runId) ? holder : null;
    const computers = machines.map(({ runnerId, name, state, appApproval, apps }) => {
      const machine = { name, state, appApproval };
      const holders = approvals.computerAppHolders(runnerId);
      return {
        computerId: runnerId,
        name,
        state,
        appApproval,
        computerToolEnabled: computerEnabled,
        computerUseVersion: this.#devices.computerUseVersion(runnerId),
        apps: [
          ...apps.map(({ connectionId, ...app }) => {
            const key = app.bundleId.toLowerCase();
            const toolRefs = app.status === "approved" ? computerToolRefs(callable, connectionId) : {};
            const holder = holders.get(key);
            const discovery = computerAppDiscovery({
              app: app.name,
              machine,
              approval: app,
              callable: !!toolRefs.observe,
              pendingOnMac: pending.onMac(runnerId, key),
              pendingPersonalGrant: pending.grant(connectionId),
              heldByAnotherRun: heldElsewhere(holder),
            });
            return {
              ...app,
              callable:
                !!toolRefs.observe &&
                !discovery.pending &&
                !discovery.inUse &&
                computerEnabled &&
                state === "ready" &&
                this.#devices.computerUseVersion(runnerId) === 2,
              ...(discovery.pending ? { pending: discovery.pending } : {}),
              ...(discovery.inUse ? { inUse: discovery.inUse } : {}),
              ...(discovery.inUse && holder?.threadTitle ? { heldByTask: holder.threadTitle } : {}),
            };
          }),
          // An app asked for but not yet approved has no connection, so the Mac's list would
          // otherwise omit exactly what is waiting.
          ...pending.onMacRequests
            .filter(
              (request) =>
                request.runnerId === runnerId &&
                !apps.some(
                  ({ bundleId }) => bundleId.toLowerCase() === computerAppIdentityKey(request.app),
                ),
            )
            .map(({ access, app }) => ({
              name: app.displayName,
              bundleId: app.bundleId,
              access,
              status: "not-approved" as const,
              callable: false,
              pending: "mac" as const,
            })),
        ],
      };
    });
    const phoneRows = phones.map(({ connection, name, runnerId, state }) => {
      const toolRefs = connection ? computerToolRefs(callable, connection.connectionId) : {};
      const holder = approvals
        .computerAppHolders(runnerId)
        .get(computerUseHolderKey({ definitionId: androidPhoneDefinitionId, kind: "display" }));
      const holdsTools = toolRefs.observe !== undefined;
      const discovery = phoneDiscovery({
        callable: holdsTools,
        canAct: toolRefs.act !== undefined,
        connection,
        heldByAnotherRun: heldElsewhere(holder),
        pendingPhoneAccess: pending.phoneAccess(runnerId),
        pendingPersonalGrant: connection !== null && pending.grant(connection.connectionId),
        phone: { name, state },
      });
      return {
        computerId: runnerId,
        name,
        state,
        approval: discovery.approval,
        // What this task may do when it holds the phone's tools, which the owner's grant can
        // narrow; else what the phone allows.
        ...(holdsTools
          ? { access: toolRefs.act !== undefined ? "read-write" : "read" }
          : connection
            ? { access: connection.access }
            : {}),
        ...(discovery.inUse ? { inUse: true } : {}),
        callable:
          holdsTools &&
          computerEnabled &&
          discovery.approval === "approved" &&
          !discovery.inUse &&
          state === "ready",
        computerToolEnabled: computerEnabled,
        ...(discovery.inUse && holder?.threadTitle ? { heldByTask: holder.threadTitle } : {}),
      };
    });
    return {
      guidance: {
        computers: computers.length ? computerGuidance : noComputerUseMac,
        phones: phoneRows.length ? phoneGuidance : noPhone,
      },
      computers,
      phones: phoneRows,
    };
  }
}

const computerGuidance = `Check computerToolEnabled, computerUseVersion and the computer state first, then blocked, pending and inUse before callable. Call computer_apps with computerId to list installed apps. Request an app with ${computerAppRequestShape}; read observes, read-write also acts. appApproval:automatic makes the app available immediately; ask requires the computer owner to approve from any Opensteer app. blocked: only the computer owner can unblock it from any Opensteer app; never work around it. pending:mac waits for its owner; Pending grants no access; do not poll, repeat or route around the Request. inUse: another task holds the app; report heldByTask when present and continue other work or tell the person it is busy; do not retry in a loop or stop that task. With callable:true, use app() in computer_use. computerToolEnabled:false: update Opensteer on the computer this task runs on; computerUseVersion other than 2: update Opensteer on that Mac. Computer state offline: wait for it to return; permission-required: the person must enable macOS Accessibility and Screen Recording for Opensteer Computer Use; unavailable: install the Opensteer desktop app on that Mac.`;

const phoneGuidance = `Check computerToolEnabled first, then approval:pending, state and inUse before callable. Request a whole phone with ${phoneRequestShape}; the owner approves from any Opensteer app. read observes; read-write also acts. approval:pending waits for the owner and grants no access; do not poll, repeat or route around the Request. state offline: wait for it to return; permission-required: ask the person to enable its Opensteer accessibility service in phone settings; unavailable: tell the person it is not taking agent work (it may be paused). inUse: another task holds the phone; report heldByTask when present and continue other work or tell the person it is busy; do not retry in a loop or stop that task. With callable:true, use phone() in computer_use; release when done so another task can use it. computerToolEnabled:false: update Opensteer on the computer this task runs on. For more access, request read-write.`;

/** What a task's ask for an app or a phone answers, pending or ready for computer use. */
function computerAccessResult(
  created: Awaited<ReturnType<DeviceService["computerAppApprovals"]["requestComputerAppAccess"]>>,
) {
  if (created.status === "pending") {
    if (created.request.kind !== "computer.app.access" || created.request.status !== "pending")
      return requestResult(created.request, created.replayed);
    return pendingResult(created.request, created.replayed, created.nextAction);
  }
  return {
    status: created.status,
    nextAction: "Use computer_use to see and operate approved apps and phones.",
  };
}

function accessResult(outcome: AccessRequestOutcome) {
  if (outcome.kind === "request") return requestResult(outcome.request, outcome.replayed);
  return {
    alreadyGranted: true,
    kind: "integration.access" as const,
    requestId: null,
    replayed: false,
    status: "fulfilled" as const,
    guidance: `You already have ${outcome.access} access to ${outcome.name}. Use plugin_search for its tools; do not request it again.`,
  };
}

function pendingResult(
  request: Pick<Request, "id" | "kind" | "status">,
  replayed: boolean,
  nextAction: string,
) {
  return {
    kind: request.kind,
    requestId: request.id,
    link: formatReferenceLink(request.id, "Request"),
    status: request.status,
    replayed,
    nextAction,
  };
}

function requestResult(request: Pick<Request, "id" | "kind" | "status">, replayed: boolean) {
  return {
    kind: request.kind,
    replayed,
    requestId: request.id,
    link: formatReferenceLink(request.id, "Request"),
    status: request.status,
    guidance: requestGuidance(request, replayed),
  };
}

function requestGuidance(request: Pick<Request, "kind" | "status">, replayed: boolean): string {
  switch (request.status) {
    case "pending": {
      // Approving a Mac app happens on the computer itself, so the sentence says where rather
      // than letting an agent wait for a click anywhere else.
      const asked =
        request.kind === "computer.app.access"
          ? "The person has been asked to approve this on that computer."
          : "The person has been asked in Opensteer.";
      // A deduplicated ask belongs to the task that opened it, so its outcome is delivered there.
      return replayed
        ? `An equivalent Request is already pending, so no second one was opened; its outcome is delivered to the task that opened it. ${asked} Do not submit this request again.`
        : `${asked} This Request is durable and still open. Do not submit this request again.`;
    }
    case "fulfilled":
      return request.kind === "computer.app.access"
        ? "This request was fulfilled. Use computer_use with the approved app or phone."
        : "This request was fulfilled. Use plugin_search now for its tools.";
    case "declined":
      return "The person declined this request. Continue without it and do not request it again unless they ask.";
    case "withdrawn":
      return "This request was withdrawn. Continue without it and do not submit it again unless the person asks.";
    case "cancelled":
      return "This request was cancelled. Ask again if the task still needs this access.";
  }
}
