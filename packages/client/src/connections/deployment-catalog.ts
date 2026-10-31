import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { readBoundedText } from "@opensteer/shared/boundedJson";
import {
  AccountDeploymentDirectoryEntrySchema,
  ControlPlaneAccountIdSchema,
  type AccountDeploymentDirectoryEntry,
} from "@opensteer/control-plane-protocol";
import {
  HostDiscoveryDocumentSchema,
  HostDiscoveryEnvelopeSchema,
  HostBootstrapMethodSchema,
  HostDescriptorSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  hostKeyFingerprint,
  isPersonalHost,
  isSameHost,
  sameDiscoveryDocument,
  hostApiCompatibility,
  hostAuthorityIdentityMatches,
  knownHostCapabilities,
  verifyHostDiscoveryEnvelope,
  verifyPersonalHostAccessRouteEnvelope,
  type HostDiscoveryDocument,
  type HostDiscoveryEnvelope,
  type HostApiCompatibility,
  type HostBootstrapMethod,
  type HostCapability,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import {
  CanonicalOriginSchema,
  DeploymentIdSchema,
  DeploymentDisplayKindSchema,
  IsoDateTimeSchema,
  type DeploymentId,
  type DeploymentDisplayKind,
} from "@opensteer/core";
import { DesktopAccessOriginSchema, type DesktopAccessOrigin } from "@opensteer/protocol/desktop";
import { z } from "zod";
import { ClientOperationError, clientTimeoutError, unrefTimer } from "./operation-error.js";
import type { PrivateFilesystem } from "./private-filesystem.js";

export const maxDeploymentCatalogBytes = 1 * 1_024 * 1_024;
export const maxHostDiscoveryDocumentBytes = 64 * 1_024;

const maxDeployments = 100;
const defaultDiscoveryTimeoutMs = 10_000;
const maximumDiscoveryTimeoutMs = 30_000;
const boundedName = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value === value.trim(), "Deployment names must not have outer whitespace");

export const DeploymentConnectionSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    issuer: CanonicalOriginSchema,
    kind: z.literal("account"),
    subject: ControlPlaneAccountIdSchema,
  }),
  z.strictObject({ kind: z.literal("manual") }),
]);
export type DeploymentConnectionSource = z.infer<typeof DeploymentConnectionSourceSchema>;
export type AccountDeploymentConnectionSource = Extract<
  DeploymentConnectionSource,
  { readonly kind: "account" }
>;

/**
 * A stored origin is already normalized. Public origins require HTTPS; plain
 * HTTP is accepted only when it cannot leave the current machine.
 */
export const ConnectionOriginSchema = DesktopAccessOriginSchema;
export type ConnectionOrigin = DesktopAccessOrigin;

export const VerifiedCanonicalEndpointSchema = z.strictObject({
  kind: z.literal("canonical"),
  origin: ConnectionOriginSchema,
  verifiedAt: IsoDateTimeSchema,
});
export const VerifiedDirectEndpointSchema = z.strictObject({
  kind: z.literal("direct"),
  origin: ConnectionOriginSchema,
  verifiedAt: IsoDateTimeSchema,
});
export const VerifiedAccessEndpointSchema = z.discriminatedUnion("kind", [
  VerifiedCanonicalEndpointSchema,
  VerifiedDirectEndpointSchema,
]);
export type VerifiedAccessEndpoint = z.infer<typeof VerifiedAccessEndpointSchema>;

const CanonicalAddressesSchema = {
  endpoints: z.tuple([VerifiedCanonicalEndpointSchema]).rest(VerifiedDirectEndpointSchema),
  preferredEndpointOrigin: ConnectionOriginSchema.nullable().optional(),
  reachability: z.literal("canonical"),
};
const RoutedAddressesSchema = {
  accountLivenessExpiresAt: IsoDateTimeSchema.nullable().optional(),
  endpoints: z.union([
    z.tuple([VerifiedCanonicalEndpointSchema]),
    z.tuple([VerifiedDirectEndpointSchema]),
  ]),
  personalAccessRoute: PersonalHostAccessRouteEnvelopeSchema.nullable().default(null),
  preferredEndpointOrigin: ConnectionOriginSchema.nullable().optional(),
  reachability: z.literal("routed"),
};
/**
 * This Account's relation to a listed Deployment, which is what decides whether
 * dropping the Account listing is this person's move at all: an owner removes
 * the Deployment from the computer that runs it, so the Account refuses to hide
 * it. Deliberately not called `access` — that word is live routing everywhere
 * else in the Desktop connection stack.
 */
export const AccountAccessSchema = z.enum(["owner", "member"]);
export type AccountAccess = z.infer<typeof AccountAccessSchema>;

const deploymentConnectionInputCommon = {
  accountAccess: AccountAccessSchema.nullable(),
  /**
   * The signed envelope, not the bare document: the document alone carries no
   * key material, so the Host key a stored entry is pinned to — and therefore
   * `isSameHost`, owner matching, and the attachment key — would be
   * uncomputable offline without it.
   */
  authority: HostDiscoveryEnvelopeSchema,
  bootstrapMethods: z.array(HostBootstrapMethodSchema).max(4),
  /** Cached optional features can outlive the release that recognized them. */
  capabilities: z
    .array(z.string().min(1).max(64))
    .max(32)
    .transform((names) => [...knownHostCapabilities(names)])
    .nullable()
    .optional(),
  kind: DeploymentDisplayKindSchema,
  name: boundedName,
  source: DeploymentConnectionSourceSchema,
};

export const DeploymentConnectionInputSchema = z
  .discriminatedUnion("reachability", [
    z.strictObject({
      ...deploymentConnectionInputCommon,
      ...CanonicalAddressesSchema,
    }),
    z.strictObject({
      ...deploymentConnectionInputCommon,
      ...RoutedAddressesSchema,
    }),
  ])
  .superRefine((deployment, context) => {
    addConnectionRouteIssues(deployment, (issue) => context.addIssue({ code: "custom", ...issue }));
  });
