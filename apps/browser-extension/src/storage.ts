import { BrowserSiteSchema, BrowserSourceIdSchema } from "@opensteer/core";
import {
  BrowserSourceOriginSchema,
  HostDiscoveryEnvelopeSchema,
  PersonalHostAccessRouteEnvelopeSchema,
} from "@opensteer/deployment-authority";
import { BrowserSourceNameSchema } from "@opensteer/protocol/browser-sources";
import { z } from "zod";

/** New sites one connection may receive per rolling day before the person allows more. */
export const dailyNewSiteBudget = 20;
export const budgetWindowMs = 24 * 60 * 60 * 1_000;
const maximumConnections = 16;

const SiteShareSchema = z.strictObject({
  firstSharedAt: z.number().int().nonnegative(),
  lastSharedAt: z.number().int().nonnegative(),
});

const ConnectionSchema = z.strictObject({
  authority: HostDiscoveryEnvelopeSchema,
  /** The protocol version the Host refused; cleared when a newer build retries. */
  blockedVersion: z.number().int().positive().optional(),
  connectedAt: z.number().int().nonnegative(),
  deploymentName: z.string().trim().min(1).max(120),
  /** Opensteer proved its identity and then refused this connection's token. */
  ended: z.literal(true).optional(),
  /** Opensteer speaks an older protocol than this build; cleared by Try again. */
  hostOutdated: z.literal(true).optional(),
  name: BrowserSourceNameSchema,
  /** When each newly shared site was first shared, for the rolling daily budget. */
  newShares: z.array(z.number().int().nonnegative()).max(dailyNewSiteBudget * 4),
  origin: BrowserSourceOriginSchema,
  route: PersonalHostAccessRouteEnvelopeSchema.nullable(),
  routeChanged: z.literal(true).optional(),
  sharedSites: z.record(BrowserSiteSchema, SiteShareSchema),
  sourceId: BrowserSourceIdSchema,
  stoppedSites: z.array(BrowserSiteSchema).max(4_096),
  token: z.string().min(32).max(256),
});
export type Connection = z.infer<typeof ConnectionSchema>;

const connectionsKey = "connections";
let mutationTail: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationTail.then(operation, operation);
  mutationTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function restrictCredentialStorage(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function loadConnections(): Promise<Connection[]> {
  const stored = await chrome.storage.local.get(connectionsKey);
  const entries = z.array(z.unknown()).max(maximumConnections).safeParse(stored[connectionsKey]);
  if (!entries.success) return [];
  return entries.data.flatMap((entry) => {
    const parsed = ConnectionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
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
  replacedSourceId: string | null,
): Promise<Connection> {
  return await serialize(async () => {
    const existing = await loadConnections();
    const replaced = replacedSourceId
      ? existing.find((item) => item.sourceId === replacedSourceId)
      : undefined;
    const next: Connection = replaced
      ? {
          ...connection,
          newShares: replaced.newShares,
          sharedSites: replaced.sharedSites,
          stoppedSites: replaced.stoppedSites,
        }
      : connection;
    await writeConnections([
      ...existing.filter(
        (item) => item.sourceId !== replacedSourceId && item.sourceId !== connection.sourceId,
      ),
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
    const connections = await loadConnections();
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
    const connections = await loadConnections();
    const removed = connections.find((item) => item.sourceId === sourceId) ?? null;
    await writeConnections(connections.filter((item) => item.sourceId !== sourceId));
    return removed;
  });
}

export function recentNewShares(connection: Connection, now = Date.now()): number[] {
  return connection.newShares.filter((at) => now - at < budgetWindowMs && at <= now);
}
