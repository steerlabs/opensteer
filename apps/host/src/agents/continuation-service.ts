import { BrowserRequestOutcomeSchema, OpensteerError, type Request } from "@opensteer/core";
import { androidPhoneDefinitionId } from "@opensteer/protocol";
import { BrowserSignInRequestResponseSchema } from "@opensteer/protocol/browser-sources";
import {
  PasswordSignInRequestResponseSchema,
  type PasswordSignInRequestResponse,
} from "@opensteer/protocol";
import type { OpensteerStore } from "@opensteer/database";
import {
  IntegrationConnectionIdSchema,
  type IntegrationReadiness,
} from "@opensteer/integration-core";
import type { CommandService } from "@opensteer/orchestration";
import { z } from "zod";
import { computerToolRefs } from "../integrations/computer-use-discovery.js";
import type { ComputerAppApprovalService } from "../integrations/computer-app-approval-service.js";
import type { IntegrationPlatformService } from "../integrations/integration-platform-service.js";

const defaultIntervalMs = 5_000;
const cancelledContinuationReason = "Continuation delivery was cancelled by Thread input admission";
const triggerOriginatedContinuationReason =
  "Trigger-originated Requests receive no continuation: there is no Run or turn to resume, and the next Trigger occurrence observes the resolved state";

type RequestContinuationStore = Pick<
  OpensteerStore["requests"],
  "listPendingContinuations" | "recordContinuationAttempt"
>;
type ThreadInputDisposition = Awaited<
  ReturnType<CommandService["enqueueThreadInput"]>
>["disposition"];

/**
 * A continuation may only report what the inventory actually holds, so the
 * outbox reads the installed state rather than assuming the approval worked.
 */
export type IntegrationInventorySource = Pick<
  IntegrationPlatformService,
  "listDiscoveryInventory" | "listCallableTools"
