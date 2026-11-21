import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isPublicIp } from "@opensteer/access/public-network";

const path = z.string().regex(/^\/[A-Za-z0-9._/-]{1,255}$/u);
const port = z.number().int().min(1).max(65_535);
const listen = z.union([
  z.strictObject({ host: z.string().min(1).max(64), port }),
  z.strictObject({ path }),
]);

export const agentConfigSchema = z.strictObject({
  journal: path,
  /** The Home interface; reachable from the Homes' network only (host firewall). */
  listen,
  admin: z.strictObject({
    listen,
    /** SPKI DER, base64, of the provisioner's Ed25519 key. */
    provisionerKey: z.string().min(40).max(200),
  }),
  /** May lower the binding 24-hour limit on a parked guest's live state, never raise it. */
  retentionHours: z.number().positive().max(24).default(24),
  /** Seconds a guest stays paused in memory before it is saved to disk; null keeps it there. */
  saveAfterSeconds: z.number().nonnegative().nullable().default(600),
  maxConcurrentSaves: z.number().int().min(1).max(64).default(2),
  driver: z.strictObject({
    firecracker: path,
    jailer: path,
    images: path,
    jailRoot: path,
    savedRoot: path,
    stateDirectory: path,
    arrayIdFile: path,
    cgroupBase: z.string().max(255).optional(),
    profilesRoot: path,
    credentialsRoot: path,
    slotUidBase: z.number().int().min(10_000),
    egressUidBase: z.number().int().min(10_000),
    egress: z.strictObject({ node: path, main: path }),
    network: z.strictObject({
      /** Public resolvers only; a resolver in a blocked range must be named below. */
      resolvers: z
        .array(z.ipv4().refine(isPublicIp, "A resolver here must be a public address."))
        .max(4),
      /** Review G4(b): opened for port 53 only because it is named (Google's is 169.254.169.254). */
      privateResolvers: z.array(z.ipv4()).max(2).default([]),
      /** Review G4(c): a host-local upstream proxy, by address and port. */
      hostUpstreams: z
        .array(z.strictObject({ address: z.ipv4(), port }))
        .max(8)
        .default([]),
      relayUid: z.number().int().min(0).nullable().default(null),
      nftDirectory: path.default("/etc/opensteer-pool/nft"),
    }),
    guestMode: z.enum(["runtime", "bench"]).default("runtime"),
    serialConsole: z.boolean().default(false),
  }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export async function readAgentConfig(file: string): Promise<AgentConfig> {
  const text = await readFile(file, "utf8");
  return agentConfigSchema.parse(JSON.parse(text));
}
