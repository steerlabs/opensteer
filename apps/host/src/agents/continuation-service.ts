import { isPhoneDisplayDefinitionId } from "@opensteer/core";
import { createHash } from "node:crypto";
import { BrowserRequestOutcomeSchema, OpensteerError, type Request } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import {
  integrationAccountLabel,
  IntegrationConnectionIdSchema,
  type IntegrationReadiness,
} from "@opensteer/integration-core";
import type { CommandService } from "@opensteer/orchestration";
import {
  PasswordSignInRequestResponseSchema,
  type PasswordSignInRequestResponse,
} from "@opensteer/protocol";
import { BrowserSignInRequestResponseSchema } from "@opensteer/protocol/browser-sources";
import { CoalescedWake } from "@opensteer/shared/coalescedWake";
import { z } from "zod";
import type { PasswordSignInContinuationState } from "../browser/password-sign-in-service.js";
import type { ComputerAppApprovalService } from "../devices/computer-app-approval-service.js";
import { computerToolRefs } from "../devices/computer-use-discovery.js";
import type { DeviceService } from "../devices/device-service.js";
const defaultIntervalMs = 5_000;
const cancelledContinuationReason = "Continuation delivery was cancelled by Thread input admission";
const triggerOriginatedContinuationReason =
  "Trigger-originated Requests receive no continuation: there is no Run or turn to resume, and the next Trigger occurrence observes the resolved state";
type RequestContinuationStore = Pick<
  OpensteerStore["requests"],
  "listPendingContinuations" | "recordContinuationAttempt" | "get"
>;
type ThreadInputDisposition = Awaited<
  ReturnType<CommandService["enqueueThreadInput"]>
>["disposition"];

/**
 * A continuation may only report what the inventory actually holds, so the
 * outbox reads the installed state rather than assuming the approval worked.
 */
export type IntegrationInventorySource = Pick<
  DeviceService,
  "listDiscoveryInventory" | "listCallableTools"
> & { readonly selfDeviceId: OpensteerStore["requireSelfDeviceId"] } & Pick<
    ComputerAppApprovalService,
    "computerUseMachines" | "computerUsePhones"
  >;
type IntegrationInventoryEntry = Awaited<
  ReturnType<IntegrationInventorySource["listDiscoveryInventory"]>
>[number];