> &
  Pick<ComputerAppApprovalService, "computerUseMachines" | "computerUsePhones">;
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
  readonly #loginRef: (operationId: string) => string | undefined;
  #closed = false;
  #drain: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly commands: Pick<CommandService, "enqueueThreadInput">;
    readonly integrations: IntegrationInventorySource;
    readonly intervalMs?: number;
    readonly onError: (error: unknown) => void;
    readonly requests: RequestContinuationStore;
    readonly loginRef?: (operationId: string) => string | undefined;
  }) {
    this.#commands = options.commands;
    this.#integrations = options.integrations;
    this.#intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.#onError = options.onError;
    this.#requests = options.requests;
    this.#loginRef = options.loginRef ?? (() => undefined);
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => this.notify(), this.#intervalMs);
    this.#timer.unref();
    this.notify();
  }

  notify(): void {
    if (this.#closed || this.#drain) return;
    this.#drain = this.#drainOnce()
      .catch(this.#onError)
      .finally(() => {
        this.#drain = undefined;
      });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#drain;
  }

  async #drainOnce(): Promise<void> {
    const continuations = await this.#requests.listPendingContinuations();
    for (const { request } of continuations) {
      const sourceRunId = request.originatingRunId;
      // A Trigger occurrence has no Run and no turn waiting on an answer, so
      // there is nothing to continue. The outbox row is settled here rather
      // than retried forever, and the next occurrence simply sees the resolved
      // readiness for itself.
      if (sourceRunId === null) {
        await this.#settleUndeliverable(request, triggerOriginatedContinuationReason);
        continue;
      }
      let disposition: ThreadInputDisposition;
      try {
        const delivered = await this.#commands.enqueueThreadInput({
          content: [
            {
              text: await continuationMessage(
                request,
                this.#integrations,
                request.payload.kind === "browser.password-sign-in"
                  ? this.#loginRef(request.payload.operationId)
                  : undefined,
              ),
              type: "text",
            },
          ],
          idempotencyKey: `request-continuation:${request.id}`,
          policy: "queue",
          requestedBy: request.requestedBy,
          source: {
            cause: "request-resolved",
            kind: "platform",
            referenceId: request.id,
            sourceRunId,
          },
          threadId: request.originatingThreadId,
        });
        disposition = delivered.disposition;
      } catch (error) {
        if (isPermanentContinuationFailure(error)) {
          await this.#settleUndeliverable(request, continuationFailureReason(error));
        } else {
          try {
            await this.#requests.recordContinuationAttempt({
              reason: null,
              requestId: request.id,
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
          await this.#settleUndeliverable(request, cancelledContinuationReason);
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
        await this.#requests.recordContinuationAttempt({
          reason: null,
          requestId: request.id,
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

/**
 * The public projection stored on the Request payload. It is read back loosely
 * because only the identity fields that locate the resulting installation
 * matter here.
 */
const InstallManifestSummarySchema = z.discriminatedUnion("kind", [
  z.object({
    definition: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    kind: z.literal("catalog"),
  }),
  z.object({
    kind: z.literal("proposal"),
    proposal: z.object({ digest: z.string().min(1) }),
  }),
]);
type InstallManifestSummary = z.infer<typeof InstallManifestSummarySchema>;

const CatalogProvenanceSchema = z.object({ definitionId: z.string().min(1) });
const ProposalProvenanceSchema = z.object({ artifactDigest: z.string().min(1) });

export async function continuationMessage(
  request: Request,
  integrations: IntegrationInventorySource,
  loginRef?: string,
): Promise<string> {
  if (
    request.mode !== "durable" ||
    (request.status !== "fulfilled" && request.status !== "declined")
  ) {
    throw new Error("The Request continuation outbox contains an ineligible Request");
  }
  switch (request.kind) {
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
        return `Request ${request.id} was declined by the user. Browser profiles this Workspace could already use are unchanged: browser_profile_list shows them. Do not request this access again unless the user asks.`;
      const outcome = BrowserRequestOutcomeSchema.safeParse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      if (!outcome.success)
        return `Request ${request.id} was fulfilled. Browser profile access is now available; browser_profile_list shows the profiles this Workspace can use. Continue the task.`;
      const { id: profileId, name } = outcome.data.profile;
      return `Request ${request.id} was fulfilled. Browser profile ${JSON.stringify(name)} (${profileId}) is now available to this Workspace. Open it with browser_session_open and profileId ${profileId}, then continue the task.`;
    }
    case "browser.profile.save": {
      if (request.status === "declined")
        return `Request ${request.id} was declined by the user. Continue the task without saving this Browser Session as a profile and do not request it again unless the user asks.`;
      if (request.payload.kind !== "browser.profile.save")
        throw new Error("Browser profile save Request payload is invalid");
      const { sessionId } = request.payload;
      const outcome = BrowserRequestOutcomeSchema.safeParse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      if (!outcome.success)
        return `Request ${request.id} was fulfilled. Browser Session ${sessionId}'s state was copied to a new browser profile, and that session stays Guest. browser_profile_list shows the new profile; open it with browser_session_open for work that should persist. Continue the task.`;
      const { id: profileId, name } = outcome.data.profile;
      return `Request ${request.id} was fulfilled. Browser Session ${sessionId}'s state was copied to the new browser profile ${JSON.stringify(name)} (${profileId}). That session stays Guest: what happens there now is not saved to the profile. Open the profile with browser_session_open and profileId ${profileId} for work that should persist, then continue the task.`;
    }
    case "browser.profile.import":
      return request.status === "declined" &&
        request.response.kind === "external" &&
        request.response.value?.replacedBy === "browser.sign-in"
        ? `Request ${request.id} can no longer be completed: copying a Chrome login into a new profile was replaced by live sign-ins. If a page still needs the user's sign-in, call sign_in once with your Browser Session and the site.`
        : `Request ${request.id} is no longer actionable because browser source imports are unavailable. Continue without importing this browser source.`;
    case "browser.sign-in": {
      if (request.payload.kind !== "browser.sign-in")
        throw new Error("Browser sign-in Request payload is invalid");
      const { sessionId, site } = request.payload;
      if (request.status === "declined")
        return `Request ${request.id} was declined by the user. Continue without signing in to ${site} and do not ask for it again unless the user asks.`;
      const response = BrowserSignInRequestResponseSchema.parse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      return response.outcome === "applied"
        ? `Request ${request.id} was fulfilled. Signed in to ${site} with ${response.sourceName} in Browser Session ${sessionId}. Reload the page and confirm the account before continuing.`
        : `Request ${request.id} was fulfilled. The user allowed ${site}. Your Browser Session had closed; call sign_in again in your current session.`;
    }
    case "browser.password-sign-in": {
      if (request.payload.kind !== "browser.password-sign-in")
        throw new Error("Password sign-in Request payload is invalid");
      if (request.status === "declined")
        return `Request ${request.id} was declined by the user. Continue without signing in to ${request.payload.site} and do not ask for it again unless the user asks.`;
      const response = PasswordSignInRequestResponseSchema.parse(
        request.response.kind === "external" ? request.response.value : undefined,
      );
      if (request.payload.scope === "workspace") {
        const { site, computerName } = request.payload;
        if (response.outcome === "authorized") {
          const action = loginRef
            ? `Use saved login ${loginRef} for ${site} as ${response.account}: in the genuine phone/Mac app, type {loginRef: "${loginRef}", field: "username" | "password" | "code"}; in a browser, focus each field and use Browser Harness fillLogin("${loginRef}", field). Submit and verify the signed-in account. Never reveal or read back saved fields.`
            : `The saved login for ${site} ended. Call sign_in again.`;
          return `Request ${request.id} was approved. ${action} If the reference expires, call sign_in again.`;
        }
        return `Request ${request.id} was fulfilled. The sign-in to ${site} ${response.outcome === "expired" ? "expired" : "stopped"} on ${computerName}. If the task still needs it, call sign_in again.`;
      }
      if (response.outcome === "authorized") {
        const { sessionId, site } = request.payload;
        const action = loginRef
          ? `Sign in to ${site} as ${response.account} in Browser Session ${sessionId}: focus each field and call Browser Harness fillLogin("${loginRef}", "username" | "password" | "code"), submit, handle what the site shows, then confirm the account on a signed-in page.`
          : `The login lease for ${site} in Browser Session ${sessionId} ended. Call sign_in again.`;
        return `Request ${request.id} was approved. ${action} If fillLogin answers expired, call sign_in again.`;
      }
      return `Request ${request.id} was fulfilled. ${passwordSignInContinuation(request.payload, response)}`;
    }
    case "integration.access": {
      if (request.status === "declined") {
        return `Request ${request.id} was declined by the user. Continue the task without this integration access and do not request it again unless the user asks.`;
      }
      if (request.payload.kind !== "integration.access")
        throw new Error("Integration access Request payload is invalid");
      const { access, installationId, requestedServerId } = request.payload;
      const target = z
        .object({ connectionId: IntegrationConnectionIdSchema.nullable() })
        .safeParse(request.response.kind === "external" ? request.response.value : undefined);
      const entry = installationId
        ? (
            await inventoryFor(
              request,
              integrations,
              target.success ? { access, connectionId: target.data.connectionId } : undefined,
            )
          ).find(({ installation }) => installation.id === installationId)
        : undefined;
      const account = IntegrationAccessAccountSchema.safeParse(
        request.response.kind === "external" ? request.response.value?.account : undefined,
      );
      const grantedAccount = account.success
        ? ` Granted account: ${account.data.displayName}${account.data.accountIdentifier ? ` (${account.data.accountIdentifier})` : ""}.`
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
        CatalogProvenanceSchema.safeParse(entry.installation.provenance).data?.definitionId ===
          androidPhoneDefinitionId
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
          return `${receipt} This Workspace still holds no access grant${detailClause(state.detail)}.`;
        case "needs-account":
          return `${receipt} The fulfilled target is not usable${detailClause(state.detail)}.`;
        case "blocked":
          return `${receipt} The integration is not usable: ${state.detail ?? "the integration is unavailable"}.`;
      }
    }
    case "integration.install": {
      if (request.status === "declined") {
        return `Request ${request.id} was declined by the user. Continue the task without this integration and do not propose it again unless the user asks.`;
      }
      const manifest = InstallManifestSummarySchema.safeParse(
        request.payload.kind === "integration.install" ? request.payload.manifest : undefined,
      );
      if (!manifest.success) {
        return `Request ${request.id} was approved, but the approved manifest cannot be read back, so the result is unverified. Call integration_search now to see what is actually installed and continue from there.`;
      }
      const entry = (await inventoryFor(request, integrations)).find((candidate) =>
        installedFromManifest(candidate, manifest.data),
      );
      if (!entry) {
        return `Request ${request.id} was approved, but ${manifestName(manifest.data)} is not present in the current integration inventory. Call integration_search now to see what is actually installed and continue from there.`;
      }
      const state = integrationState(entry);
      switch (state.disposition) {
        case "ready":
          return `Request ${request.id} was fulfilled. ${entry.installation.title} is installed and ready. Call integration_search now to pick up its tools and continue the task.`;
        case "needs-grant":
          return `Request ${request.id} was fulfilled. ${entry.installation.title} is installed and its account connection works, but this Workspace holds no access grant yet${detailClause(state.detail)}. Call integration_search now, then call integration_request with this integration and the access class the task needs.`;
        case "needs-account":
          return `Request ${request.id} was fulfilled. ${entry.installation.title} is installed but has no connected account${detailClause(state.detail)}. Call integration_request now for the account connection, then continue the task.`;
        case "blocked":
          return `Request ${request.id} was fulfilled, but ${entry.installation.title} installed in an unusable state: ${state.detail ?? "the integration is unavailable"}. ${state.remedy}`;
      }
    }
    case "computer.app.access": {
      if (request.payload.kind !== "computer.app.access")
        throw new Error("Computer app access Request payload is invalid");
      const payload = request.payload;
      if (payload.app === null) {
        // A phone is asked for whole, so its continuation names the phone.
        const phone = (await integrations.computerUsePhones(request.requestedBy)).find(
          ({ runnerId }) => runnerId === payload.runnerId,
        );
        if (request.status === "declined")
          return `Request ${request.id} was declined by the user. Continue the task without ${phone?.name ?? "that phone"} and do not request it again unless the user asks.`;
        return phone
          ? phoneContinuation(request, integrations, phone)
          : `Request ${request.id} was fulfilled, but that phone is no longer available to this task. Continue without it.`;
      }
      const asked = payload.app;
      const { displayName } = asked;
      const machines = await integrations.computerUseMachines(request.requestedBy);
      const machine = machines.find(({ runnerId }) => runnerId === payload.runnerId);
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
      workspaceId: request.targetWorkspaceId,
    }),
    app.connectionId,
  );
  if (!refs.observe) return unavailable;
  return `Request ${request.id} was fulfilled. ${displayName} on ${mac} is ready. Use app(${JSON.stringify(displayName)}, {computer: ${JSON.stringify(mac)}}) in the computer tool. Continue.`;
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
      workspaceId: request.targetWorkspaceId,
    }),
    phone.connection.connectionId,
  );
  if (!refs.observe) return unavailable;
  return `Request ${request.id} was fulfilled. ${phone.name} is ready. Use phone(${JSON.stringify(phone.name)}) in the computer tool. Release it when you are done so another task can use it. Continue.`;
}