export type DeploymentConnectionInput = z.output<typeof DeploymentConnectionInputSchema>;

export const DeploymentConnectionSchema = z
  .discriminatedUnion("reachability", [
    z.strictObject({
      ...deploymentConnectionInputCommon,
      ...CanonicalAddressesSchema,
      // Defaulted, not required, because a catalog written before the Desktop
      // recorded the Account relation still has to load.
      accountAccess: AccountAccessSchema.nullable().default(null),
      createdAt: IsoDateTimeSchema,
      lastUsedAt: IsoDateTimeSchema.nullable(),
      preferredEndpointOrigin: ConnectionOriginSchema.nullable().default(null),
      updatedAt: IsoDateTimeSchema,
    }),
    z.strictObject({
      ...deploymentConnectionInputCommon,
      ...RoutedAddressesSchema,
      accountAccess: AccountAccessSchema.nullable().default(null),
      accountLivenessExpiresAt: IsoDateTimeSchema.nullable().default(null),
      createdAt: IsoDateTimeSchema,
      lastUsedAt: IsoDateTimeSchema.nullable(),
      preferredEndpointOrigin: ConnectionOriginSchema.nullable().default(null),
      updatedAt: IsoDateTimeSchema,
    }),
  ])
  .superRefine((deployment, context) => {
    addConnectionRouteIssues(deployment, (issue) => context.addIssue({ code: "custom", ...issue }));
    if (Date.parse(deployment.updatedAt) < Date.parse(deployment.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "Deployment updatedAt cannot precede createdAt",
        path: ["updatedAt"],
      });
    }
    if (
      deployment.lastUsedAt !== null &&
      Date.parse(deployment.lastUsedAt) < Date.parse(deployment.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Deployment lastUsedAt cannot precede createdAt",
        path: ["lastUsedAt"],
      });
    }
    if (
      deployment.lastUsedAt !== null &&
      Date.parse(deployment.updatedAt) < Date.parse(deployment.lastUsedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Deployment updatedAt cannot precede lastUsedAt",
        path: ["updatedAt"],
      });
    }
  });
export type DeploymentConnection = z.infer<typeof DeploymentConnectionSchema>;

export interface VerifiedHostEndpoint {
  readonly bootstrapMethods: readonly HostBootstrapMethod[];
  /**
   * The optional features this Host advertised, narrowed to the names this
   * tree knows. It is carried, never required: an epoch match already
   * guarantees every mandatory meaning; optional features may be gated on these.
   */
  readonly capabilities: readonly HostCapability[];
  readonly discovery: HostDiscoveryDocument;
  readonly discoveryEnvelope: HostDiscoveryEnvelope;
  readonly endpoint: VerifiedAccessEndpoint;
}

export interface VerifiedPersonalHostEndpoint extends VerifiedHostEndpoint {
  readonly accessRoute: PersonalHostAccessRouteEnvelope;
}

/**
 * The two sides of one protocol epoch mismatch, as the verification
 * vocabulary names them: either this Host predates what the app speaks, or the
 * app predates what the Host speaks. Blocked rather than transient — the next
 * attempt reaches the same two versions.
 */
export class HostVersionMismatchError extends ClientOperationError {
  readonly code: Exclude<HostApiCompatibility, "compatible">;

  constructor(code: Exclude<HostApiCompatibility, "compatible">) {
    super(
      code === "host-too-old"
        ? "This deployment speaks an older Opensteer protocol than this app."
        : "This deployment speaks a newer Opensteer protocol than this app.",
      "blocked",
    );
    this.name = "HostVersionMismatchError";
    this.code = code;
  }
}