/** Drains the one durable continuation outbox shared by every Request kind. */
export class ContinuationService {
  readonly #commands: Pick<CommandService, "enqueueThreadInput">;
  readonly #integrations: IntegrationInventorySource;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #requests: RequestContinuationStore;
  readonly #passwordSignIn: (operationId: string) => PasswordSignInContinuationState;
  #closed = false;
  readonly #drains: CoalescedWake;
  #timer: NodeJS.Timeout | undefined;
  constructor(options: {
    readonly commands: Pick<CommandService, "enqueueThreadInput">;
    readonly integrations: IntegrationInventorySource;
    readonly intervalMs?: number;
    readonly onError: (error: unknown) => void;
    readonly requests: RequestContinuationStore;
    readonly passwordSignIn?: (operationId: string) => PasswordSignInContinuationState;
  }) {
    this.#commands = options.commands;
    this.#integrations = options.integrations;
    this.#intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.#onError = options.onError;
    this.#requests = options.requests;
    this.#passwordSignIn =
      options.passwordSignIn ??
      (() => ({
        publishing: false,
        loginRef: undefined,
      }));
    this.#drains = new CoalescedWake({
      run: () => this.#drainOnce(),
      onError: this.#onError,
    });
  }
  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => this.notify(), this.#intervalMs);
    this.#timer.unref();
    this.notify();
  }
  notify(): void {
    if (this.#closed) return;
    this.#drains.wake();
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#drains.stop();
  }
  async outcome(request: Request): Promise<{
    readonly request: Request;
    readonly text: string;
    readonly loginRef?: string;
    readonly publicCard?: {
      readonly brand: string;
      readonly lastFour: string;
    };
  } | null> {
    // A settled row proves its publication flag is already set, so the flag read next is current.
    if (request.status === "pending") return null;
    let loginRef: string | undefined;
    let publicCard:
      | {
          readonly brand: string;
          readonly lastFour: string;
        }
      | undefined;
    if (request.payload.kind === "browser.password-sign-in") {
      const state = this.#passwordSignIn(request.payload.operationId);
      if (state.publishing) return null;
      loginRef = state.loginRef;
      publicCard = state.publicCard;
      request = (await this.#requests.get(request.id)) ?? request;
    }
    const text =
      request.status === "withdrawn" ||
      (request.status === "cancelled" &&
        request.cancellationReason !== "resource-deleted" &&
        request.cancellationReason !== "plugin-interrupted" &&
        request.cancellationReason !== "plugin-expired" &&
        request.cancellationReason !== "authority-revoked")
        ? `Request ${request.id} ended as ${request.status}.`
        : await continuationMessage(request, this.#integrations, loginRef);
    return {
      request,
      text,
      ...(loginRef
        ? {
            loginRef,
          }
        : {}),
      ...(publicCard
        ? {
            publicCard,
          }
        : {}),
    };
  }
  async #drainOnce(): Promise<void> {
    const continuations = await this.#requests.listPendingContinuations();
    const groups = new Map<string, Request[]>();
    for (const { request } of continuations) {
      if (request.originatingRunId === null) {
        await this.#settleUndeliverable(request, triggerOriginatedContinuationReason);
      } else {
        const group = groups.get(request.originatingRunId) ?? [];
        group.push(request);
        groups.set(request.originatingRunId, group);
      }
    }
    for (const group of groups.values()) {
      const requests = group.toSorted(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      const messages: string[] = [];
      let publishing = false;
      for (const request of requests) {
        try {
          const outcome = await this.outcome(request);
          if (!outcome) {
            publishing = true;
            break;
          }
          messages.push(outcome.text);
        } catch (error) {
          this.#onError(error);
          messages.push(
            `Request ${request.id} settled as ${request.status}. opensteer_request_answer shows status, not the answer.`,
          );
        }
      }
      if (publishing) continue;
      const request =
        requests.find(
          (row) =>
            (row.status === "fulfilled" || row.status === "declined") && row.settlementProvenance,
        ) ??
        requests.find((row) => row.status === "fulfilled" || row.status === "declined") ??
        requests[0]!;
      const key = createHash("sha256")
        .update(JSON.stringify(requests.map(({ id }) => id).sort()))
        .digest("hex");
      let disposition: ThreadInputDisposition;
      try {
        const delivered = await this.#commands.enqueueThreadInput({
          content: [
            {
              text: messages.join("\n\n"),
              type: "text",
            },
          ],
          idempotencyKey: `request-continuation:${key}`,
          policy: "queue",
          requestedBy: request.requestedBy,
          source: {
            cause: "request-resolved",
            kind: "platform",
            referenceId: request.id,
            sourceRunId: request.originatingRunId!,
          },
          threadId: request.originatingThreadId,
        });
        disposition = delivered.disposition;
      } catch (error) {
        if (isPermanentContinuationFailure(error)) {
          for (const row of requests)
            await this.#settleUndeliverable(row, continuationFailureReason(error));
        } else {
          try {
            for (const row of requests)
              await this.#requests.recordContinuationAttempt({
                reason: null,
                requestId: row.id,
                status: "waiting",
              });
          } catch (recordError) {
            this.#onError(recordError);
          }
          this.#onError(error);
        }
        continue;
      }
      switch (disposition) {
        case "cancelled":
          for (const row of requests)
            await this.#settleUndeliverable(row, cancelledContinuationReason);
          continue;
        case "pending":
        case "run-queued":
        case "steering":
          break;
        default: {
          const unsupportedDisposition: never = disposition;
          throw new Error(`Unsupported Thread input disposition: ${unsupportedDisposition}`);
        }
      }
      try {
        for (const row of requests)
          await this.#requests.recordContinuationAttempt({
            reason: null,
            requestId: row.id,
            status: "queued",
          });
      } catch (error) {
        this.#onError(error);
      }
    }
  }
  async #settleUndeliverable(request: Request, reason: string): Promise<void> {
    try {
      await this.#requests.recordContinuationAttempt({
        reason,
        requestId: request.id,
        status: "undeliverable",
      });
    } catch (recordError) {
      this.#onError(recordError);
    }
  }
}
const IntegrationAccessAccountSchema = z.strictObject({
  accountIdentifier: z.string().trim().min(1).nullable(),
  displayName: z.string().trim().min(1),
});