function inventoryFor(
  request: Request,
  integrations: IntegrationInventorySource,
  target?: Parameters<IntegrationInventorySource["listDiscoveryInventory"]>[0]["target"],
): Promise<readonly IntegrationInventoryEntry[]> {
  return integrations.listDiscoveryInventory({
    ...(target ? { target } : {}),
    ownerUserId: request.requestedBy,
    threadId: request.originatingThreadId,
    workspaceId: request.targetWorkspaceId,
  });
}

function manifestName(manifest: InstallManifestSummary): string {
  return manifest.kind === "catalog" ? manifest.definition.name : "the proposed integration";
}

/**
 * An installation records where it came from rather than which Request created
 * it, so a catalog install is located by its definition and a proposal by the
 * digest of the artifact that was approved.
 */
function installedFromManifest(
  entry: IntegrationInventoryEntry,
  manifest: InstallManifestSummary,
): boolean {
  const { provenance, sourceKind } = entry.installation;
  if (manifest.kind === "catalog") {
    return (
      sourceKind === "built-in" &&
      CatalogProvenanceSchema.safeParse(provenance).data?.definitionId === manifest.definition.id
    );
  }
  return (
    sourceKind === "proposed" &&
    ProposalProvenanceSchema.safeParse(provenance).data?.artifactDigest === manifest.proposal.digest
  );
}

