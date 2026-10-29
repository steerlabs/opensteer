import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { throwIfAborted } from "@opensteer/shared/throwIfAborted";
import { delay } from "@opensteer/shared/delay";
import {
  ApprovePersonalHostAccountLinkRequestSchema,
  ApprovePersonalHostAccountLinkResponseSchema,
  ConfigurePersonalRemoteAccessRequestSchema,
  ConsumePersonalHostAccountLinkRequestSchema,
  PersonalHostAccountLinkErrorResponseSchema,
  IssuePersonalPairingCodeResponseSchema,
  LocalBootstrapSchema,
  PersonalRemoteAccessStatusSchema,
  PersonalHostAccountUnlinkStepRequestSchema,
  ResumePersonalHostAccountLinkRequestSchema,
  PublishPersonalConnectProjectionRequestSchema,
  hostApi,
  hostApiVersionHeader,
  type ConfigurePersonalRemoteAccessRequest,
  type PublishPersonalConnectProjectionRequest,
} from "@opensteer/protocol";
import type {
  IssuePersonalHostAccountLinkChallengeResponse,
  PersonalHostAccountLinkCompletionGrant,
  RevokeConnectRequest,
} from "@opensteer/control-plane-protocol";
import {
  RevokeConnectRequestSchema,
  RevokeConnectResponseSchema,
} from "@opensteer/control-plane-protocol";
import {
  DeploymentIdSchema,
  EnvironmentIdSchema,
  HostInstanceIdSchema,
  HostKeyFingerprintSchema,
  RunnerIdSchema,
  type EnvironmentId,
  type RunnerId,
} from "@opensteer/core";
import {
  hostApiVersion,
  hostKeyFingerprint,
  isPersonalHost,
} from "@opensteer/deployment-authority";
import { z } from "zod";
import { verifyAccessEndpoint, type VerifiedHostEndpoint } from "@opensteer/client/connections";
import { clientTimeoutError } from "@opensteer/client/connections";
import type { PersonalDeploymentManifest } from "../secrets/personal-deployment-store.js";
import {
  PersonalHostRuntimeRecordSchema,
  type PersonalHostRuntimeRecord,
} from "./personal-host-runtime.js";

export interface PersonalHostBootstrapResult {
  readonly runnerEnrollmentToken: string | null;
}

export interface PersonalHostControlPort {
  bootstrap(
    origin: string,
    manifest: PersonalDeploymentManifest,
    ownerClaimToken: string,
    signal: AbortSignal,
  ): Promise<PersonalHostBootstrapResult>;
  claimOwner(
    origin: string,
    manifest: PersonalDeploymentManifest,
    ownerClaimToken: string,
    signal: AbortSignal,
  ): Promise<void>;
  ensureMain(origin: string, deploymentId: string, signal: AbortSignal): Promise<void>;
  waitForHost(
    origin: string,
    manifest: PersonalDeploymentManifest,
    signal: AbortSignal,
  ): Promise<VerifiedHostEndpoint>;
  /**
   * The messaging service's own loopback readiness route. It is answered by the
   * messaging process rather than the Host, but it is polled through this port
   * because it is the supervisor's one HTTP seam: a second injected fetch would
   * be a second place for loopback request policy to drift.
   */
  waitForMessaging(origin: string, deploymentId: string, signal: AbortSignal): Promise<void>;
  waitForRunner(
    origin: string,
    deploymentId: string,
    environmentId: EnvironmentId,
    runnerId: RunnerId,
    signal: AbortSignal,
  ): Promise<void>;
  waitForBrowserPlacement(
    origin: string,
    deploymentId: string,
    environmentId: EnvironmentId,
    runtimeId: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export class PersonalOwnerClaimRequiredError extends Error {
  constructor() {
    super(
      "The Personal Host could not create its passwordless local owner through the same-machine bootstrap contract.",
    );
    this.name = "PersonalOwnerClaimRequiredError";
  }
}

/**
 * A Host that answered has decided. No amount of waiting turns a settled
 * refusal — an expired session, a rejected request, a shape this Desktop
 * cannot read — into readiness, so the polls below surface it instead of
 * sleeping on it until their caller's deadline expires.
 */
export class PersonalHostBootstrapRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PersonalHostBootstrapRefusedError";
  }
}