const CatalogProvenanceSchema = z.object({
  definitionId: z.string().min(1),
});
export async function continuationMessage(
  request: Request,
  integrations: IntegrationInventorySource,
  loginRef?: string,
): Promise<string> {
  if (request.payload.kind === "plugin.approval" || request.payload.kind === "plugin.input") {
    const execution = request.payload.executionId;
    if (request.status === "cancelled")
      return `Plugin execution ${execution} was ${request.cancellationReason === "plugin-expired" ? "expired" : "interrupted"}. Earlier calls may have taken effect. Check current state with a safe read; never rerun the program blindly.`;
    return `The person ${request.status === "fulfilled" ? "answered" : "declined"} plugin Request ${request.id}. Call plugin_resume({executionId:${JSON.stringify(execution)}}) to collect the execution's result. Do not repeat the call or program; earlier effects are not rolled back.`;
  }
  if (request.mode === "durable" && request.status === "cancelled") {
    return `Request ${request.id} was cancelled (${request.cancellationReason}). The requested resource or authority is no longer available. Continue without it; opensteer_request_answer shows status, not the answer.`;
  }
  if (
    request.mode !== "durable" ||
    (request.status !== "fulfilled" && request.status !== "declined")
  ) {
    throw new Error("The Request continuation outbox contains an ineligible Request");
  }
  switch (request.kind) {
    case "plugin.account":
      return request.status === "fulfilled"
        ? `Plugin account Request ${request.id} was fulfilled. Discover the plugin's current tools with plugin_search and continue.`
        : `The person declined plugin account Request ${request.id}. Continue without this account; do not request it again unless asked.`;
    case "plugin.approval":
    case "plugin.input":
      throw new Error("Plugin execution continuation needs its execution payload");
    case "device.access": {
      if (request.payload.kind !== "device.access")
        throw new Error("Device access Request payload is invalid");
      const { machineId, machineName, access } = request.payload;
      return request.status === "fulfilled"
        ? `Request ${request.id} was fulfilled. ${access} access is now on for ${machineName} (${machineId}). This continuation Run rebuilds computer routes. Per-app, profile or OS authorization may still be needed. Continue the task using this Run's inventory.`
        : `Request ${request.id} was declined (Not now). Continue without ${access} on ${machineName} (${machineId}); do not request it again in this task.`;
    }
    case "person.question":
      return personQuestionContinuation(request);
    case "machine.full-disk-access": {
      if (request.payload.kind !== "machine.full-disk-access")
        throw new Error("macOS Full Disk Access Request payload is invalid");
      const { machineName } = request.payload;
      return request.status === "fulfilled"
        ? `Request ${request.id} was fulfilled. macOS Full Disk Access is now on for ${machineName}. Commands already authorized through machine access can now open Messages, Mail, Safari data, Desktop, Documents, and Downloads there. Continue the task.`
        : `Request ${request.id} was declined by the user. Continue the task without macOS Full Disk Access on ${machineName} and do not request it again unless the user asks.`;
    }
    case "browser.access": {
      if (request.status === "declined")
        return `Request ${request.id} was declined by the user. Browser profiles your Opensteer could already use are unchanged: browser_profile_list shows them. Do not request this access again unless the user asks.`;
      const outcome = BrowserRequestOutcomeSchema.safeParse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      if (!outcome.success)
        return `Request ${request.id} was fulfilled. Browser profile access is now available; browser_profile_list shows the profiles your Opensteer can use. Continue the task.`;
      const { id: profileId, name } = outcome.data.profile;
      return `Request ${request.id} was fulfilled. The person chose browser profile ${JSON.stringify(name)} (${profileId}); use it for this task even if you suggested another. Open a tab with Browser Harness newTab(url, { profile: "${profileId}" }), then continue the task.`;
    }
    case "browser.sign-in": {
      if (request.payload.kind !== "browser.sign-in")
        throw new Error("Browser sign-in Request payload is invalid");
      const { site } = request.payload;
      if (request.status === "declined")
        return `Request ${request.id} to copy the user's Chrome cookies for ${site} was declined. Continue without them and do not ask again unless the user asks.`;
      const response = BrowserSignInRequestResponseSchema.parse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      switch (response.outcome) {
        case "applied":
          return `Request ${request.id} was fulfilled: copied ${response.sourceName}'s cookies for ${site} into the browser tab. Reload the page and check the account; the site may still refuse copied cookies.`;
        case "not-signed-in":
          return `Request ${request.id} ended: no connected Chrome is signed in to ${site}, so nothing was copied. The user did not decline.`;
        case "session-closed":
          return `Request ${request.id} was allowed, but the browser tab had closed. Call chrome_cookies_request again with your current tabId.`;
      }
    }
    case "browser.password-sign-in": {
      if (request.payload.kind !== "browser.password-sign-in")
        throw new Error("Password sign-in Request payload is invalid");
      if (request.status === "declined")
        return `Request ${request.id} was declined by the user. Continue without signing in to ${request.payload.site} and do not ask for it again unless the user asks.`;
      const response = PasswordSignInRequestResponseSchema.parse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      const { site, computerName } = request.payload;
      if (request.payload.credential === "card") {
        const action =
          response.outcome === "authorized" && loginRef
            ? `Focus each required checkout field and call fillCard("${loginRef}", field). Never read back, print, log, copy or save card values. This approval covers filling only; the person's request must cover any purchase.`
            : "The card use ended. Call card_request again only if the task still requires it.";
        return `Request ${request.id} for card use on ${site} ended. ${action}`;
      }
      if (response.outcome === "authorized") {
        const action = loginRef
          ? `Saved login ${loginRef} for ${site} is ready as ${response.account}: in a browser, focus each field and call fillLogin("${loginRef}", field); in a genuine phone or Mac app, type {loginRef: "${loginRef}", field}. Fields are "username", "password" and "code". Submit and check the account. Never reveal or read back saved fields.`
          : `The saved login for ${site} ended. Call saved_login_request again if the task still needs it.`;
        return `Request ${request.id} was approved. ${action}`;
      }
      return `Request ${request.id} ended. ${passwordSignInContinuation({ site, computerName }, response)}`;
    }
    case "integration.access": {
      if (request.status === "declined") {
        return `Request ${request.id} was declined by the user. Continue the task without this integration access and do not request it again unless the user asks.`;
      }
      if (request.payload.kind !== "integration.access")
        throw new Error("Integration access Request payload is invalid");
      const { access, installationId, requestedServerId } = request.payload;
      const target = z
        .object({
          connectionId: IntegrationConnectionIdSchema.nullable(),
        })
        .safeParse(request.response.kind === "external" ? request.response.value : undefined);
      const entry = installationId
        ? (
            await inventoryFor(
              request,
              integrations,
              target.success
                ? {
                    access,
                    connectionId: target.data.connectionId,
                  }
                : undefined,
            )
          ).find(({ installation }) => installation.id === installationId)
        : undefined;
      const account = IntegrationAccessAccountSchema.safeParse(
        request.response.kind === "external" ? request.response.value?.account : undefined,
      );
      const grantedAccount = account.success
        ? ` Granted account: ${integrationAccountLabel(account.data)}.`
        : "";
      const subject = target.success
        ? target.data.connectionId === null
          ? "connectionless operations"
          : `connection ${target.data.connectionId}`
        : "an unrecorded connection";
      const integration =
        entry?.installation.title ?? installationId ?? "The requested integration";
      const receipt = `Request ${request.id} was fulfilled. ${integration} ${access} access was granted for ${subject}.${grantedAccount}`;
      if (!entry) {
        return `${receipt} The integration is no longer in the inventory this Run can see.`;
      }
      if (
        entry.installation.sourceKind === "built-in" &&
        CatalogProvenanceSchema.safeParse(entry.installation.provenance).data?.definitionId ===
          "macos-app"
      ) {
        const connectionId =
          request.response.kind === "external" ? request.response.value?.connectionId : undefined;
        const machines = await integrations.computerUseMachines(request.requestedBy);
        for (const machine of machines) {
          const app = machine.apps.find(({ connectionId: id }) => id === connectionId);
          if (app)
            return computerAppContinuation(request, integrations, machine.name, app.name, app);
        }
      }
      if (
        entry.installation.sourceKind === "built-in" &&
        isPhoneDisplayDefinitionId(
          CatalogProvenanceSchema.safeParse(entry.installation.provenance).data?.definitionId,
        )
      ) {
        const connectionId =
          request.response.kind === "external" ? request.response.value?.connectionId : undefined;
        const phone = (await integrations.computerUsePhones(request.requestedBy)).find(
          ({ connection }) => connection !== null && connection.connectionId === connectionId,
        );
        if (phone) return phoneContinuation(request, integrations, phone);
      }
      if (!target.success) {
        return `${receipt} The fulfilled connection was not recorded; its current state is unverified.`;
      }
      const state = integrationState(entry, {
        connectionId: target.data.connectionId,
        serverId: requestedServerId,
      });
      switch (state.disposition) {
        case "ready":
          return `${receipt} Its ${access} access is active.`;
        case "needs-grant":
          return `${receipt} Your Opensteer still holds no access grant${detailClause(state.detail)}.`;
        case "needs-account":
          return `${receipt} The fulfilled target is not usable${detailClause(state.detail)}.`;
        case "blocked":
          return `${receipt} The integration is not usable: ${state.detail ?? "the integration is unavailable"}.`;
      }
    }
    case "computer.app.access": {
      if (request.payload.kind !== "computer.app.access")
        throw new Error("Computer app access Request payload is invalid");
      const payload = request.payload;
      if (payload.app === null) {
        // A phone is asked for whole, so its continuation names the phone.
        const phones = await integrations.computerUsePhones(request.requestedBy);
        const phone = phones.find((phone) => phone.deviceId === payload.deviceId);
        if (request.status === "declined")
          return `Request ${request.id} was declined by the user. Continue the task without ${phone?.name ?? "that phone"} and do not request it again unless the user asks.`;
        return phone
          ? phoneContinuation(request, integrations, phone)
          : `Request ${request.id} was fulfilled, but that phone is no longer available to this task. Continue without it.`;
      }
      const asked = payload.app;
      const { displayName } = asked;
      const machines = await integrations.computerUseMachines(request.requestedBy);
      const machine = machines.find((machine) => machine.deviceId === payload.deviceId);
      const mac = machine?.name ?? "that Mac";
      if (request.status === "declined")
        return `Request ${request.id} was declined by the user. Continue the task without ${displayName} on ${mac} and do not request it again unless the user asks.`;
      const app = machine?.apps.find(
        ({ bundleId }) => bundleId.toLowerCase() === asked.bundleId.toLowerCase(),
      );
      return computerAppContinuation(request, integrations, mac, displayName, app);
    }
    case "harness.approval":
    case "harness.input":
      throw new Error("A live harness Request cannot have a durable continuation");
  }
}
async function computerAppContinuation(
  request: Request,
  integrations: IntegrationInventorySource,
  mac: string,
  displayName: string,
  app:
    | Awaited<ReturnType<IntegrationInventorySource["computerUseMachines"]>>[number]["apps"][number]
    | undefined,
): Promise<string> {
  const unavailable = `Request ${request.id} was fulfilled, but ${displayName} on ${mac} is no longer available to this task. Continue without it.`;
  if (!app || app.status === "blocked") return unavailable;
  const refs = computerToolRefs(
    await integrations.listCallableTools({
      ownerUserId: request.requestedBy,
      threadId: request.originatingThreadId,
    }),
    app.connectionId,
  );
  if (!refs.observe) return unavailable;
  return `Request ${request.id} was fulfilled. ${displayName} on ${mac} is ready. Use app(${JSON.stringify(displayName)}, {computer: ${JSON.stringify(mac)}}) in computer_use. Continue.`;
}