type IntegrationState =
  | {
      readonly detail: string | null;
      readonly disposition: "needs-account" | "needs-grant" | "ready";
    }
  | { readonly detail: string | null; readonly disposition: "blocked"; readonly remedy: string };

/**
 * Access continuations scope inventory to the fulfilled connection and access,
 * and consider only its requested server or matching connection requirements.
 * Installation continuations use the best state any server reaches: one usable server is
 * enough for the agent to proceed, and otherwise the nearest obstacle is the
 * one worth reporting — a missing Workspace grant is nearer than a missing
 * account, because the account already exists.
 */
function integrationState(
  entry: IntegrationInventoryEntry,
  target?: { readonly connectionId: string | null; readonly serverId: string | null },
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
      return { detail: null, disposition: "ready" };
    // Installed, connected, and still unusable here: the Workspace holds no
    // grant. Calling that "ready" is the lie this split exists to remove.
    case "ACCESS_GRANT_REQUIRED":
      return { detail, disposition: "needs-grant" };
    case "USER_AUTHORIZATION_REQUIRED":
    case "REAUTHORIZATION_REQUIRED":
      return { detail, disposition: "needs-account" };
    case "ADMIN_CONFIGURATION_REQUIRED":
      return {
        detail,
        disposition: "blocked",
        remedy:
          "Request access through integration_request; the connection UI offers supported personal-app setup and identifies any administrator prerequisite.",
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
  payload: {
    readonly computerName: string;
    readonly sessionId?: string | undefined;
    readonly site: string;
  },
  response: PasswordSignInRequestResponse,
): string {
  const { computerName, sessionId, site } = payload;
  switch (response.outcome) {
    case "authorized":
      return "Call sign_in again. If fillLogin answers expired, call sign_in again.";
    case "signed-in":
      return response.method === "saved-password"
        ? `Signed in to ${site} with the user's saved password in Browser Session ${sessionId}. Reload the page and confirm the account before continuing.`
        : `The user signed in to ${site} themselves, and the sign-in was handed to Browser Session ${sessionId}. Reload the page and confirm the account before continuing.`;
    case "expired":
      return `Nobody answered on ${computerName} within an hour, so ${site} was not signed in. Continue without signing in. If the task still needs it, call sign_in again.`;
    case "unavailable":
      switch (response.reason) {
        case "no-saved-login":
          return `There is no saved login for ${site}. Ask the user to sign in in the visible tab or save the login in Opensteer Passwords, then call sign_in again.`;
        case "passwords-off":
          return `Opensteer Passwords is turned off on ${computerName}, so ${site} was not signed in. Continue without signing in unless the user turns it on.`;
        case "not-set-up":
          return `Opensteer Passwords is not set up on ${computerName}, so ${site} was not signed in. Continue without signing in unless the user sets it up.`;
        case "not-responding":
          return `Opensteer Passwords did not respond on ${computerName}, so ${site} was not signed in. Continue without signing in. If the task still needs it later, call sign_in again.`;
      }
    case "outcome-unknown":
      return `Opensteer couldn't confirm the sign-in to ${site}, so it closed Browser Session ${sessionId}. If the task still needs ${site}, open a fresh session with browser_session_open and call sign_in there.`;
    case "interrupted":
      return `The sign-in to ${site} stopped on ${computerName} before anything was handed to Browser Session ${sessionId}. If the task still needs it, call sign_in again.`;
    case "session-closed":
      return `Browser Session ${sessionId} closed before the sign-in to ${site} finished. If the task still needs it, open a fresh session with browser_session_open and call sign_in there.`;
    case "failed":
      switch (response.reason) {
        case "needs-sign-in-page":
          return `Open the sign-in form for ${site} in Browser Session ${sessionId}, then call sign_in again. No approval was requested and no credential was released.`;
        case "wrong-password":
          return `${site} rejected the saved password. Tell the user the saved password for ${site} needs updating in Opensteer Passwords before calling sign_in again.`;
        case "unsupported-page":
          return `Opensteer couldn't sign in to ${site} on this page and the user didn't finish it. Continue without signing in, and ask the user only if the task requires it.`;
        case "blocked-destination":
          return `The ${site} sign-in page tried to reach a blocked address, so nothing was sent. Do not retry; tell the user.`;
        case "cleanup-failed":
          return `Opensteer could not clear its private sign-in for ${site}, so it handed nothing over. If the task still needs it later, call sign_in again.`;
        case "busy":
          return `Another sign-in was already running in this browser. Wait for it to finish; if the task still needs ${site}, call sign_in again.`;
        case "needs-fresh-session":
          return `Saved-password sign-ins work only in a fresh Browser Session. Open one with browser_session_open and fresh: true, then call sign_in there.`;
      }
  }
}