/**
 * The rpc declaration is the only place the product bootstrap contract lives:
 * the member name is the route and its payload/success schemas are the wire
 * bodies. Deriving all three from it makes a renamed or reshaped member a
 * compile error here rather than a 404 that a readiness poll would mistake for
 * a Host that has not finished starting.
 */
const bootstrapMember = "bootstrap.get";
const bootstrapDeclaration = hostApi[bootstrapMember];
type PersonalHostBootstrap = z.output<(typeof bootstrapDeclaration)["success"]>;

/**
 * The supervisor reaches the rpc group directly rather than through the typed
 * client, so it states the protocol epoch itself. The Host it talks to is the
 * one this app ships, but the Host refuses an unnegotiated request from
 * anybody, and being the supervisor is not an exemption.
 */
const rpcVersionHeader: Readonly<Record<string, string>> = {
  [hostApiVersionHeader]: String(hostApiVersion),
};

export function personalHostBootstrapUrl(origin: string): URL {
  const url = new URL(`/v1/rpc/${bootstrapMember}`, origin);
  url.searchParams.set("input", JSON.stringify(bootstrapDeclaration.payload.parse({})));
  return url;
}

const bootstrapSuccessSchema = z.strictObject({
  data: bootstrapDeclaration.success,
  ok: z.literal(true),
});

const bootstrapFailureSchema = z.strictObject({
  error: bootstrapDeclaration.error,
  ok: z.literal(false),
});

const ownerClaimDeclaration = hostApi["auth.setup.claim"];
const ownerClaimSuccessSchema = z.strictObject({
  data: ownerClaimDeclaration.success,
  ok: z.literal(true),
});

export class NativePersonalHostControl implements PersonalHostControlPort {
  readonly #fetch: PersonalHostFetch;
  readonly #pollIntervalMs: number;
  readonly #requestTimeoutMs: number;