/** A fulfilled ask names the phone exactly as the computer library accepts it. */
async function phoneContinuation(
  request: Request,
  integrations: IntegrationInventorySource,
  phone: Awaited<ReturnType<IntegrationInventorySource["computerUsePhones"]>>[number],
): Promise<string> {
  const unavailable = `Request ${request.id} was fulfilled, but ${phone.name} is no longer available to this task. Continue without it.`;
  if (!phone.connection) return unavailable;
  const refs = computerToolRefs(
    await integrations.listCallableTools({
      ownerUserId: request.requestedBy,
      threadId: request.originatingThreadId,
    }),
    phone.connection.connectionId,
  );
  if (!refs.observe) return unavailable;
  return `Request ${request.id} was fulfilled. ${phone.name} is ready. Use phone(${JSON.stringify(phone.name)}) in computer_use. Release it when you are done so another task can use it. Continue.`;
}
function inventoryFor(
  request: Request,
  integrations: IntegrationInventorySource,
  target?: Parameters<IntegrationInventorySource["listDiscoveryInventory"]>[0]["target"],
): Promise<readonly IntegrationInventoryEntry[]> {
  return integrations.listDiscoveryInventory({
    ...(target
      ? {
          target,
        }
      : {}),
    ownerUserId: request.requestedBy,
    threadId: request.originatingThreadId,
  });
}
type IntegrationState =
  | {
      readonly detail: string | null;
      readonly disposition: "needs-account" | "needs-grant" | "ready";
    }
  | {
      readonly detail: string | null;
      readonly disposition: "blocked";
      readonly remedy: string;
    };

