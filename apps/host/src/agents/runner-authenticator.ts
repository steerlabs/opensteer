import type { MacWindowTarget } from "@opensteer/protocol";
import { computerRunnerGrant } from "./runner-enrollment-grant.js";
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { UserId } from "@opensteer/core";
import { OpensteerError, RunnerIdSchema } from "@opensteer/core";
import {
  phoneRunnerGrant,
  runnerAdvertisesItsEnvironmentBinding,
  runnerIdentityRevokedReason,
  type OpensteerStore,
} from "@opensteer/database";
import { runnerIdentityRevokedMessage, type RunnerIdentity } from "@opensteer/orchestration";
import {
  advertisedRunnerModules,
  runnerDescriptorProfileRefusal,
  DisplayDataTicketClaimsSchema,
  displayDataTicketTtlMs,
  type DisplayDataTicketClaims,
  type DisplayStreamId,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryTicketClaimsSchema,
  RunnerChallengeIdSchema,
  RunnerChallengeSchema,
  runnerProofFormatVersion,
  runnerProofFormatUpdateReason,
  RunnerDescriptorSchema,
  RunnerWireProofSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  runnerEnvironmentIds,
  ShellDataTicketClaimsSchema,
  type RunnerAuxiliaryChallenge,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryModule,
  type RunnerAuxiliaryTicketClaims,
  type RunnerChallenge,
  type RunnerModuleName,
  type RunnerProof,
  type RunnerUpdateProof,
  type RunnerWireProof,
  type ShellDataTicketClaims,
  type ShellSessionId,
} from "@opensteer/protocol";
import { z } from "zod";
import {
  canonicalRunnerPublicKeyPem,
  hashRunnerEnrollmentToken,
  normalizeRunnerEd25519PublicKey,
  runnerPublicKeyFingerprint,
  verifyRunnerAuthenticationSignature,
  verifyRunnerAuxiliarySignature,
  verifyRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";
import { maximumProofTimestampWindowMs } from "@opensteer/shared/proof";

const defaultChallengeLifetimeMs = 15_000;
const auxiliaryTicketType = "opensteer-runner-auxiliary+jwt";
const defaultAuxiliaryTicketLifetimeMs = 60_000;
/**
 * A distinct JWT type for the shell data socket, even though one key signs
 * both. The two credentials admit different things — an auxiliary ticket opens
 * a control stream, a data ticket pairs one already-reserved session — so
 * neither may ever be read as the other.
 */
const shellDataTicketType = "opensteer-shell-data+jwt";
const shellDataTicketLifetimeMs = 30_000;

export class RunnerAuthenticator {
  readonly #challengeLifetimeMs: number;
  readonly #issuancePrivateKey: KeyObject;
  readonly #issuancePublicKey: KeyObject;
  readonly #auxiliaryTicketLifetimeMs: number;
  /**
   * Every auxiliary nonce this Host has already honored, kept until the ticket
   * that carried it could no longer be valid anyway. A ticket is one use: the
   * proof beside it stops a stranger replaying one, and this stops the Runner
   * itself opening a second stream on a credential meant for one.
   */
  readonly #consumedAuxiliaryNonces = new Map<string, number>();
  /** Data-ticket nonces are isolated by audience. */
  readonly #consumedDisplayDataNonces = new Map<string, number>();
  readonly #consumedShellDataNonces = new Map<string, number>();
  readonly #now: () => number;
  readonly #store: Pick<
    OpensteerStore,
    | "authenticateRunnerConnection"
    | "createRunnerEnrollment"
    | "enrollRunnerConnection"
    | "runnerForAuthentication"
  >;

  constructor(options: {
    readonly auxiliaryTicketLifetimeMs?: number;
    readonly challengeLifetimeMs?: number;
    readonly issuancePrivateKey: KeyObject;
    readonly now?: () => number;
    readonly store: Pick<
      OpensteerStore,
      | "authenticateRunnerConnection"
      | "createRunnerEnrollment"
      | "enrollRunnerConnection"
      | "runnerForAuthentication"
    >;
  }) {
    this.#challengeLifetimeMs = options.challengeLifetimeMs ?? defaultChallengeLifetimeMs;
    if (
      this.#challengeLifetimeMs < 1 ||
      this.#challengeLifetimeMs > maximumProofTimestampWindowMs
    ) {
      throw new Error("Runner challenge lifetime must be between 1ms and 30 seconds");
    }
    if (
      options.issuancePrivateKey.type !== "private" ||
      options.issuancePrivateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new TypeError("Runner enrollment issuance key must be an Ed25519 private key");
    }
    this.#issuancePrivateKey = options.issuancePrivateKey;
    this.#issuancePublicKey = createPublicKey(options.issuancePrivateKey);
    this.#auxiliaryTicketLifetimeMs =
      options.auxiliaryTicketLifetimeMs ?? defaultAuxiliaryTicketLifetimeMs;
    if (this.#auxiliaryTicketLifetimeMs < 1_000 || this.#auxiliaryTicketLifetimeMs > 300_000) {
      throw new Error("Runner auxiliary ticket lifetime must be from 1 through 300 seconds");
    }
    this.#now = options.now ?? Date.now;
    this.#store = options.store;
  }

  async createEnrollment(input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly createdBy: UserId;
    readonly idempotencyKey: string;
    readonly lifetimeSeconds: number;
    readonly name: string;
    readonly runnerKind: "local" | "managed";
  }): Promise<{
    readonly enrollmentId: string;
    readonly expiresAt: string;
    readonly token: string;
  }> {
    return this.#createEnrollment({
      ...input,
      purpose: "standard",
    });
  }

  /**
   * A phone's one-use enrollment, owned by the person minting it.
   * Its fixed integrations grant covers Android's screen or the iPhone's data
   * apps, without the computer reach preset. The issuance purpose isolates
   * iPhone mint retries from Android's existing transcript.
   */
  async createPhoneEnrollment(input: {
    readonly createdBy: UserId;
    readonly idempotencyKey: string;
    readonly lifetimeSeconds: number;
    readonly name: string;
    readonly profile?: "iphone";
  }): Promise<{
    readonly enrollmentId: string;
    readonly expiresAt: string;
    readonly token: string;
  }> {
    return this.#createEnrollment({
      ...input,
      allowedModules: phoneRunnerGrant,
      purpose: input.profile === "iphone" ? "iphone" : "phone",
      runnerKind: "local",
    });
  }

  /**
   * A Main Runner is owned by the deployment, so `createdBy` is audit metadata
   * rather than ownership. A Host provisioning its own co-located Main Runner at
   * startup has no user to record and passes null.
   */
  async createInitialMainEnrollment(input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly createdBy: UserId | null;
    readonly idempotencyKey: string;
    readonly lifetimeSeconds: number;
  }): Promise<{
    readonly enrollmentId: string;
    readonly expiresAt: string;
    readonly token: string;
  }> {
    return this.#createEnrollment({
      ...input,
      mainEnrollmentPurpose: "initial",
      name: "Main computer",
      purpose: "initial-main",
      runnerKind: "main",
    });
  }

  /**
   * Records a one-use enrollment the platform minted for a computer it will
   * start itself — a cloud browser pod, a messaging pod. The token is the
   * caller's, so this only writes the grant it belongs to; a replay with the
   * same key and token is the same enrollment, and one with different modules
   * is refused as a different request.
   */
  async ensureConfiguredDeploymentEnrollment(input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly idempotencyKey: string;
    readonly lifetimeSeconds: number;
    readonly name: string;
    readonly token: string;
  }): Promise<void> {
    this.#assertConfiguredToken(input);
    await this.#store.createRunnerEnrollment({
      allowedModules: computerRunnerGrant(input.allowedModules),
      createdBy: null,
      expiresAt: new Date(this.#now() + input.lifetimeSeconds * 1_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      requestFingerprint: configuredEnrollmentFingerprint(input),
      runnerKind: "managed",
      tokenHash: hashRunnerEnrollmentToken(input.token),
    });
  }

  #assertConfiguredToken(input: {
    readonly lifetimeSeconds: number;
    readonly token: string;
  }): void {
    if (input.token.length < 32 || input.token.length > 4_096) {
      throw new Error("A configured Runner enrollment token is invalid");
    }
    if (
      !Number.isSafeInteger(input.lifetimeSeconds) ||
      input.lifetimeSeconds < 60 ||
      input.lifetimeSeconds > 7 * 24 * 60 * 60
    ) {
      throw new Error("Runner enrollment lifetime must be between 60 seconds and seven days");
    }
  }

  async ensureConfiguredInitialMainEnrollment(input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly idempotencyKey: string;
    readonly lifetimeSeconds: number;
    readonly token: string;
  }): Promise<void> {
    this.#assertConfiguredToken(input);
    await this.#store.createRunnerEnrollment({
      allowedModules: computerRunnerGrant(input.allowedModules),
      createdBy: null,
      expiresAt: new Date(this.#now() + input.lifetimeSeconds * 1_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      mainEnrollmentPurpose: "initial",
      name: "Main computer",
      requestFingerprint: configuredEnrollmentFingerprint(input),
      runnerKind: "main",
      tokenHash: hashRunnerEnrollmentToken(input.token),
    });
  }

  async #createEnrollment(input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly createdBy: UserId | null;
    readonly idempotencyKey: string;
    readonly lifetimeSeconds: number;
    readonly mainEnrollmentPurpose?: "initial";
    readonly name: string;
    /**
     * Deliberately absent from the issuance transcript below: the transcript is
     * the enrollment token's signed content and every enrollment already issued
     * replays against the fingerprint derived from it. Adding a field would
     * change that fingerprint and refuse every Runner already attached.
     */
    readonly ownerUserId?: UserId;
    readonly purpose: "initial-main" | "iphone" | "phone" | "standard";
    readonly runnerKind: "main" | "local" | "managed";
  }): Promise<{
    readonly enrollmentId: string;
    readonly expiresAt: string;
    readonly token: string;
  }> {
    if (
      !Number.isSafeInteger(input.lifetimeSeconds) ||
      input.lifetimeSeconds < 60 ||
      input.lifetimeSeconds > 24 * 60 * 60
    ) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Runner enrollment lifetime must be between 60 seconds and 24 hours",
      });
    }
    if (!/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey)) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Runner enrollment idempotency key is invalid",
      });
    }
    const issuanceTranscript = Buffer.from(
      JSON.stringify([
        "opensteer-runner-enrollment-issuance-v2",
        "allowedModules",
        [...input.allowedModules].sort(),
        "createdBy",
        input.createdBy,
        "idempotencyKey",
        input.idempotencyKey,
        "purpose",
        input.purpose,
        "runnerKind",
        input.runnerKind,
        "lifetimeSeconds",
        input.lifetimeSeconds,
        "name",
        input.name,
      ]),
      "utf8",
    );
    const requestFingerprint = `sha256:${createHash("sha256")
      .update(issuanceTranscript)
      .digest("base64url")}`;
    const token = sign(null, issuanceTranscript, this.#issuancePrivateKey).toString("base64url");
    const expiresAt = new Date(this.#now() + input.lifetimeSeconds * 1_000);
    const enrollment = await this.#store.createRunnerEnrollment({
      allowedModules:
        input.purpose === "phone" || input.purpose === "iphone"
          ? phoneRunnerGrant
          : computerRunnerGrant(input.allowedModules),
      createdBy: input.createdBy,
      ...(input.purpose === "iphone" ? { deviceProfile: "iphone" as const } : {}),
      expiresAt,
      id: `ren_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      requestFingerprint,
      ...(input.mainEnrollmentPurpose
        ? { mainEnrollmentPurpose: input.mainEnrollmentPurpose }
        : {}),
      runnerKind: input.runnerKind,
      tokenHash: hashRunnerEnrollmentToken(token),
    });
    return { enrollmentId: enrollment.id, expiresAt: enrollment.expiresAt.toISOString(), token };
  }

  issueChallenge(): RunnerChallenge {
    return RunnerChallengeSchema.parse({
      challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
      expiresAt: new Date(this.#now() + this.#challengeLifetimeMs).toISOString(),
      hostSessionId: randomBytes(24).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      type: "host.challenge",
      proofFormatVersion: runnerProofFormatVersion,
    });
  }

  /** Authenticate the raw JSON before a domain reader can strip or normalize anything. */
  async verifyProof(challenge: RunnerChallenge, wireProof: RunnerWireProof): Promise<RunnerProof> {
    const proof = RunnerWireProofSchema.parse(wireProof);
    this.#checkProofFormat(challenge, proof);
    if (proof.challengeId !== challenge.challengeId) throw authenticationFailed();
    if (proof.type === "runner.enroll") {
      if (
        !verifyRunnerEnrollmentSignature(proof.publicKeyPem, { ...proof, challenge }, this.#now())
      )
        throw authenticationFailed();
    } else await this.#verifyEnrolledProof(challenge, proof);
    const descriptor = RunnerDescriptorSchema.parse(proof.descriptor);
    return { ...proof, proofFormatVersion: runnerProofFormatVersion, descriptor };
  }

  #checkProofFormat(challenge: RunnerChallenge, proof: RunnerWireProof): void {
    if (
      challenge.proofFormatVersion !== runnerProofFormatVersion ||
      proof.proofFormatVersion !== runnerProofFormatVersion
    )
      throw new OpensteerError({
        code: "forbidden",
        reason: "runner-proof-format-mismatch",
        message: runnerProofFormatUpdateReason,
      });
  }

  async authenticate(
    challenge: RunnerChallenge,
    wireProof: RunnerWireProof,
    checkAdmission?: (proof: RunnerProof) => void,
  ): Promise<RunnerIdentity> {
    const proof = await this.verifyProof(challenge, wireProof);
    checkAdmission?.(proof);
    const record =
      proof.type === "runner.enroll" ? await this.#enroll(proof) : await this.#authenticate(proof);
    const fence = {
      bootId: proof.descriptor.bootId,
      connectionGeneration: record.connectionGeneration,
      connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
      connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
      runnerId: proof.descriptor.runnerId,
    };
    return {
      ...proof.descriptor,
      ...fence,
      allowedModules: record.allowedModules,
      environmentIds: runnerEnvironmentIds(proof.descriptor),
      fence,
      // Carried out of the admission transaction rather than read again here:
      // the point of the fence is the generation that transaction saw.
      personalRemoteAccessGeneration: record.personalRemoteAccessGeneration,
    };
  }

  /** Proves an existing identity without admitting it or consuming an enrollment. */
  async authenticateUpdateRefusal(challenge: RunnerChallenge, proof: RunnerUpdateProof) {
    const runner = await this.#verifyEnrolledProof(challenge, proof);
    return { runnerId: runner.runnerId, connectionGeneration: runner.connectionGeneration };
  }

  /**
   * Mints the one-use credential a Runner presents on a new auxiliary socket.
   * It names the exact primary connection that asked, so it cannot be carried
   * across a reconnect, and it is signed rather than random so the Host need
   * not remember every outstanding ticket to recognise one.
   */
  issueAuxiliaryTicket(
    identity: RunnerIdentity,
    module: RunnerAuxiliaryModule,
  ): { readonly expiresAt: string; readonly ticket: string } {
    if (!identity.allowedModules.includes(module)) {
      throw new OpensteerError({
        code: "forbidden",
        message: `Runner enrollment does not allow the ${module} module`,
      });
    }
    if (identity.modules[module] === undefined) {
      throw new OpensteerError({
        code: "forbidden",
        message: `Runner does not advertise the ${module} module`,
      });
    }
    const issuedAt = this.#now();
    const claims: RunnerAuxiliaryTicketClaims = RunnerAuxiliaryTicketClaimsSchema.parse({
      audience: "opensteer-runner-auxiliary",
      bootId: identity.bootId,
      connectionGeneration: identity.connectionGeneration,
      connectionId: identity.connectionId,
      expiresAt: new Date(issuedAt + this.#auxiliaryTicketLifetimeMs).toISOString(),
      issuedAt: new Date(issuedAt).toISOString(),
      module,
      nonce: randomBytes(32).toString("base64url"),
      runnerId: identity.runnerId,
    });
    return { expiresAt: claims.expiresAt, ticket: this.#signTicket(auxiliaryTicketType, claims) };
  }

  #signTicket(type: string, claims: unknown): string {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: type }), "utf8").toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = sign(null, Buffer.from(signingInput, "ascii"), this.#issuancePrivateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  /**
   * Mints the one-use credential the target presents on a session's data
   * socket.
   *
   * It names the whole auxiliary fence of the `shell` stream that was asked to
   * serve the session, not merely the Runner: the socket that comes back is
   * checked against that one stream, so a ticket cannot pair a session with a
   * stream admitted after a reconnect, and cannot survive a new Host epoch.
   */
  issueShellDataTicket(input: {
    readonly fence: RunnerAuxiliaryFrameFence;
    readonly sessionId: ShellSessionId;
  }): { readonly claims: ShellDataTicketClaims; readonly ticket: string } {
    if (input.fence.module !== "shell") {
      throw new OpensteerError({
        code: "forbidden",
        message: "A shell data ticket names only the shell module",
      });
    }
    const issuedAt = this.#now();
    const claims = ShellDataTicketClaimsSchema.parse({
      ...input.fence,
      audience: "opensteer-shell-data",
      expiresAt: new Date(issuedAt + shellDataTicketLifetimeMs).toISOString(),
      issuedAt: new Date(issuedAt).toISOString(),
      module: "shell",
      nonce: randomBytes(32).toString("base64url"),
      sessionId: input.sessionId,
      type: "opensteer.shell.data-ticket",
    });
    return { claims, ticket: this.#signTicket(shellDataTicketType, claims) };
  }

  /**
   * Reads a data ticket and burns its nonce, so the first socket to present it
   * is the only one that ever can. Everything else the ticket asserts — that
   * the stream is still the one named, that the session is still pending — is
   * the session's own to check, because only it knows.
   */
  verifyShellDataTicket(ticket: string): ShellDataTicketClaims {
    const claims = this.#readSignedTicket(ticket, shellDataTicketType, ShellDataTicketClaimsSchema);
    this.#consumeNonce(this.#consumedShellDataNonces, claims.nonce, claims.expiresAt);
    return claims;
  }

  issueDisplayDataTicket(input: {
    readonly fence: RunnerAuxiliaryFrameFence;
    readonly display: "main";
    readonly target?: MacWindowTarget;
    readonly streamId: DisplayStreamId;
  }): { readonly claims: DisplayDataTicketClaims; readonly ticket: string } {
    if (input.fence.module !== "integrations") {
      throw new OpensteerError({
        code: "forbidden",
        message: "A display ticket names only integrations",
      });
    }
    const issuedAt = this.#now();
    const claims = DisplayDataTicketClaimsSchema.parse({
      ...input.fence,
      audience: "opensteer-display-data",
      type: "opensteer.display.data-ticket",
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + displayDataTicketTtlMs).toISOString(),
      nonce: randomBytes(32).toString("base64url"),
      display: input.display,
      ...(input.target ? { target: input.target } : {}),
      streamId: input.streamId,
    });
    return { claims, ticket: this.#signTicket("opensteer-display-data+jwt", claims) };
  }

  verifyDisplayDataTicket(ticket: string): DisplayDataTicketClaims {
    const claims = this.#readSignedTicket(
      ticket,
      "opensteer-display-data+jwt",
      DisplayDataTicketClaimsSchema,
    );
    this.#consumeNonce(this.#consumedDisplayDataNonces, claims.nonce, claims.expiresAt);
    return claims;
  }

  issueAuxiliaryChallenge(module: RunnerAuxiliaryModule): RunnerAuxiliaryChallenge {
    return RunnerAuxiliaryChallengeSchema.parse({
      challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
      expiresAt: new Date(this.#now() + this.#challengeLifetimeMs).toISOString(),
      hostSessionId: randomBytes(24).toString("base64url"),
      module,
      nonce: randomBytes(32).toString("base64url"),
      type: "host.auxiliary.challenge",
    });
  }

  /**
   * Admits an auxiliary socket. The ticket alone is a bearer value, so the
   * holder also signs this socket's fresh challenge together with the ticket's
   * digest using the Runner's own key — and the nonce is burned, so the same
   * ticket cannot open a second stream.
   */
  async verifyAuxiliary(
    challenge: RunnerAuxiliaryChallenge,
    proof: {
      readonly bootId: RunnerIdentity["bootId"];
      readonly challengeId: RunnerChallenge["challengeId"];
      readonly module: RunnerAuxiliaryModule;
      readonly runnerId: RunnerIdentity["runnerId"];
      readonly signature: string;
      readonly ticket: string;
    },
  ): Promise<RunnerAuxiliaryTicketClaims> {
    if (proof.challengeId !== challenge.challengeId || proof.module !== challenge.module) {
      throw authenticationFailed();
    }
    const claims = this.#readAuxiliaryTicket(proof.ticket);
    if (
      claims.runnerId !== proof.runnerId ||
      claims.bootId !== proof.bootId ||
      claims.module !== proof.module
    ) {
      throw authenticationFailed();
    }
    const runner = await this.#store.runnerForAuthentication(claims.runnerId);
    if (
      !runner ||
      runner.revokedAt ||
      runner.connectionGeneration !== claims.connectionGeneration ||
      !runner.allowedModules.includes(claims.module)
    ) {
      throw authenticationFailed();
    }
    if (
      !verifyRunnerAuxiliarySignature(
        normalizeRunnerEd25519PublicKey(runner.publicKeyPem),
        {
          bootId: proof.bootId,
          challenge,
          module: proof.module,
          runnerId: proof.runnerId,
          signature: proof.signature,
          ticket: proof.ticket,
        },
        this.#now(),
      )
    ) {
      throw authenticationFailed();
    }
    this.#consumeAuxiliaryNonce(claims);
    return claims;
  }

  #readAuxiliaryTicket(ticket: string): RunnerAuxiliaryTicketClaims {
    return this.#readSignedTicket(ticket, auxiliaryTicketType, RunnerAuxiliaryTicketClaimsSchema);
  }

  #readSignedTicket<Claims extends { readonly expiresAt: string }>(
    ticket: string,
    type: string,
    schema: z.ZodType<Claims>,
  ): Claims {
    const parts = ticket.split(".");
    const [header, payload, signature] = parts;
    if (parts.length !== 3 || !header || !payload || !signature) throw authenticationFailed();
    if (
      !verify(
        null,
        Buffer.from(`${header}.${payload}`, "ascii"),
        this.#issuancePublicKey,
        Buffer.from(signature, "base64url"),
      )
    ) {
      throw authenticationFailed();
    }
    let decodedHeader: unknown;
    let decodedPayload: unknown;
    try {
      decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
      decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw authenticationFailed();
    }
    if (
      typeof decodedHeader !== "object" ||
      decodedHeader === null ||
      (decodedHeader as { readonly typ?: unknown }).typ !== type
    ) {
      throw authenticationFailed();
    }
    const claims = schema.safeParse(decodedPayload);
    if (!claims.success) throw authenticationFailed();
    if (Date.parse(claims.data.expiresAt) <= this.#now()) throw authenticationFailed();
    return claims.data;
  }

  #consumeAuxiliaryNonce(claims: RunnerAuxiliaryTicketClaims): void {
    this.#consumeNonce(this.#consumedAuxiliaryNonces, claims.nonce, claims.expiresAt);
  }

  #consumeNonce(burned: Map<string, number>, nonce: string, expiresAt: string): void {
    const now = this.#now();
    for (const [seen, expiry] of burned) {
      if (expiry <= now) burned.delete(seen);
    }
    if (burned.has(nonce)) {
      throw new OpensteerError({ code: "forbidden", message: "That ticket was already used" });
    }
    burned.set(nonce, Date.parse(expiresAt));
  }

  async #enroll(proof: Extract<RunnerProof, { readonly type: "runner.enroll" }>) {
    const publicKey = normalizeRunnerEd25519PublicKey(proof.publicKeyPem);
    const enrollmentTokenHash = hashRunnerEnrollmentToken(proof.credential.enrollmentToken);
    const connection = await this.#store.enrollRunnerConnection({
      descriptor: proof.descriptor,
      enrollmentTokenHash,
      publicKeyFingerprint: runnerPublicKeyFingerprint(publicKey),
      publicKeyPem: canonicalRunnerPublicKeyPem(publicKey),
    });
    return connection;
  }

  async #authenticate(proof: Extract<RunnerProof, { readonly type: "runner.authenticate" }>) {
    const runner = await this.#store.runnerForAuthentication(proof.descriptor.runnerId);
    if (
      !runner ||
      runner.runnerKind !== proof.descriptor.runnerKind ||
      !runnerAdvertisesItsEnvironmentBinding(
        runner.environmentIds,
        runnerEnvironmentIds(proof.descriptor),
      )
    )
      throw authenticationFailed();
    const profileRefusal = runnerDescriptorProfileRefusal(runner.deviceProfile, proof.descriptor);
    if (profileRefusal) throw new OpensteerError({ code: "forbidden", ...profileRefusal });
    // The grant is enforced on every reconnect, not merely at enrollment: a
    // Runner that could add a module later would widen its own authority.
    const refused = advertisedRunnerModules(proof.descriptor.modules).filter(
      (module) => !runner.allowedModules.includes(module),
    );
    if (refused.length > 0) {
      throw new OpensteerError({
        code: "forbidden",
        message: `Runner enrollment does not allow the ${refused.sort().join(", ")} module`,
      });
    }
    return this.#store.authenticateRunnerConnection(proof.descriptor);
  }

  async #verifyEnrolledProof(challenge: RunnerChallenge, proof: RunnerUpdateProof) {
    this.#checkProofFormat(challenge, proof);
    if (proof.challengeId !== challenge.challengeId) throw authenticationFailed();
    const identity = z.object({ runnerId: RunnerIdSchema }).parse(proof.descriptor);
    const runner = await this.#store.runnerForAuthentication(identity.runnerId);
    if (runner?.revokedAt) throw runnerIdentityRevoked();
    if (!runner) throw authenticationFailed();
    const publicKey = normalizeRunnerEd25519PublicKey(runner.publicKeyPem);
    if (runnerPublicKeyFingerprint(publicKey) !== runner.publicKeyFingerprint) {
      throw new OpensteerError({
        code: "internal",
        message: "Enrolled Runner key is inconsistent",
      });
    }
    if (
      !verifyRunnerAuthenticationSignature(
        publicKey,
        {
          challenge,
          descriptor: proof.descriptor,
          signature: proof.signature,
        },
        this.#now(),
      )
    ) {
      throw authenticationFailed();
    }
    const claim = z
      .object({ runnerKind: z.enum(["main", "local", "managed"]) })
      .parse(proof.descriptor);
    if (runner.runnerKind !== claim.runnerKind) {
      if (runner.deviceProfile === "iphone") {
        const refusal = runnerDescriptorProfileRefusal(
          runner.deviceProfile,
          RunnerDescriptorSchema.parse(proof.descriptor),
        );
        if (refusal) throw new OpensteerError({ code: "forbidden", ...refusal });
      }
      throw authenticationFailed();
    }
    return runner;
  }
}

/**
 * A configured enrollment's replay identity. The token is part of it because a
 * platform that reissues a different token for the same slot is standing up a
 * different computer, not repeating itself.
 */
function configuredEnrollmentFingerprint(input: {
  readonly idempotencyKey: string;
  readonly token: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "opensteer-runner-configured-enrollment-v1",
        input.idempotencyKey,
        hashRunnerEnrollmentToken(input.token),
      ]),
    )
    .digest("base64url")}`;
}

function authenticationFailed(): OpensteerError {
  return new OpensteerError({ code: "unauthorized", message: "Runner authentication failed" });
}

function runnerIdentityRevoked(): OpensteerError {
  return new OpensteerError({
    code: "unauthorized",
    message: runnerIdentityRevokedMessage,
    reason: runnerIdentityRevokedReason,
  });
}