  constructor(
    options: {
      readonly fetch?: PersonalHostFetch;
      readonly pollIntervalMs?: number;
      readonly requestTimeoutMs?: number;
    } = {},
  ) {
    this.#fetch = options.fetch ?? ((_deploymentId, input, init) => globalThis.fetch(input, init));
    this.#pollIntervalMs = boundedDuration(options.pollIntervalMs ?? 250, "Host poll interval");
    this.#requestTimeoutMs = boundedDuration(
      options.requestTimeoutMs ?? 2_000,
      "Host request timeout",
    );
  }

  async waitForHost(
    origin: string,
    manifest: PersonalDeploymentManifest,
    signal: AbortSignal,
  ): Promise<VerifiedHostEndpoint> {
    const expectedDeploymentId = DeploymentIdSchema.parse(manifest.deploymentId);
    const expectedHostInstanceId = HostInstanceIdSchema.parse(manifest.hostInstanceId);
    const expectedFingerprint = HostKeyFingerprintSchema.parse(manifest.hostKeyFingerprint);
    while (true) {
      throwIfAborted(signal, "Personal setup was cancelled.");
      try {
        const health = await this.#request(
          manifest.deploymentId,
          new URL("/healthz", origin),
          signal,
          false,
          "GET",
        );
        if (!health.ok) throw new Error(`Host health returned HTTP ${health.status}.`);
        const verified = await verifyAccessEndpoint({
          expectedDeploymentId,
          fetch: (input, init) => this.#fetch(manifest.deploymentId, input, init ?? {}),
          kind: "canonical",
          origin,
          signal,
          timeoutMs: this.#requestTimeoutMs,
        });
        const discovery = verified.discovery;
        if (
          discovery.hostInstanceId !== expectedHostInstanceId ||
          !verified.discoveryEnvelope ||
          hostKeyFingerprint(verified.discoveryEnvelope.publicKey.spki) !== expectedFingerprint
        ) {
          throw new PersonalHostAuthorityMismatchError();
        }
        if (!isPersonalHost(discovery)) {
          throw new PersonalHostAuthorityMismatchError(
            "Personal Host advertised an incompatible deployment shape.",
          );
        }
        return verified;
      } catch (error) {
        if (error instanceof PersonalHostAuthorityMismatchError) throw error;
        throwIfAborted(signal, "Personal setup was cancelled.");
        await delay(this.#pollIntervalMs, signal);
      }
    }
  }

  /**
   * A spawned messaging service is not an attached one: it binds its port well
   * before its Runner stream authenticates, so only `hostAuthenticated` says
   * the service can carry a provider. Every other answer — not listening yet,
   * 503, a body this build cannot read — is the ordinary waiting case, and the
   * caller's deadline is what ends the wait.
   */
  async waitForMessaging(origin: string, deploymentId: string, signal: AbortSignal): Promise<void> {
    const readiness = new URL("/readyz", origin);
    while (true) {
      throwIfAborted(signal, "Personal setup was cancelled.");
      try {
        const response = await this.#request(deploymentId, readiness, signal, false, "GET");
        if (response.ok) {
          const answer = MessagingReadinessSchema.safeParse(
            await readBoundedJson(response, personalHostJsonOptions(64 * 1_024)),
          );
          if (answer.success && answer.data.ok && answer.data.hostAuthenticated) return;
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
      } catch {
        // A service that has not bound its loopback port yet is the ordinary
        // case while it starts.
      }
      throwIfAborted(signal, "Personal setup was cancelled.");
      await delay(this.#pollIntervalMs, signal);
    }
  }

  async bootstrap(
    origin: string,
    manifest: PersonalDeploymentManifest,
    ownerClaimToken: string,
    signal: AbortSignal,
  ): Promise<PersonalHostBootstrapResult> {
    const claimToken = OwnerClaimTokenSchema.parse(ownerClaimToken);
    let response = await this.#request(
      manifest.deploymentId,
      new URL("/v1/local-bootstrap", origin),
      signal,
      false,
      "GET",
      { authorization: `Bearer ${claimToken}` },
    );
    if (!response.ok) {
      throw new Error(`Personal Host bootstrap returned HTTP ${response.status}.`);
    }
    LocalBootstrapSchema.parse(
      await readBoundedJson(response, personalHostJsonOptions(64 * 1_024)),
    );
    // Re-establish the machine-local session on every Host start. A session
    // created before the positive machine-local marker existed remains a valid
    // browser session, but it cannot control Personal reachability until this
    // process-launch proof marks the fresh session.
    await this.claimOwner(origin, manifest, claimToken, signal);
    response = await this.#request(
      manifest.deploymentId,
      new URL("/v1/local-bootstrap", origin),
      signal,
      true,
      "GET",
      { authorization: `Bearer ${claimToken}` },
    );
    if (!response.ok) throw new PersonalOwnerClaimRequiredError();
    const afterClaim = LocalBootstrapSchema.parse(
      await readBoundedJson(response, personalHostJsonOptions(64 * 1_024)),
    );
    if (afterClaim.setupUrl !== null) throw new PersonalOwnerClaimRequiredError();
    return { runnerEnrollmentToken: afterClaim.runnerEnrollmentToken };
  }

  async ensureMain(origin: string, deploymentIdInput: string, signal: AbortSignal): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    for (;;) {
      const snapshot = await this.#readBootstrap(deploymentId, origin, signal);
      const workspace = snapshot.homeWorkspace;
      if (workspace?.kind === "main" && workspace.status === "ready") return;
      if (
        workspace &&
        (workspace.kind !== "main" ||
          workspace.storageIssue?.retryable === false ||
          (workspace.status !== "provisioning" &&
            !(workspace.status === "unavailable" && workspace.storageIssue?.retryable === true)))
      ) {
        throw new Error(
          `Personal Host did not finish creating Main.${workspace.storageIssue ? ` ${workspace.storageIssue.message}` : ""}`,
        );
      }
      // The primary Runner connection can precede its first storage response.
      // The supervisor's startup deadline and cancellation bound this wait.
      await delay(this.#pollIntervalMs, signal);
    }
  }

  async claimOwner(
    origin: string,
    manifest: PersonalDeploymentManifest,
    ownerClaimToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const claimToken = OwnerClaimTokenSchema.parse(ownerClaimToken);
    const claimed = await this.#request(
      manifest.deploymentId,
      new URL("/v1/rpc/auth.setup.claim", origin),
      signal,
      true,
      "POST",
      {
        ...rpcVersionHeader,
        "content-type": "application/json",
        origin: new URL(origin).origin,
      },
      JSON.stringify(
        ownerClaimDeclaration.payload.parse({ kind: "local-machine-owner", token: claimToken }),
      ),
    );
    if (!claimed.ok) throw new PersonalOwnerClaimRequiredError();
    ownerClaimSuccessSchema.parse(
      await readBoundedJson(claimed, personalHostJsonOptions(64 * 1_024)),
    );
  }

  async waitForRunner(
    origin: string,
    deploymentIdInput: string,
    environmentIdInput: EnvironmentId,
    runnerIdInput: RunnerId,
    signal: AbortSignal,
  ): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const environmentId = EnvironmentIdSchema.parse(environmentIdInput);
    const runnerId = RunnerIdSchema.parse(runnerIdInput);
    while (true) {
      const snapshot = await this.#pollBootstrap(deploymentId, origin, signal);
      const environment = snapshot?.environments.find(
        (candidate) => candidate.id === environmentId,
      );
      if (environment?.connected && environment.runnerId === runnerId) return;
      await delay(this.#pollIntervalMs, signal);
    }
  }

  async waitForBrowserPlacement(
    origin: string,
    deploymentIdInput: string,
    environmentIdInput: EnvironmentId,
    runtimeIdInput: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const environmentId = EnvironmentIdSchema.parse(environmentIdInput);
    const runtimeId = RuntimeIdSchema.parse(runtimeIdInput);
    while (true) {
      const snapshot = await this.#pollBootstrap(deploymentId, origin, signal);
      // The environment binding is enrolled, not claimed, so readiness can
      // never be satisfied by some other connected computer that happens to
      // advertise the same runtime id.
      if (
        snapshot?.browser.placements.some(
          (placement) =>
            placement.runtimeId === runtimeId &&
            placement.environmentIds.includes(environmentId) &&
            placement.available,
        )
      ) {
        return;
      }
      await delay(this.#pollIntervalMs, signal);
    }
  }

  /**
   * One readiness poll. A Host that has not answered yet is the ordinary case
   * while it starts, so that yields null and the caller waits; a Host that
   * refused has already settled the question, and the refusal propagates
   * rather than becoming a wait that only the caller's abort can end.
   */
  async #pollBootstrap(
    deploymentId: string,
    origin: string,
    signal: AbortSignal,
  ): Promise<PersonalHostBootstrap | null> {
    throwIfAborted(signal, "Personal setup was cancelled.");
    try {
      return await this.#readBootstrap(deploymentId, origin, signal);
    } catch (error) {
      throwIfAborted(signal, "Personal setup was cancelled.");
      if (error instanceof PersonalHostBootstrapRefusedError) throw error;
      return null;
    }
  }

  async #readBootstrap(
    deploymentId: string,
    origin: string,
    signal: AbortSignal,
  ): Promise<PersonalHostBootstrap> {
    const response = await this.#request(
      deploymentId,
      personalHostBootstrapUrl(origin),
      signal,
      true,
      "GET",
      rpcVersionHeader,
    );
    if (!response.ok) throw await bootstrapRefusal(response);
    let body: unknown;
    try {
      body = await readBoundedJson(response, personalHostJsonOptions(4 * 1_024 * 1_024));
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw new PersonalHostBootstrapRefusedError(
        "unreadable",
        error instanceof Error ? error.message : "Personal Host returned an unreadable bootstrap.",
      );
    }
    const envelope = bootstrapSuccessSchema.safeParse(body);
    if (!envelope.success) {
      throw new PersonalHostBootstrapRefusedError(
        "incompatible",
        `Personal Host answered ${bootstrapMember} with an incompatible body.`,
      );
    }
    return envelope.data.data;
  }

  async #request(
    deploymentId: string,
    url: URL,
    signal: AbortSignal,
    credentials: boolean,
    method: "GET" | "POST",
    headers: Readonly<Record<string, string>> = {},
    body?: BodyInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(clientTimeoutError("Personal Host request timed out.")),
      this.#requestTimeoutMs,
    );
    timeout.unref?.();
    const relayAbort = () => controller.abort(signal.reason);
    if (signal.aborted) relayAbort();
    else signal.addEventListener("abort", relayAbort, { once: true });
    try {
      return await this.#fetch(deploymentId, url, {
        cache: "no-store",
        ...(body === undefined ? {} : { body }),
        credentials: credentials ? "include" : "omit",
        headers: { accept: "application/json", ...headers },
        method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", relayAbort);
    }
  }
}

