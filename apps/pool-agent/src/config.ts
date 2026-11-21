import { readFile } from "node:fs/promises";
import { z } from "zod";

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
  retentionHours: z
    .number()
    .positive()
    .max(24 * 7)
    .default(24),
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
    slotUidBase: z.number().int().min(10_000),
    egressUidBase: z.number().int().min(10_000),
    egress: z.strictObject({ node: path, main: path }),
    network: z.strictObject({
      resolvers: z.array(z.ipv4()).max(4),
      hostUpstreamPorts: z.array(port).max(8).default([]),
      relayUid: z.number().int().min(0).nullable().default(null),
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