interface VerifyAccessEndpointOptions {
  readonly expectedDeploymentId?: DeploymentId | string;
  readonly expectedDiscovery?: HostDiscoveryDocument;
  readonly expectedHostKeyFingerprint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly kind: "canonical" | "direct";
  readonly now?: () => Date;
  readonly origin: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Verify the signed authority metadata returned through one HTTPS route before
 * that route enters the local catalog. The signature prevents metadata
 * forgery; the HTTPS/LAN/VPN route remains the transport trust boundary because
 * a live reverse proxy can replay a current signed document. This request is
 * bounded and sends no credential, cookie, or ambient referrer.
 */
export async function verifyAccessEndpoint(
  options: VerifyAccessEndpointOptions,
): Promise<VerifiedHostEndpoint> {
  const origin = ConnectionOriginSchema.parse(options.origin);
  const kind = z.enum(["canonical", "direct"]).parse(options.kind);
  const expectedDiscovery = options.expectedDiscovery
    ? HostDiscoveryDocumentSchema.parse(options.expectedDiscovery)
    : undefined;
  const timeoutMs = boundedTimeout(options.timeoutMs ?? defaultDiscoveryTimeoutMs);
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const discoveryUrl = new URL("/.well-known/opensteer", origin).toString();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(clientTimeoutError("Host discovery timed out.")),
    timeoutMs,
  );
  unrefTimer(timeout);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetchFn(discoveryUrl, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (response.redirected || (response.url !== "" && response.url !== discoveryUrl)) {
      throw new Error("Host discovery must not redirect.");
    }
    if (!response.ok) {
      throw new Error(`Host discovery returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") {
      throw new Error("Host discovery did not return application/json.");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) {
        throw new Error("Host discovery returned an invalid content length.");
      }
      if (Number(contentLength) > maxHostDiscoveryDocumentBytes) {
        throw new Error("Host discovery document exceeds its size limit.");
      }
    }
    const serialized = await readBoundedText(response, {
      fatalUtf8: true,
      maximumBytes: maxHostDiscoveryDocumentBytes,
      sizeError: () => new Error("Host discovery document exceeds its size limit."),
    });
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch (error) {
      throw new Error("Host discovery document is not valid JSON.", { cause: error });
    }
    // The first question asked of the answer, before the descriptor is parsed
    // and before any identity check: everything below — and every credential
    // exchange a caller runs afterwards — assumes both ends agree on what the
    // exchange means. It reads the raw document because a Host from before
    // negotiation serves no epoch at all, and "that deployment is too old" is
    // a more useful answer than a failed parse.
    const compatibility = hostApiCompatibility(decoded);
    if (compatibility !== "compatible") throw new HostVersionMismatchError(compatibility);
    const descriptor = HostDescriptorSchema.parse(decoded);
    const discoveryEnvelope = descriptor.authority;
    const discovery = verifyHostDiscoveryEnvelope(discoveryEnvelope);
    ConnectionOriginSchema.parse(discovery.canonicalOrigin);
    if (kind === "canonical" && origin !== discovery.canonicalOrigin) {
      throw new Error("Canonical access endpoint does not match the Host canonical origin.");
    }
    if (
      options.expectedDeploymentId !== undefined &&
      discovery.deploymentId !== DeploymentIdSchema.parse(options.expectedDeploymentId)
    ) {
      throw new Error("Access endpoint belongs to another Deployment.");
    }
    if (expectedDiscovery && !sameDiscoveryDocument(discovery, expectedDiscovery)) {
      throw new Error("Access endpoint Host identity does not match the expected Deployment Host.");
    }
    if (
      options.expectedHostKeyFingerprint !== undefined &&
      hostKeyFingerprint(discoveryEnvelope.publicKey.spki) !== options.expectedHostKeyFingerprint
    ) {
      throw new Error("Access endpoint Host key does not match the expected Deployment Host.");
    }
    return {
      bootstrapMethods: descriptor.bootstrapMethods,
      capabilities: knownHostCapabilities(descriptor.capabilities),
      discovery,
      discoveryEnvelope,
      endpoint: VerifiedAccessEndpointSchema.parse({
        kind,
        origin,
        verifiedAt: (options.now ?? (() => new Date()))().toISOString(),
      }),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Host discovery was cancelled.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function verifyPersonalAccessEndpoint(options: {
  readonly expectedDeploymentId?: DeploymentId | string;
  readonly expectedDiscovery?: HostDiscoveryDocument;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly origin: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<VerifiedPersonalHostEndpoint> {
  const origin = ConnectionOriginSchema.parse(options.origin);
  if (new URL(origin).protocol !== "https:") {
    throw new Error("A Personal remote route must use HTTPS.");
  }
  const timeoutMs = boundedTimeout(options.timeoutMs ?? defaultDiscoveryTimeoutMs);
  const endpoint = new URL("/.well-known/opensteer/personal-access-route", origin).toString();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(clientTimeoutError("Personal access-route verification timed out.")),
    timeoutMs,
  );
  unrefTimer(timeout);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(endpoint, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
      throw new Error("Personal access-route verification must not redirect.");
    }
    if (!response.ok) {
      throw new Error(`Personal access-route verification returned HTTP ${response.status}.`);
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      throw new Error("Personal access-route verification did not return application/json.");
    }
    const decoded = JSON.parse(
      await readBoundedText(response, {
        fatalUtf8: true,
        maximumBytes: maxHostDiscoveryDocumentBytes,
        sizeError: () => new Error("Host discovery document exceeds its size limit."),
      }),
    ) as unknown;
    const accessRoute = verifyPersonalHostAccessRouteEnvelope(
      PersonalHostAccessRouteEnvelopeSchema.parse(decoded),
    );
    if (accessRoute.document.route.origin !== origin) {
      throw new Error(
        "Personal access-route attestation does not match the requested HTTPS route.",
      );
    }
    const discovery = HostDiscoveryDocumentSchema.parse(accessRoute.document.authority);
    if (
      options.expectedDeploymentId !== undefined &&
      discovery.deploymentId !== DeploymentIdSchema.parse(options.expectedDeploymentId)
    ) {
      throw new Error("Personal access route belongs to another Deployment.");
    }
    if (
      options.expectedDiscovery &&
      !sameDiscoveryDocument(
        discovery,
        HostDiscoveryDocumentSchema.parse(options.expectedDiscovery),
      )
    ) {
      throw new Error("Personal access route does not match the expected Host authority.");
    }
    const descriptor = await verifyAccessEndpoint({
      ...(options.expectedDeploymentId === undefined
        ? {}
        : { expectedDeploymentId: options.expectedDeploymentId }),
      expectedDiscovery: discovery,
      expectedHostKeyFingerprint: hostKeyFingerprint(accessRoute.publicKey.spki),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      kind: "direct",
      ...(options.now === undefined ? {} : { now: options.now }),
      origin,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (descriptor.discoveryEnvelope.publicKey.spki !== accessRoute.publicKey.spki) {
      throw new Error("Personal access route and Host discovery use different signing keys.");
    }
    return {
      accessRoute,
      bootstrapMethods: descriptor.bootstrapMethods,
      capabilities: descriptor.capabilities,
      discovery,
      discoveryEnvelope: descriptor.discoveryEnvelope,
      endpoint: VerifiedAccessEndpointSchema.parse({
        kind: "direct",
        origin,
        verifiedAt: (options.now ?? (() => new Date()))().toISOString(),
      }),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Personal access-route verification was cancelled.", { cause: error });
    }
    if (error instanceof SyntaxError) {
      throw new Error("Personal access-route verification returned invalid JSON.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function deploymentConnectionFromVerifiedEndpoints(input: {
  readonly accountAccess: AccountAccess | null;
  readonly accountLivenessExpiresAt?: string | null;
  readonly endpoints: readonly VerifiedHostEndpoint[];
  readonly kind: DeploymentDisplayKind;
  readonly name: string;
  readonly source: DeploymentConnectionSource;
}): DeploymentConnectionInput {
  const canonical = input.endpoints.find(({ endpoint }) => endpoint.kind === "canonical");
  if (!canonical) throw new Error("A verified canonical Deployment endpoint is required.");
  for (const verified of input.endpoints) {
    if (
      !isSameHost(verified.discoveryEnvelope, canonical.discoveryEnvelope) ||
      !sameDiscoveryDocument(verified.discovery, canonical.discovery)
    ) {
      throw new Error("Verified access endpoints do not resolve to the same Deployment Host.");
    }
  }
  return DeploymentConnectionInputSchema.parse({
    ...(input.accountLivenessExpiresAt === undefined
      ? {}
      : { accountLivenessExpiresAt: input.accountLivenessExpiresAt }),
    accountAccess: input.accountAccess,
    authority: canonical.discoveryEnvelope,
    bootstrapMethods: canonical.bootstrapMethods,
    capabilities: canonical.capabilities,
    endpoints: input.endpoints.map(({ endpoint }) => endpoint),
    kind: input.kind,
    name: input.name,
    reachability: "canonical",
    source: input.source,
  });
}

export function deploymentConnectionFromVerifiedPersonalRoute(input: {
  readonly accountAccess: AccountAccess | null;
  readonly accountLivenessExpiresAt?: string | null;
  readonly name: string;
  readonly source: DeploymentConnectionSource;
  readonly verified: VerifiedPersonalHostEndpoint;
}): DeploymentConnectionInput {
  const verified = {
    accessRoute: verifyPersonalHostAccessRouteEnvelope(input.verified.accessRoute),
    authority: HostDiscoveryEnvelopeSchema.parse(input.verified.discoveryEnvelope),
    bootstrapMethods: input.verified.bootstrapMethods,
    capabilities: input.verified.capabilities,
    endpoint: VerifiedAccessEndpointSchema.parse(input.verified.endpoint),
  };
  if (verified.endpoint.kind !== "direct") {
    throw new Error("A Personal remote connection requires a direct HTTPS route.");
  }
  return DeploymentConnectionInputSchema.parse({
    ...(input.accountLivenessExpiresAt === undefined
      ? {}
      : { accountLivenessExpiresAt: input.accountLivenessExpiresAt }),
    accountAccess: input.accountAccess,
    authority: verified.authority,
    bootstrapMethods: verified.bootstrapMethods,
    capabilities: verified.capabilities,
    endpoints: [verified.endpoint],
    kind: "personal",
    name: input.name,
    personalAccessRoute: verified.accessRoute,
    preferredEndpointOrigin: verified.endpoint.origin,
    reachability: "routed",
    source: input.source,
  });
}

const deploymentCatalogFields = {
  deployments: z.array(DeploymentConnectionSchema).max(maxDeployments),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  selectedDeploymentId: DeploymentIdSchema.nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
};

/**
 * Bumped whenever the shape below changes: this file is a rebuildable routing
 * cache, so another version is discarded empty rather than migrated.
 */
const deploymentCatalogSchemaVersion = 4;

/** Stored exactly as it is held in memory — there is no second shape on disk. */
export const DeploymentCatalogSchema = z
  .strictObject({
    ...deploymentCatalogFields,
    schemaVersion: z.literal(deploymentCatalogSchemaVersion),
  })
  .superRefine(refineDeploymentCatalog);
export type DeploymentCatalog = z.infer<typeof DeploymentCatalogSchema>;

function refineDeploymentCatalog(
  catalog: {
    readonly deployments: readonly DeploymentConnection[];
    readonly revision: number;
    readonly selectedDeploymentId: DeploymentId | null;
    readonly updatedAt: string | null;
  },
  context: z.RefinementCtx,
): void {
  const ids = new Set<DeploymentId>();
  for (const [index, deployment] of catalog.deployments.entries()) {
    const deploymentId = deployment.authority.document.deploymentId;
    if (ids.has(deploymentId)) {
      context.addIssue({
        code: "custom",
        message: "A Deployment may appear in the connection catalog only once",
        path: ["deployments", index, "discovery", "deploymentId"],
      });
    }
    ids.add(deploymentId);
  }
  if (catalog.deployments.length === 0 && catalog.selectedDeploymentId !== null) {
    context.addIssue({
      code: "custom",
      message: "An empty connection catalog cannot have a selected Deployment",
      path: ["selectedDeploymentId"],
    });
  }
  if (catalog.deployments.length > 0 && catalog.selectedDeploymentId === null) {
    context.addIssue({
      code: "custom",
      message: "A non-empty connection catalog must have a selected Deployment",
      path: ["selectedDeploymentId"],
    });
  }
  if (catalog.selectedDeploymentId !== null && !ids.has(catalog.selectedDeploymentId)) {
    context.addIssue({
      code: "custom",
      message: "The selected Deployment is not present in the connection catalog",
      path: ["selectedDeploymentId"],
    });
  }
  if (catalog.revision === 0 && (catalog.deployments.length > 0 || catalog.updatedAt !== null)) {
    context.addIssue({
      code: "custom",
      message: "An unmodified connection catalog must be empty",
      path: ["revision"],
    });
  }
  if (catalog.revision > 0 && catalog.updatedAt === null) {
    context.addIssue({
      code: "custom",
      message: "A modified connection catalog must record its update time",
      path: ["updatedAt"],
    });
  }
  const catalogUpdatedAt = catalog.updatedAt;
  if (
    catalogUpdatedAt !== null &&
    catalog.deployments.some(
      (deployment) => Date.parse(deployment.updatedAt) > Date.parse(catalogUpdatedAt),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Catalog updatedAt cannot precede a Deployment update",
      path: ["updatedAt"],
    });
  }
}

export interface LocalPersonalManifestAuthority {
  readonly deploymentId: DeploymentId;
  readonly hostInstanceId: string;
  readonly hostKeyFingerprint: string | null;
  readonly hostPort: number;
}

interface DeploymentCatalogStoreOptions {
  /** Where this application keeps the file, resolved by the application. */
  readonly filePath: string;
  readonly localPersonalManifest?: {
    load(): Promise<LocalPersonalManifestAuthority | null>;
  };
  readonly now?: () => Date;
  readonly privateFiles: PrivateFilesystem;
}

/** Rebuildable device-local routing cache: older schema versions reset empty.
 * Credentials, tunnel tokens, Host private keys, and database passwords never
 * belong in this file. */
export class DeploymentCatalogStore {
  readonly #filePath: string;
  readonly #localPersonalManifest:
    { load(): Promise<LocalPersonalManifestAuthority | null> } | undefined;
  readonly #now: () => Date;
  readonly #privateFiles: PrivateFilesystem;
  readonly #mutations = new MutationQueue();
  readonly #listeners = new Set<() => void>();

  constructor(options: DeploymentCatalogStoreOptions) {
    this.#filePath = options.filePath;
    this.#localPersonalManifest = options.localPersonalManifest;
    this.#now = options.now ?? (() => new Date());
    this.#privateFiles = options.privateFiles;
  }

  get filePath(): string {
    return this.#filePath;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async load(): Promise<DeploymentCatalog> {
    const stored = await this.#privateFiles.readFile(this.#filePath, maxDeploymentCatalogBytes);
    if (stored === null) return emptyDeploymentCatalog();
    const serialized = new TextDecoder().decode(stored);
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch (error) {
      throw new Error("The deployment connection catalog on this computer is not valid JSON.", {
        cause: error,
      });
    }
    // A catalog stamped with another release's schema is that release's to
    // read; this one starts empty beside it and never rewrites the file.
    if (!isCurrentStoredCatalogVersion(decoded)) return emptyDeploymentCatalog();
    try {
      return DeploymentCatalogSchema.parse(decoded);
    } catch (error) {
      // A catalog this release claims to understand but cannot read is a fault,
      // not an empty catalog. Reporting it keeps a single bad byte from
      // silently discarding every pairing this Desktop still holds keys for.
      throw new Error(
        "The deployment connection catalog on this computer is incompatible or corrupt.",
        { cause: error },
      );
    }
  }

  upsert(deployment: DeploymentConnectionInput): Promise<DeploymentCatalog> {
    const parsed = DeploymentConnectionInputSchema.parse(deployment);
    return this.#mutate((catalog, now) => {
      const deploymentId = parsed.authority.document.deploymentId;
      const existingIndex = catalog.deployments.findIndex(
        ({ authority }) => authority.document.deploymentId === deploymentId,
      );
      const deployments = [...catalog.deployments];
      const existing = existingIndex === -1 ? undefined : deployments[existingIndex];
      if (existing?.source.kind === "manual" && !sameConnectionHost(existing, parsed)) {
        throw new Error("A manual Deployment Host changed and must be re-added.");
      }
      const next = DeploymentConnectionSchema.parse({
        ...parsed,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: existing?.lastUsedAt ?? null,
        updatedAt: latestIsoDateTime(now, existing?.lastUsedAt),
      });
      if (existingIndex === -1) deployments.push(next);
      else deployments[existingIndex] = next;
      return {
        ...catalog,
        deployments,
        selectedDeploymentId: catalog.selectedDeploymentId ?? deploymentId,
        updatedAt: now,
      };
    });
  }

  /** Commit a newly verified local authority and make it active in one durable write. */
  upsertAndSelect(deployment: DeploymentConnectionInput): Promise<DeploymentCatalog> {
    const parsed = DeploymentConnectionInputSchema.parse(deployment);
    return this.#mutate((catalog, now) => {
      const deploymentId = parsed.authority.document.deploymentId;
      const existingIndex = catalog.deployments.findIndex(
        ({ authority }) => authority.document.deploymentId === deploymentId,
      );
      const deployments = [...catalog.deployments];
      const existing = existingIndex === -1 ? undefined : deployments[existingIndex];
      if (existing?.source.kind === "manual" && !sameConnectionHost(existing, parsed)) {
        throw new Error("A manual Deployment Host changed and must be re-added.");
      }
      const next = DeploymentConnectionSchema.parse({
        ...parsed,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
        updatedAt: latestIsoDateTime(now, existing?.lastUsedAt),
      });
      if (existingIndex === -1) deployments.push(next);
      else deployments[existingIndex] = next;
      return {
        ...catalog,
        deployments,
        selectedDeploymentId: deploymentId,
        updatedAt: now,
      };
    });
  }

  addVerifiedDirectEndpoint(input: {
    readonly deploymentId: DeploymentId | string;
    readonly verified: VerifiedHostEndpoint;
  }): Promise<DeploymentCatalog> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    const discovery = HostDiscoveryDocumentSchema.parse(input.verified.discovery);
    const endpoint = VerifiedAccessEndpointSchema.parse(input.verified.endpoint);
    if (endpoint.kind !== "direct") {
      throw new Error("Only a verified direct endpoint can be added through this operation.");
    }
    return this.#mutate((catalog, now) => {
      const index = catalog.deployments.findIndex(
        (deployment) => deployment.authority.document.deploymentId === deploymentId,
      );
      const existing = index === -1 ? undefined : catalog.deployments[index];
      if (!existing) throw new Error("Cannot add a route to an unknown Deployment.");
      if (!sameDiscoveryDocument(existing.authority.document, discovery)) {
        throw new Error(
          "The direct endpoint does not resolve to the selected Deployment authority.",
        );
      }
      const endpoints = existing.endpoints.filter(
        (candidate) => candidate.origin !== endpoint.origin,
      );
      endpoints.push(endpoint);
      const deployments = [...catalog.deployments];
      deployments[index] = DeploymentConnectionSchema.parse({
        ...existing,
        bootstrapMethods: input.verified.bootstrapMethods,
        capabilities: input.verified.capabilities,
        endpoints,
        preferredEndpointOrigin: endpoint.origin,
        source: { kind: "manual" },
        updatedAt: latestIsoDateTime(now, existing.lastUsedAt),
      });
      return { ...catalog, deployments, updatedAt: now };
    });
  }

  /** A fresh descriptor updates only the same Host and route, never a replacement attachment. */
  recordVerifiedCapabilities(verified: VerifiedHostEndpoint): Promise<DeploymentCatalog> {
    return this.#mutate((catalog, now) => {
      const deployments = catalog.deployments.map((connection) => {
        if (
          !isSameHost(connection.authority, verified.discoveryEnvelope) ||
          !connection.endpoints.some(({ origin }) => origin === verified.endpoint.origin)
        )
          return connection;
        return {
          ...connection,
          capabilities: [...verified.capabilities],
          updatedAt: latestIsoDateTime(now, connection.lastUsedAt),
        };
      });
      return { ...catalog, deployments, updatedAt: now };
    });
  }

  setPreferredEndpoint(input: {
    readonly deploymentId: DeploymentId | string;
    readonly origin: ConnectionOrigin | string | null;
  }): Promise<DeploymentCatalog> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    const origin = input.origin === null ? null : ConnectionOriginSchema.parse(input.origin);
    return this.#mutate((catalog, now) => {
      const index = catalog.deployments.findIndex(
        (deployment) => deployment.authority.document.deploymentId === deploymentId,
      );
      const existing = index === -1 ? undefined : catalog.deployments[index];
      if (!existing) throw new Error("Cannot select a route for an unknown Deployment.");
      if (
        origin !== null &&
        !existing.endpoints.some(
          (endpoint) => endpoint.kind === "direct" && endpoint.origin === origin,
        )
      ) {
        throw new Error("The preferred route must be a verified direct endpoint.");
      }
      if (existing.preferredEndpointOrigin === origin) return null;
      const deployments = [...catalog.deployments];
      deployments[index] = DeploymentConnectionSchema.parse({
        ...existing,
        preferredEndpointOrigin: origin,
        updatedAt: latestIsoDateTime(now, existing.lastUsedAt),
      });
      return { ...catalog, deployments, updatedAt: now };
    });
  }

  /** Replaces one Account subject's complete remote-cache projection. */
  async reconcileAccountDeployments(input: {
    readonly connections: readonly DeploymentConnectionInput[];
    readonly directoryDeployments: readonly AccountDeploymentDirectoryEntry[];
    readonly source: AccountDeploymentConnectionSource;
  }): Promise<DeploymentCatalog> {
    const source = DeploymentConnectionSourceSchema.parse(input.source);
    if (source.kind !== "account")
      throw new Error("Account reconciliation requires an Account source.");
    const directoryDeployments = input.directoryDeployments.map((deployment) =>
      AccountDeploymentDirectoryEntrySchema.parse(deployment),
    );
    const directoryById = new Map(
      directoryDeployments.map((deployment) => [deployment.id, deployment] as const),
    );
    if (directoryById.size !== directoryDeployments.length) {
      throw new Error("The Account Deployment directory contains duplicate identities.");
    }
    const accountIds = new Set(directoryById.keys());
    const connections = input.connections.map((connection) =>
      DeploymentConnectionInputSchema.parse(connection),
    );
    const connectionIds = new Set<DeploymentId>();
    for (const connection of connections) {
      const deploymentId = connection.authority.document.deploymentId;
      if (!sameConnectionSource(connection.source, source)) {
        throw new Error("A verified Account Host has the wrong Account source.");
      }
      if (!accountIds.has(deploymentId)) {
        throw new Error("A verified Account Host is absent from the Account directory.");
      }
      if (connectionIds.has(deploymentId)) {
        throw new Error("The Account Deployment routes contain duplicate identities.");
      }
      connectionIds.add(deploymentId);
    }
    const localManifest = (await this.#localPersonalManifest?.load()) ?? null;
    return this.#mutate((catalog, now) => {
      const previousById = new Map(
        catalog.deployments.map(
          (deployment) => [deployment.authority.document.deploymentId, deployment] as const,
        ),
      );
      const retained = catalog.deployments.filter((stored) => {
        if (stored.source.kind === "manual") return true;
        if (localManifest?.deploymentId === stored.authority.document.deploymentId) return true;
        if (!sameConnectionSource(stored.source, source)) return false;
        const directory = directoryById.get(stored.authority.document.deploymentId);
        return Boolean(
          directory &&
          directory.lifecycle === "active" &&
          hostAuthorityIdentityMatches(
            stored.authority.document,
            hostKeyFingerprint(stored.authority.publicKey.spki),
            directory.authority,
          ),
        );
      });
      const byId = new Map(
        retained.map(
          (deployment, index) => [deployment.authority.document.deploymentId, index] as const,
        ),
      );
      for (const connection of connections) {
        const deploymentId = connection.authority.document.deploymentId;
        const existingIndex = byId.get(deploymentId);
        const previous = previousById.get(deploymentId);
        if (localManifest?.deploymentId === deploymentId) {
          if (
            existingIndex !== undefined &&
            previous &&
            sameDiscoveryDocument(previous.authority.document, connection.authority.document) &&
            previous.name !== connection.name
          ) {
            retained[existingIndex] = DeploymentConnectionSchema.parse({
              ...previous,
              name: connection.name,
              updatedAt: latestIsoDateTime(now, previous.lastUsedAt),
            });
          }
          continue;
        }
        if (previous?.source.kind === "manual") {
          continue;
        }
        const candidate = connection;
        if (
          previous &&
          existingIndex !== undefined &&
          sameConnectionDefinition(previous, candidate)
        ) {
          continue;
        }
        const next = DeploymentConnectionSchema.parse({
          ...candidate,
          createdAt: previous?.createdAt ?? now,
          lastUsedAt: previous?.lastUsedAt ?? null,
          updatedAt: latestIsoDateTime(now, previous?.lastUsedAt),
        });
        if (existingIndex === undefined) {
          byId.set(deploymentId, retained.length);
          retained.push(next);
        } else {
          retained[existingIndex] = next;
        }
      }
      // The Account relation is directory truth, and it is the only thing that
      // decides whether this computer may drop a listing — so it is refreshed
      // on every row this Account sourced, including the ones no route could be
      // verified for this round and the locally supervised one.
      for (const [index, stored] of retained.entries()) {
        if (!sameConnectionSource(stored.source, source)) continue;
        const directory = directoryById.get(stored.authority.document.deploymentId);
        if (!directory || directory.access === stored.accountAccess) continue;
        retained[index] = DeploymentConnectionSchema.parse({
          ...stored,
          accountAccess: directory.access,
          updatedAt: latestIsoDateTime(now, stored.lastUsedAt),
        });
      }
      const selectedDeploymentId =
        catalog.selectedDeploymentId !== null &&
        retained.some(
          ({ authority }) => authority.document.deploymentId === catalog.selectedDeploymentId,
        )
          ? catalog.selectedDeploymentId
          : (mostRecentlyUsed(retained)?.authority.document.deploymentId ?? null);
      if (
        selectedDeploymentId === catalog.selectedDeploymentId &&
        sameStoredConnections(retained, catalog.deployments)
      ) {
        return null;
      }
      return {
        ...catalog,
        deployments: retained,
        selectedDeploymentId,
        updatedAt: now,
      };
    });
  }

  removeAccountDeployments(
    sourceInput: AccountDeploymentConnectionSource,
  ): Promise<DeploymentCatalog> {
    const source = DeploymentConnectionSourceSchema.parse(sourceInput);
    if (source.kind !== "account") throw new Error("Account removal requires an Account source.");
    return this.#mutate((catalog, now) => {
      const deployments = catalog.deployments.filter(
        (deployment) => !sameConnectionSource(deployment.source, source),
      );
      if (deployments.length === catalog.deployments.length) return null;
      return {
        ...catalog,
        deployments,
        selectedDeploymentId:
          catalog.selectedDeploymentId !== null &&
          deployments.some(
            ({ authority }) => authority.document.deploymentId === catalog.selectedDeploymentId,
          )
            ? catalog.selectedDeploymentId
            : (mostRecentlyUsed(deployments)?.authority.document.deploymentId ?? null),
        updatedAt: now,
      };
    });
  }

  remove(deploymentId: DeploymentId | string): Promise<DeploymentCatalog> {
    const id = DeploymentIdSchema.parse(deploymentId);
    return this.#mutate((catalog, now) => {
      const deployments = catalog.deployments.filter(
        (deployment) => deployment.authority.document.deploymentId !== id,
      );
      if (deployments.length === catalog.deployments.length) return null;
      return {
        ...catalog,
        deployments,
        selectedDeploymentId:
          catalog.selectedDeploymentId === id
            ? (mostRecentlyUsed(deployments)?.authority.document.deploymentId ?? null)
            : catalog.selectedDeploymentId,
        updatedAt: now,
      };
    });
  }

  select(deploymentId: DeploymentId | string, usedAt = this.#now()): Promise<DeploymentCatalog> {
    const id = DeploymentIdSchema.parse(deploymentId);
    const usedAtValue = IsoDateTimeSchema.parse(usedAt.toISOString());
    return this.#mutate((catalog, now) => {
      let found = false;
      const deployments = catalog.deployments.map((deployment) => {
        if (deployment.authority.document.deploymentId !== id) return deployment;
        found = true;
        if (Date.parse(usedAtValue) < Date.parse(deployment.createdAt)) {
          throw new Error("Deployment use time cannot precede its creation time.");
        }
        return {
          ...deployment,
          lastUsedAt: usedAtValue,
          updatedAt: latestIsoDateTime(now, usedAtValue),
        };
      });
      if (!found) throw new Error("Cannot select a Deployment that is not in the catalog.");
      return {
        ...catalog,
        deployments,
        selectedDeploymentId: id,
        updatedAt: latestIsoDateTime(now, usedAtValue),
      };
    });
  }

  #mutate(
    mutation: (
      catalog: DeploymentCatalog,
      now: string,
    ) => (Omit<DeploymentCatalog, "revision"> & { readonly revision?: number }) | null,
  ): Promise<DeploymentCatalog> {
    return this.#mutations.run(async () => {
      const current = await this.load();
      const mutationTime = latestIsoDateTime(this.#now().toISOString(), current.updatedAt);
      const result = mutation(current, mutationTime);
      if (result === null) return current;
      const next = DeploymentCatalogSchema.parse({
        ...result,
        revision: current.revision + 1,
      });
      await this.#privateFiles.writeFileAtomic(this.#filePath, `${JSON.stringify(next)}\n`);
      for (const listener of this.#listeners) listener();
      return next;
    });
  }
}

export function emptyDeploymentCatalog(): DeploymentCatalog {
  return {
    deployments: [],
    revision: 0,
    schemaVersion: deploymentCatalogSchemaVersion,
    selectedDeploymentId: null,
    updatedAt: null,
  };
}

function mostRecentlyUsed(
  deployments: readonly DeploymentConnection[],
): DeploymentConnection | undefined {
  return [...deployments].sort((left, right) => {
    const leftTime = Date.parse(left.lastUsedAt ?? left.createdAt);
    const rightTime = Date.parse(right.lastUsedAt ?? right.createdAt);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return left.authority.document.deploymentId.localeCompare(
      right.authority.document.deploymentId,
    );
  })[0];
}

function latestIsoDateTime(left: string, right: string | null | undefined): string {
  if (right === null || right === undefined) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function sameConnectionDefinition(
  stored: DeploymentConnection,
  candidateInput: DeploymentConnectionInput,
): boolean {
  const candidate = DeploymentConnectionInputSchema.parse(candidateInput);
  if (
    JSON.stringify(stored.bootstrapMethods) !== JSON.stringify(candidate.bootstrapMethods) ||
    stored.kind !== candidate.kind ||
    stored.reachability !== candidate.reachability ||
    stored.name !== candidate.name ||
    stored.accountAccess !== candidate.accountAccess ||
    !sameConnectionSource(stored.source, candidate.source) ||
    (candidate.preferredEndpointOrigin !== undefined &&
      stored.preferredEndpointOrigin !== candidate.preferredEndpointOrigin) ||
    !sameDiscoveryDocument(stored.authority.document, candidate.authority.document)
  ) {
    return false;
  }
  if (
    stored.reachability === "routed" &&
    candidate.reachability === "routed" &&
    (stored.accountLivenessExpiresAt !== (candidate.accountLivenessExpiresAt ?? null) ||
      JSON.stringify(stored.personalAccessRoute) !==
        JSON.stringify(candidate.personalAccessRoute ?? null))
  ) {
    return false;
  }
  return candidate.endpoints.every((endpoint) =>
    stored.endpoints.some(
      (storedEndpoint) =>
        storedEndpoint.kind === endpoint.kind && storedEndpoint.origin === endpoint.origin,
    ),
  );
}

function sameStoredConnections(
  left: readonly DeploymentConnection[],
  right: readonly DeploymentConnection[],
): boolean {
  return (
    left.length === right.length && left.every((connection, index) => connection === right[index])
  );
}

function sameConnectionSource(
  left: DeploymentConnectionSource,
  right: DeploymentConnectionSource,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "manual" ||
      (right.kind === "account" && left.issuer === right.issuer && left.subject === right.subject))
  );
}

function sameConnectionHost(
  left: Pick<AttachmentConnection, "authority">,
  right: Pick<AttachmentConnection, "authority">,
): boolean {
  return isSameHost(left.authority, right.authority);
}

/** Either a stored connection or one that has been verified but not yet written. */
export type AttachmentConnection = DeploymentConnection | DeploymentConnectionInput;

function isCurrentStoredCatalogVersion(decoded: unknown): boolean {
  if (typeof decoded !== "object" || decoded === null || !("schemaVersion" in decoded))
    return false;
  return decoded.schemaVersion === deploymentCatalogSchemaVersion;
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximumDiscoveryTimeoutMs) {
    throw new Error(
      `Host discovery timeout must be an integer from 1 through ${maximumDiscoveryTimeoutMs}.`,
    );
  }
  return value;
}

type ConnectionRouteSubject = z.output<typeof DeploymentConnectionInputSchema>;

interface ConnectionRouteIssue {
  readonly message: string;
  readonly path: (number | string)[];
}

function addConnectionRouteIssues(
  deployment: ConnectionRouteSubject,
  addIssue: (issue: ConnectionRouteIssue) => void,
): void {
  const canonicalOrigin = ConnectionOriginSchema.safeParse(
    deployment.authority.document.canonicalOrigin,
  );
  if (!canonicalOrigin.success) {
    addIssue({
      message: "The Deployment canonical origin is unsafe for a Desktop connection",
      path: ["authority", "document", "canonicalOrigin"],
    });
  }
  const origins = new Set<string>();
  for (const [index, endpoint] of deployment.endpoints.entries()) {
    if (origins.has(endpoint.origin)) {
      addIssue({
        message: "A Deployment cannot contain duplicate access endpoint origins",
        path: ["endpoints", index, "origin"],
      });
    }
    origins.add(endpoint.origin);
    if (
      endpoint.kind === "canonical" &&
      endpoint.origin !== deployment.authority.document.canonicalOrigin
    ) {
      addIssue({
        message: "The canonical endpoint must use the Deployment canonical origin",
        path: ["endpoints", index, "origin"],
      });
    }
  }
  if (deployment.reachability === "canonical") {
    if (
      deployment.preferredEndpointOrigin !== null &&
      deployment.preferredEndpointOrigin !== undefined &&
      !deployment.endpoints.some(
        (endpoint) =>
          endpoint.kind === "direct" && endpoint.origin === deployment.preferredEndpointOrigin,
      )
    ) {
      addIssue({
        message: "The preferred endpoint must be one of this Deployment's verified direct routes",
        path: ["preferredEndpointOrigin"],
      });
    }
    return;
  }
  if (!isPersonalHost(deployment.authority.document) || deployment.kind !== "personal") {
    addIssue({
      message: "Routed reachability belongs only to a Personal Host",
      path: ["reachability"],
    });
  }
  if (deployment.personalAccessRoute) {
    const route = deployment.personalAccessRoute;
    try {
      const verified = verifyPersonalHostAccessRouteEnvelope(route);
      if (
        !sameDiscoveryDocument(deployment.authority.document, verified.document.authority) ||
        verified.publicKey.spki !== deployment.authority.publicKey.spki
      ) {
        addIssue({
          message: "The signed Personal access route belongs to another Host authority",
          path: ["personalAccessRoute"],
        });
      }
      const endpoint = deployment.endpoints[0];
      if (
        endpoint.kind === "direct" &&
        (endpoint.origin !== verified.document.route.origin ||
          deployment.preferredEndpointOrigin !== endpoint.origin)
      ) {
        addIssue({
          message: "A routed Deployment must select its signed route endpoint",
          path: ["endpoints"],
        });
      }
    } catch {
      addIssue({
        message: "The Personal access-route signature is invalid",
        path: ["personalAccessRoute"],
      });
    }
  }
  const endpoint = deployment.endpoints[0];
  if (endpoint.kind === "direct" && deployment.personalAccessRoute === null) {
    addIssue({
      message: "A routed endpoint requires its signed access route",
      path: ["personalAccessRoute"],
    });
  }
}
