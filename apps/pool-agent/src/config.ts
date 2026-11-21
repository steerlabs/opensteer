import { readPrivateFileText } from "@opensteer/shared/atomicPrivateFile";
import { z } from "zod";
import { maximumSlots } from "./firecracker/slot-numbers.js";
import { isPublicIp } from "@opensteer/access/public-network";

const path = z.string().regex(/^\/[A-Za-z0-9._/-]{1,255}$/u);
const port = z.number().int().min(1).max(65_535);
const listen = z.union([
  z.strictObject({ host: z.string().min(1).max(64), port }),
  z.strictObject({ path }),
]);

export const agentConfigSchema = z
  .strictObject({
    journal: path,
    /** The Home interface; reachable from the Homes' network only (host firewall). */
    listen,
    admin: z.strictObject({
      listen,
      /** SPKI DER, base64, of the provisioner's Ed25519 key. */
      provisionerKey: z.string().min(40).max(200),
      /** This host's id as the provisioner enrolled it; requests for another host are refused. */
      hostId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      /** This host's Ed25519 key (PKCS#8 PEM, root only), made at install; replies are signed with it. */
      hostKeyFile: path,
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
      /** The mode that works today is the default (review G5); `runtime` is refused at start. */
      guestMode: z.enum(["runtime", "bench"]).default("bench"),
      serialConsole: z.boolean().default(false),
    }),
  })
  .refine(
    // Review G10: a slot's VMM uid and any slot's proxy uid are never the same.
    (config) =>
      config.driver.slotUidBase + maximumSlots <= config.driver.egressUidBase ||
      config.driver.egressUidBase + maximumSlots <= config.driver.slotUidBase,
    "The slot uid range and the egress uid range overlap.",
  );

export type AgentConfig = z.infer<typeof agentConfigSchema>;

/**
 * Review G5: our browser runtime does not yet run in a pool guest (it reads no pool fence,
 * refuses a non-loopback egress proxy, and its bridge token is made inside the guest). The
 * agent refuses that mode at start rather than boot guests that cannot work.
 */
export function refuseUnsupportedMode(config: AgentConfig): void {
  if (config.driver.guestMode === "runtime")
    throw new Error(
      'guestMode "runtime" is not supported yet: the browser runtime does not run in a pool guest. Use "bench".',
    );
}

/** Review G10: the configuration names keys and paths; nobody but root reads it. */
export async function readAgentConfig(file: string): Promise<AgentConfig> {
  const text = await readPrivateFileText(file, 1024 * 1024, {
    invalid: () => new Error(`The configuration at ${file} is unreadable.`),
    exposed: () => new Error(`The configuration at ${file} is readable by other users.`),
  });
  if (text === undefined) throw new Error(`There is no configuration at ${file}.`);
  return agentConfigSchema.parse(JSON.parse(text));
}