/**
 * Access continuations scope inventory to the fulfilled connection and access,
 * and consider only its requested server or matching connection requirements.
 * Installation continuations use the best state any server reaches: one usable server is
 * enough for the agent to proceed, and otherwise the nearest obstacle is the
 * one worth reporting — a missing personal grant is nearer than a missing
 * account, because the account already exists.
 */
function integrationState(
  entry: IntegrationInventoryEntry,
  target?: {
    readonly connectionId: string | null;
    readonly serverId: string | null;
  },
): IntegrationState {
  const states = entry.readiness.servers
    .filter((readiness) => {
      if (!target) return true;
      if (target.serverId && readiness.serverId !== target.serverId) return false;
      const server = entry.servers.find(({ id }) => id === readiness.serverId);
      return (
        !server || (server.connectionRequirement.kind === "none") === (target.connectionId === null)
      );
    })
    .map(readinessState);
  return (
    states.find(({ disposition }) => disposition === "ready") ??
    states.find(({ disposition }) => disposition === "needs-grant") ??
    states.find(({ disposition }) => disposition === "needs-account") ??
    states[0] ?? {
      detail: target
        ? "the fulfilled target has no matching server"
        : "the installation exposes no servers",
      disposition: "blocked",
      remedy:
        "An administrator must repair the installation. Continue without it and tell the user.",
    }
  );
}
function readinessState(readiness: IntegrationReadiness): IntegrationState {
  const detail = readiness.detail ? readiness.detail.slice(0, 240) : null;
  switch (readiness.code) {
    // A ready server has nothing left to explain, so any detail it still
    // carries is stale and would only mislead.
    case "READY":
      return {
        detail: null,
        disposition: "ready",
      };
    case "ACCESS_GRANT_REQUIRED":
      return {
        detail,
        disposition: "needs-grant",
      };
    case "USER_AUTHORIZATION_REQUIRED":
    case "REAUTHORIZATION_REQUIRED":
      return {
        detail,
        disposition: "needs-account",
      };
    case "INTEGRATION_UNAVAILABLE":
      return {
        detail,
        disposition: "blocked",
        remedy:
          "Requesting it again will not help. Continue without it and tell the user what that detail says.",
      };
  }
}
function detailClause(detail: string | null): string {
  return detail ? ` (${detail})` : "";
}
function isPermanentContinuationFailure(error: unknown): boolean {
  return error instanceof OpensteerError && !error.retryable;
}
function continuationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Continuation delivery failed";
  return message.trim().slice(0, 500) || "Continuation delivery failed";
}

