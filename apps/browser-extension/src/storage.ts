import { BrowserSiteSchema } from "@opensteer/browser-source-wire/site";
import {
  BrowserSourceIdSchema,
  BrowserSourceOriginSchema,
  DeploymentIdSchema,
} from "@opensteer/browser-source-wire/frozen";
import { BrowserSourceNameSchema } from "@opensteer/browser-source-wire/frames";
import { z } from "zod";

/** New sites one connection may receive per rolling day before the person allows more. */
export const dailyNewSiteBudget = 20;
export const budgetWindowMs = 24 * 60 * 60 * 1_000;
const maximumConnections = 16;

const SiteShareSchema = z.object({
  firstSharedAt: z.number().int().nonnegative(),
  lastSharedAt: z.number().int().nonnegative(),
});

const ConnectionSchema = z.object({
  schema: z.literal(2),
  deploymentId: DeploymentIdSchema,
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{59}$/u),
  canonicalOrigin: BrowserSourceOriginSchema,
  excludedOrigins: z.array(BrowserSourceOriginSchema),
  routeGeneration: z.number().int().positive().nullable(),
  held: z
    .object({
      state: z.enum([
        "different-opensteer",
        "ended",
        "route-changed",
        "host-outdated",
        "update-required",
      ]),
      version: z.number().int().positive().optional(),
    })
    .optional(),
  connectedAt: z.number().int().nonnegative(),
  deploymentName: z.string().trim().min(1).max(120),
  name: BrowserSourceNameSchema,
  /** When each newly shared site was first shared, for the rolling daily budget. */
  newShares: z.array(z.number().int().nonnegative()),
  origin: BrowserSourceOriginSchema,
  sharedSites: z.record(BrowserSiteSchema, SiteShareSchema),
  sourceId: BrowserSourceIdSchema,
  stoppedSites: z.array(BrowserSiteSchema),
  token: z.string().min(32).max(256),
});
export type Connection = z.infer<typeof ConnectionSchema>;