export type PersonalHostFetch = (
  deploymentId: string,
  input: URL | RequestInfo,
  init: RequestInit,
) => Promise<Response>;

/** Local-machine control and public one-use exchanges for a running Personal
 * Host. The renderer never receives this port or any Account/Host credential. */
export class NativePersonalRemoteHostControl {
  readonly #fetch: PersonalHostFetch;
  readonly #requestTimeoutMs: number;

  constructor(options: { readonly fetch?: PersonalHostFetch; readonly requestTimeoutMs?: number }) {
    this.#fetch = options.fetch ?? ((_deploymentId, input, init) => globalThis.fetch(input, init));
    this.#requestTimeoutMs = boundedDuration(
      options.requestTimeoutMs ?? 10_000,
      "Personal remote Host request timeout",
    );
  }

  async status(runtimeInput: PersonalHostRuntimeRecord) {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access",
      {
        method: "GET",
        origin: runtime.localOrigin,
      },
    );
    return PersonalRemoteAccessStatusSchema.parse(await this.#json(response));
  }

  async configure(
    runtimeInput: PersonalHostRuntimeRecord,
    input: ConfigurePersonalRemoteAccessRequest,
  ) {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access",
      {
        body: ConfigurePersonalRemoteAccessRequestSchema.parse(input),
        method: "PUT",
        origin: runtime.localOrigin,
      },
    );
    return PersonalRemoteAccessStatusSchema.parse(await this.#json(response));
  }

  async issuePairingCode(runtimeInput: PersonalHostRuntimeRecord) {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access/pairing-codes",
      { body: {}, method: "POST", origin: runtime.localOrigin },
    );
    return IssuePersonalPairingCodeResponseSchema.parse(await this.#json(response));
  }

  async approveAccountLink(
    runtimeInput: PersonalHostRuntimeRecord,
    challenge: IssuePersonalHostAccountLinkChallengeResponse,
  ) {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access/account-link/proof",
      {
        body: ApprovePersonalHostAccountLinkRequestSchema.parse(challenge),
        method: "POST",
        origin: runtime.localOrigin,
      },
    );
    return ApprovePersonalHostAccountLinkResponseSchema.parse(await this.#json(response));
  }

  async consumeAccountLink(
    runtimeInput: PersonalHostRuntimeRecord,
    input: {
      readonly completionGrant: PersonalHostAccountLinkCompletionGrant;
      readonly hostCredential: string;
      readonly linkGeneration: string;
    },
  ) {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access/account-link/consume",
      {
        body: ConsumePersonalHostAccountLinkRequestSchema.parse({
          ...input,
          schemaVersion: 1,
        }),
        method: "POST",
        origin: runtime.localOrigin,
      },
      true,
    );
    const body = await this.#json(response);
    if (response.ok) return PersonalRemoteAccessStatusSchema.parse(body);
    throw accountLinkFailure(response, body, "completion");
  }

  async resumeAccountLink(runtimeInput: PersonalHostRuntimeRecord) {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access/account-link/resume",
      {
        body: ResumePersonalHostAccountLinkRequestSchema.parse({ schemaVersion: 1 }),
        method: "POST",
        origin: runtime.localOrigin,
      },
      true,
    );
    const body = await this.#json(response);
    if (response.ok) return PersonalRemoteAccessStatusSchema.parse(body);
    throw accountLinkFailure(response, body, "activation");
  }

  async revokeAccountSessionsForUnlink(runtimeInput: PersonalHostRuntimeRecord): Promise<void> {
    await this.#accountUnlinkStep(runtimeInput, "revoke-sessions");
  }

  async removeAccountLinkForUnlink(runtimeInput: PersonalHostRuntimeRecord): Promise<void> {
    await this.#accountUnlinkStep(runtimeInput, "remove-link");
  }

  async repairHostedOAuthConnectionsForUnlink(
    runtimeInput: PersonalHostRuntimeRecord,
  ): Promise<void> {
    await this.#accountUnlinkStep(runtimeInput, "repair-hosted-oauth");
  }

  async publishConnectProjection(
    runtimeInput: PersonalHostRuntimeRecord,
    input: PublishPersonalConnectProjectionRequest,
  ): Promise<void> {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access/connect-projection",
      {
        body: PublishPersonalConnectProjectionRequestSchema.parse(input),
        method: "PUT",
        origin: runtime.localOrigin,
      },
    );
    if (response.status !== 204) {
      await response.body?.cancel();
      throw new Error("Personal Host returned an invalid Connect projection response.");
    }
  }

  async revokeConnectResource(
    runtimeInput: PersonalHostRuntimeRecord,
    input: RevokeConnectRequest,
  ) {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      "/v1/personal-remote-access/connect-resource",
      {
        body: RevokeConnectRequestSchema.parse(input),
        method: "DELETE",
        origin: runtime.localOrigin,
      },
    );
    return RevokeConnectResponseSchema.parse(await this.#json(response));
  }

  async #accountUnlinkStep(
    runtimeInput: PersonalHostRuntimeRecord,
    step: "remove-link" | "repair-hosted-oauth" | "revoke-sessions",
  ): Promise<void> {
    const runtime = PersonalHostRuntimeRecordSchema.parse(runtimeInput);
    const response = await this.#request(
      runtime.discovery.deploymentId,
      runtime.localOrigin,
      `/v1/personal-remote-access/account-unlink/${step}`,
      {
        body: PersonalHostAccountUnlinkStepRequestSchema.parse({ schemaVersion: 1 }),
        method: "POST",
        origin: runtime.localOrigin,
      },
    );
    if (response.status !== 204) {
      await response.body?.cancel();
      throw new Error("Personal Host returned an invalid Account unlink response.");
    }
  }

  async #request(
    deploymentId: string,
    baseOrigin: string,
    path: string,
    input: {
      readonly body?: unknown;
      readonly method: "DELETE" | "GET" | "POST" | "PUT";
      readonly origin: string;
      readonly signal?: AbortSignal;
    },
    allowErrorStatus = false,
  ): Promise<Response> {
    const endpoint = new URL(path, baseOrigin).toString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(clientTimeoutError("Personal Host request timed out.")),
      this.#requestTimeoutMs,
    );
    timeout.unref?.();
    const relayAccountAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) relayAccountAbort();
    else input.signal?.addEventListener("abort", relayAccountAbort, { once: true });
    try {
      const response = await this.#fetch(deploymentId, endpoint, {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
        credentials: "include",
        headers: {
          accept: "application/json",
          origin: input.origin,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        method: input.method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      input.signal?.throwIfAborted();
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        await response.body?.cancel();
        throw new Error("Personal Host requests must not redirect.");
      }
      if (!allowErrorStatus && !response.ok) {
        await response.body?.cancel();
        throw new Error(`Personal Host rejected remote access (HTTP ${response.status}).`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", relayAccountAbort);
    }
  }

  #json(response: Response): Promise<unknown> {
    return readBoundedJson(response, personalHostJsonOptions(256 * 1_024));
  }
}

