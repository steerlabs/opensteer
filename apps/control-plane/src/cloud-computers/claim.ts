import { createHash, createPublicKey, verify } from "node:crypto";
import { Agent } from "node:https";
import {
  createPublicHttpsFetch,
  resolvePublicAddress,
  type ResolvedPublicAddress,
} from "@opensteer/access/host";
import {
  ManagedHomeClaimClaimsSchema,
  ManagedHomeClaimReceiptSchema,
  managedHomeClaimPath,
  managedHomeClaimReceiptSigningBytes,
  type ManagedHomeClaimClaims,
  type ManagedHomeClaimReceipt,
  type ManagedHomeClaimRequest,
} from "@opensteer/control-plane-protocol";
import {
  HostDescriptorSchema,
  hostKeyFingerprint,
  verifyHostDiscoveryEnvelope,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import {
  CloudComputerClaimSupersededError,
  type CloudComputerClaimJob,
  type CloudComputerStore,
} from "./store.js";

/** Past this after the Home was asked for, an unclaimed Cloud Computer needs a person. */
export const cloudComputerClaimDeadlineMilliseconds = 60 * 60_000;
const pollMilliseconds = 5_000;

/** Why a call to a managed Home failed; `permanent` when the same call can never succeed. */
export class ManagedHomeError extends Error {
  readonly permanent: boolean;

  constructor(message: string, options: { readonly permanent: boolean; readonly cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ManagedHomeError";
    this.permanent = options.permanent;
  }
}

/** How Account claims a managed Home, as one exchange with one endpoint. */
export interface ManagedHomeClient {
  /**
   * Reads the Home's signed discovery, hands it to `prepare`, and sends the
   * claim `prepare` builds only to the endpoint that just answered with that
   * discovery. `prepare` throws to send nothing.
   */
  claim(
    origin: string,
    prepare: (envelope: HostDiscoveryEnvelope) => Promise<ManagedHomeClaimRequest>,
  ): Promise<{
    readonly envelope: HostDiscoveryEnvelope;
    readonly receipt: ManagedHomeClaimReceipt;
  }>;
}

const managedHomeResponseBytes = 64 * 1_024;
const managedHomeTimeoutMilliseconds = 15_000;

export class HttpManagedHomeClient implements ManagedHomeClient {
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #resolve: (hostname: string) => Promise<ResolvedPublicAddress>;
  readonly #ca: string | undefined;

  constructor(
    options: {
      /** Replaces the whole transport; tests that stand in for a Home. */
      readonly fetch?: typeof globalThis.fetch;
      /** Where the Home's hostname is dialled; public DNS, checked, by default. */
      readonly resolve?: (hostname: string) => Promise<ResolvedPublicAddress>;
      /** Extra trust roots; tests only. */
      readonly ca?: string;
    } = {},
  ) {
    this.#fetch = options.fetch;
    this.#resolve = options.resolve ?? resolvePublicAddress;
    this.#ca = options.ca;
  }

  async claim(
    origin: string,
    prepare: (envelope: HostDiscoveryEnvelope) => Promise<ManagedHomeClaimRequest>,
  ): Promise<{
    readonly envelope: HostDiscoveryEnvelope;
    readonly receipt: ManagedHomeClaimReceipt;
  }> {
    // One address and one kept-alive TLS connection for both requests: the
    // material goes only to the server whose discovery was just verified.
    let agent: Agent | undefined;
    let fetch = this.#fetch;
    if (!fetch) {
      let address: ResolvedPublicAddress;
      try {
        address = await this.#resolve(new URL(origin).hostname);
      } catch (cause) {
        throw new ManagedHomeError("The Cloud Computer's address didn't resolve", {
          permanent: false,
          cause,
        });
      }
      agent = new Agent({ keepAlive: true, maxSockets: 1 });
      fetch = createPublicHttpsFetch({
        agent,
        maxResponseBytes: managedHomeResponseBytes,
        resolve: async () => address,
        timeoutMs: managedHomeTimeoutMilliseconds,
        ...(this.#ca ? { ca: this.#ca } : {}),
      });
    }
    try {
      const envelope = await discover(fetch, origin);
      const request = await prepare(envelope);
      const response = await send(fetch, origin, managedHomeClaimPath, {
        method: "POST",
        body: JSON.stringify(request),
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) throw homeAnswered(response.status);
      const receipt = ManagedHomeClaimReceiptSchema.safeParse(await readJson(response));
      if (!receipt.success)
        throw new ManagedHomeError("The Cloud Computer answered with something else", {
          permanent: true,
        });
      return { envelope, receipt: receipt.data };
    } finally {
      agent?.destroy();
    }
  }
}

async function discover(
  fetch: typeof globalThis.fetch,
  origin: string,
): Promise<HostDiscoveryEnvelope> {
  const response = await send(fetch, origin, "/.well-known/opensteer", { method: "GET" });
  // A Home still starting answers from its proxy; only the claim itself refuses for good.
  if (!response.ok)
    throw new ManagedHomeError(
      `The Cloud Computer isn't serving its Home yet (HTTP ${response.status})`,
      { permanent: false },
    );
  const descriptor = HostDescriptorSchema.safeParse(await readJson(response));
  if (!descriptor.success)
    throw new ManagedHomeError("The Cloud Computer isn't serving its Home yet", {
      permanent: false,
    });
  try {
    verifyHostDiscoveryEnvelope(descriptor.data.authority);
  } catch (cause) {
    throw new ManagedHomeError("The Cloud Computer's identity didn't verify", {
      permanent: true,
      cause,
    });
  }
  return descriptor.data.authority;
}

/** A redirect is never followed: the claim goes to the Home's own origin or nowhere. */
async function send(
  fetch: typeof globalThis.fetch,
  origin: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
    });
  } catch (cause) {
    throw new ManagedHomeError("The Cloud Computer didn't answer", { permanent: false, cause });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ManagedHomeError("The Cloud Computer redirected instead of answering", {
      permanent: false,
    });
  }
  return response;
}

/**
 * Claims each ready Cloud Computer's Home for the Account that paid for it:
 * verifies the Home answers as the identity Account pinned, presents the sealed
 * setup code with a freshly signed assertion naming the owner, and records the
 * Home's signed receipt. A lost answer is recovered by asking again: the Home
 * answers the same claim with its first receipt.
 */
export class CloudComputerClaimer {
  readonly #store: Pick<
    CloudComputerStore,
    "claimDue" | "claimMaterial" | "deferClaim" | "failClaim" | "recordClaim"
  >;
  readonly #home: ManagedHomeClient;
  readonly #sign: (claims: ManagedHomeClaimClaims) => Promise<string>;
  readonly #issuer: string;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(input: {
    readonly store: Pick<
      CloudComputerStore,
      "claimDue" | "claimMaterial" | "deferClaim" | "failClaim" | "recordClaim"
    >;
    readonly home: ManagedHomeClient;
    readonly sign: (claims: ManagedHomeClaimClaims) => Promise<string>;
    readonly issuer: URL;
    readonly onError: (error: unknown) => void;
    readonly now?: () => number;
  }) {
    this.#store = input.store;
    this.#home = input.home;
    this.#sign = input.sign;
    this.#issuer = input.issuer.origin;
    this.#onError = input.onError;
    this.#now = input.now ?? Date.now;
  }

  start(): void {
    this.#schedule(0);
  }

  /** Runs soon, for a Home the provisioner just reported ready. */
  kick(): void {
    if (this.#stopped) return;
    if (this.#running) this.#again = true;
    else this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /** Works every claim that is due; answers how many attempts ran. */
  async runOnce(): Promise<number> {
    let attempts = 0;
    for (;;) {
      const job = await this.#store.claimDue();
      if (!job) return attempts;
      attempts += 1;
      await this.#attempt(job);
    }
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const running = this.runOnce()
        .then(() => undefined)
        .catch((error: unknown) => this.#onError(error));
      this.#running = running;
      void running.finally(() => {
        this.#running = undefined;
        const again = this.#again;
        this.#again = false;
        this.#schedule(again ? 0 : pollMilliseconds);
      });
    }, delay);
    this.#timer.unref();
  }

  async #attempt(job: CloudComputerClaimJob): Promise<void> {
    try {
      await this.#claim(job);
    } catch (error) {
      if (error instanceof CloudComputerClaimSupersededError) return;
      if (error instanceof ManagedHomeError && error.permanent) {
        this.#onError(error);
        await this.#store.failClaim(
          job,
          "Your Cloud Computer couldn’t be set up for your Account. Contact support.",
        );
        return;
      }
      if (!(error instanceof ManagedHomeError)) this.#onError(error);
      if (this.#now() - job.readinessStartedAt.getTime() > cloudComputerClaimDeadlineMilliseconds)
        await this.#store.failClaim(
          job,
          "Your Cloud Computer took too long to set up. Contact support.",
        );
      else await this.#store.deferClaim(job, this.#retryAt(job));
    }
  }

  async #claim(job: CloudComputerClaimJob): Promise<void> {
    const origin = `https://${job.hostname}`;
    const material = await this.#store.claimMaterial(job);
    const credentialDigest = createHash("sha256")
      .update(material.hostCredential, "utf8")
      .digest("base64url");
    const { envelope, receipt } = await this.#home.claim(origin, async (envelope) => {
      const document = envelope.document;
      // Both a new Home and a restored owner use the identity pinned at boot-complete.
      if (
        document.canonicalOrigin !== origin ||
        document.deploymentId !== job.deploymentId ||
        hostKeyFingerprint(envelope.publicKey.spki) !== job.hostKeyFingerprint
      )
        throw new ManagedHomeError("The Cloud Computer answered as a different Home", {
          permanent: true,
        });
      const issuedAt = Math.floor(this.#now() / 1_000);
      const assertion = await this.#sign(
        ManagedHomeClaimClaimsSchema.parse({
          tokenUse: "opensteer-managed-home-claim",
          iss: this.#issuer,
          aud: origin,
          sub: job.accountId,
          iat: issuedAt,
          exp: issuedAt + 120,
          jti: `mhc_${crypto.randomUUID()}`,
          authority: {
            canonicalOrigin: origin,
            deploymentId: job.deploymentId,
            hostInstanceId: document.hostInstanceId,
            hostKeyFingerprint: job.hostKeyFingerprint,
          },
          claim: { cloudComputerId: job.id, generation: job.generation },
          owner: material.owner,
          ...(material.work ? { work: material.work } : {}),
          link: { generation: material.linkGeneration, hostCredentialSha256: credentialDigest },
        }),
      );
      return {
        schemaVersion: 1,
        setupCode: material.setupCode,
        assertion,
        hostCredential: material.hostCredential,
      };
    });
    const document = envelope.document;
    const answered = receipt.document;
    if (
      receipt.publicKey.spki !== envelope.publicKey.spki ||
      !verify(
        null,
        managedHomeClaimReceiptSigningBytes(answered),
        createPublicKey({
          key: Buffer.from(receipt.publicKey.spki, "base64url"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(receipt.signature, "base64url"),
      ) ||
      answered.account.issuer !== this.#issuer ||
      answered.account.subject !== job.accountId ||
      answered.authority.canonicalOrigin !== origin ||
      answered.authority.deploymentId !== job.deploymentId ||
      answered.authority.hostInstanceId !== document.hostInstanceId ||
      answered.authority.hostKeyFingerprint !== job.hostKeyFingerprint ||
      answered.claim.cloudComputerId !== job.id ||
      answered.claim.generation !== job.generation ||
      answered.work?.organizationId !== material.work?.organizationId ||
      answered.work?.organizationName !== material.work?.organizationName ||
      answered.work?.assignmentId !== material.work?.assignmentId ||
      answered.linkGeneration !== material.linkGeneration ||
      answered.hostCredentialSha256 !== credentialDigest
    )
      throw new ManagedHomeError("The Cloud Computer answered for a different claim", {
        permanent: true,
      });
    await this.#store.recordClaim(job, receipt, envelope);
  }

  #retryAt(job: CloudComputerClaimJob): Date {
    return new Date(this.#now() + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempt, 6)));
  }
}

/** 4xx other than rate limiting is the Home refusing this claim for good. */
function homeAnswered(status: number): ManagedHomeError {
  return new ManagedHomeError(`The Cloud Computer refused the claim (HTTP ${status})`, {
    permanent: status >= 400 && status < 500 && status !== 408 && status !== 429,
  });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}