/** What the agent is told; it never learns a password, a username or a cookie. */
function passwordSignInContinuation(
  payload: { readonly computerName: string; readonly site: string },
  response: Exclude<PasswordSignInRequestResponse, { outcome: "authorized" }>,
): string {
  const { computerName, site } = payload;
  switch (response.outcome) {
    case "expired":
      return `Nobody answered on ${computerName} within an hour, so no saved login for ${site} was released. Call saved_login_request again if the task still needs it.`;
    case "unavailable":
      switch (response.reason) {
        case "no-saved-login":
          return `Opensteer Passwords on ${computerName} has no login for ${site}.`;
        case "passwords-off":
          return `Agent sign-ins are turned off in Opensteer Passwords on ${computerName}.`;
        case "not-set-up":
          return `Opensteer Passwords is not set up on ${computerName}.`;
        case "not-responding":
          return `Opensteer Passwords did not respond on ${computerName}. Call saved_login_request again later if the task still needs ${site}.`;
      }
    case "interrupted":
      return `The saved-login release for ${site} stopped on ${computerName} before anything was released. Call saved_login_request again if the task still needs it.`;
    case "session-closed":
      return `The browser tab closed before the saved login for ${site} was released.`;
  }
}

/** What the person said to a question the agent asked, beside each question as they saw it. */
export function personQuestionContinuation(request: Request): string {
  const { presentation, response } = request;
  const title = JSON.stringify(presentation.title);
  if (request.status === "declined")
    return `The person dismissed your question ${title} without answering (Request ${request.id}). Take that as no; do not ask it again unless something changed.`;
  if (presentation.kind !== "form" || response?.kind !== "form")
    throw new Error("A person question is answered with its form");
  const answers = presentation.fields.map((field) => {
    const answer = (response.answers[field.id] ?? []).map((value) => JSON.stringify(value));
    return `- ${field.prompt}\n  Answer: ${answer.join(", ")}`;
  });
  return [
    `The person answered your question ${title} (Request ${request.id}):`,
    ...answers,
    "Continue with what they said.",
  ].join("\n");
}