export class PersonalHostAuthorityMismatchError extends Error {
  constructor(message = "Personal Host authority does not match its durable Desktop manifest.") {
    super(message);
    this.name = "PersonalHostAuthorityMismatchError";
  }
}

export class PersonalHostAccountLinkCompletionGrantRejectedError extends Error {
  readonly code = "personal-account-link-completion-grant-rejected";

  constructor() {
    super("The saved Account-link completion grant is invalid or expired.");
    this.name = "PersonalHostAccountLinkCompletionGrantRejectedError";
  }
}

/**
 * The central reservation this link was built on is gone. No Desktop-side
 * refresh can bring it back, so the message names the only move the owner has.
 */
export class PersonalAccountLinkReservationLostError extends Error {
  readonly code: "personal-account-link-cancelled" | "personal-account-link-reservation-expired";

  constructor(
    reason: "personal-account-link-cancelled" | "personal-account-link-reservation-expired",
  ) {
    super(
      reason === "personal-account-link-cancelled"
        ? "This Opensteer Account link was cancelled. Unlink this Opensteer, then link it again."
        : "This Opensteer Account link expired before it finished. Unlink this Opensteer, then link it again.",
    );
    this.code = reason;
    this.name = "PersonalAccountLinkReservationLostError";
  }
}

/**
 * Turns the Host's machine-readable failure reason into the exact error the
 * Desktop recovery path branches on. Prose is never matched: the Host may
 * reword a message, and a reworded message must not change what Desktop does.
 */