const connectionsKey = "connections";
let mutations = 0;
export function storageBusy(): boolean {
  return mutations > 0;
}
let mutationTail: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  mutations += 1;
  const next = mutationTail.then(operation, operation).finally(() => {
    mutations -= 1;
  });
  mutationTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function restrictCredentialStorage(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function migrateConnection(raw: unknown): Connection | null {
  const value = object(raw);
  const authority = object(value.authority);
  const document = object(authority.document);
  const route = object(object(object(value.route).document).route);
  const origin = value.origin ?? route.origin ?? document.canonicalOrigin;
  const canonicalOrigin = value.canonicalOrigin ?? document.canonicalOrigin;
  const parsed = ConnectionSchema.safeParse({
    ...value,
    schema: 2,
    held:
      value.held ??
      (value.ended === true
        ? { state: "ended" }
        : value.routeChanged === true
          ? { state: "route-changed" }
          : value.hostOutdated === true
            ? { state: "host-outdated" }
            : typeof value.blockedVersion === "number"
              ? { state: "update-required", version: value.blockedVersion }
              : undefined),
    deploymentId: value.deploymentId ?? document.deploymentId,
    publicKey: value.publicKey ?? object(authority.publicKey).spki,
    canonicalOrigin,
    origin,
    routeGeneration: value.routeGeneration ?? route.generation ?? null,
    excludedOrigins: [
      ...new Set(
        [
          ...(Array.isArray(value.excludedOrigins) ? value.excludedOrigins : []),
          origin,
          canonicalOrigin,
          route.origin,
        ].filter((x) => x !== undefined),
      ),
    ],
  });
  return parsed.success ? parsed.data : null;
}

type Quarantine = { id: string; raw: unknown };
async function readState(): Promise<{ connections: Connection[]; quarantined: Quarantine[] }> {
  const stored = await chrome.storage.local.get([connectionsKey, "quarantined"]);
  const kept = z
    .array(z.object({ id: z.string().min(1).max(64), raw: z.unknown() }))
    .safeParse(stored.quarantined ?? []);
  // A damaged quarantine list is itself kept, never discarded.
  const quarantined: Quarantine[] = kept.success
    ? kept.data
    : [{ id: crypto.randomUUID(), raw: stored.quarantined }];
  const connections: Connection[] = [];
  const original = stored[connectionsKey];
  const entries = Array.isArray(original) ? original : original === undefined ? [] : [original];
  for (const raw of entries) {
    const migrated = Array.isArray(original) ? migrateConnection(raw) : null;
    if (migrated) connections.push(migrated);
    else quarantined.push({ id: crypto.randomUUID(), raw });
  }
  const next = { connections, quarantined };
  if (
    JSON.stringify(next) !==
    JSON.stringify({ connections: original ?? [], quarantined: stored.quarantined ?? [] })
  ) {
    await chrome.storage.local.set(next);
  }
  return next;
}

export async function loadConnections(): Promise<Connection[]> {
  return await serialize(async () => (await readState()).connections);
}
export async function loadQuarantine(): Promise<string[]> {
  return await serialize(async () => (await readState()).quarantined.map((item) => item.id));
}
export async function forgetQuarantine(id: string): Promise<void> {
  await serialize(async () => {
    const state = await readState();
    await chrome.storage.local.set({
      ...state,
      quarantined: state.quarantined.filter((item) => item.id !== id),
    });
  });
}

export async function loadConnection(sourceId: string): Promise<Connection | null> {
  return (await loadConnections()).find((item) => item.sourceId === sourceId) ?? null;
}

async function writeConnections(connections: Connection[]): Promise<void> {
  if (connections.length > maximumConnections) {
    throw new Error("This Chrome profile is connected to too many Opensteers.");
  }
  await chrome.storage.local.set({
    [connectionsKey]: connections.map((item) => ConnectionSchema.parse(item)),
  });
}

/** Saves a new connection, retiring the one it replaces and keeping that one's site choices. */
export async function addConnection(
  connection: Connection,
  _replacedSourceId: string | null,
): Promise<Connection> {
  return await serialize(async () => {
    const { connections: existing, quarantined } = await readState();
    const sameIdentity = (item: Connection): boolean =>
      item.deploymentId === connection.deploymentId && item.publicKey === connection.publicKey;
    if (existing.some((item) => item.sourceId === connection.sourceId && !sameIdentity(item)))
      throw new Error("This connection conflicts with a saved connection.");
    const previous = existing.filter(sameIdentity);
    const stopped = new Set(connection.stoppedSites);
    const sharedSites = { ...connection.sharedSites };
    const newShares = [...connection.newShares];
    for (const item of previous) {
      item.stoppedSites.forEach((site) => stopped.add(site));
      Object.assign(sharedSites, item.sharedSites);
      newShares.push(...item.newShares);
    }
    const pluckStops = (raw: unknown): void => {
      if (Array.isArray(raw)) {
        raw.forEach(pluckStops);
        return;
      }
      const value = object(raw);
      const deploymentId =
        value.deploymentId ?? object(object(value.authority).document).deploymentId;
      if (deploymentId !== undefined && deploymentId !== connection.deploymentId) return;
      if (Array.isArray(value.stoppedSites))
        for (const site of value.stoppedSites) {
          const parsed = BrowserSiteSchema.safeParse(site);
          if (parsed.success) stopped.add(parsed.data);
        }
    };
    quarantined.forEach((item) => pluckStops(item.raw));
    const next: Connection = { ...connection, sharedSites, newShares, stoppedSites: [...stopped] };
    await writeConnections([
      ...existing.filter((item) => !sameIdentity(item) && item.sourceId !== connection.sourceId),
      next,
    ]);
    return next;
  });
}

/**
 * Applies `change` to one stored connection. Returning `null` from `change`
 * leaves it untouched. The token check keeps a late update from an old
 * connection from landing on a replacement with the same ID.
 */
export async function updateConnection<T>(
  sourceId: string,
  change: (connection: Connection) => { connection: Connection; result: T } | null,
  token?: string,
): Promise<T | null> {
  return await serialize(async () => {
    const { connections } = await readState();
    const index = connections.findIndex((item) => item.sourceId === sourceId);
    const current = connections[index];
    if (!current || (token !== undefined && current.token !== token)) return null;
    const changed = change(current);
    if (!changed) return null;
    connections[index] = changed.connection;
    await writeConnections(connections);
    return changed.result;
  });
}

export async function removeConnection(sourceId: string): Promise<Connection | null> {
  return await serialize(async () => {
    const { connections } = await readState();
    const removed = connections.find((item) => item.sourceId === sourceId) ?? null;
    await writeConnections(connections.filter((item) => item.sourceId !== sourceId));
    return removed;
  });
}

export function recentNewShares(connection: Connection, now = Date.now()): number[] {
  return connection.newShares.filter((at) => now - at < budgetWindowMs && at <= now);
}