function accountLinkFailure(
  response: Response,
  body: unknown,
  stage: "activation" | "completion",
): Error {
  const parsed = PersonalHostAccountLinkErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    const reason = parsed.data.error.reason;
    if (reason === "personal-account-link-grant-expired") {
      return new PersonalHostAccountLinkCompletionGrantRejectedError();
    }
    return new PersonalAccountLinkReservationLostError(reason);
  }
  return new Error(`Personal Host rejected Account-link ${stage} (HTTP ${response.status}).`);
}

/**
 * Classifies a refused bootstrap answer. Only a Host fault or a refusal that
 * names itself retryable can still become success on a later poll; every other
 * answer is the Host's final word and would repeat for as long as anyone waits.
 */
async function bootstrapRefusal(response: Response): Promise<Error> {
  const body = await readBoundedJson(response, personalHostJsonOptions(64 * 1_024)).catch(
    async () => {
      await response.body?.cancel().catch(() => undefined);
      return null;
    },
  );
  const failure = bootstrapFailureSchema.safeParse(body);
  const message = failure.success
    ? `Personal Host refused ${bootstrapMember} (${failure.data.error.code}): ${failure.data.error.message}`
    : `Personal Host answered ${bootstrapMember} with HTTP ${response.status}.`;
  if (response.status >= 500 || (failure.success && failure.data.error.retryable)) {
    return new Error(message);
  }
  return new PersonalHostBootstrapRefusedError(
    failure.success ? failure.data.error.code : "http_error",
    message,
  );
}

const RuntimeIdSchema = z.string().trim().min(1).max(255);

const MessagingReadinessSchema = z.object({
  hostAuthenticated: z.boolean(),
  ok: z.boolean(),
});

const OwnerClaimTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43,128}$/u, "Personal owner claim capability is invalid");

const personalHostJsonOptions = (maximumBytes: number) => ({
  expectedContentType: "application/json",
  fatalUtf8: false,
  maximumBytes,
  sizeError: () => new Error("Personal Host response is too large."),
  unexpectedContentTypeError: () => new Error("Personal Host returned an unexpected content type."),
});

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}
