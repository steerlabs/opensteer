import type { EffectiveWorkPolicy } from "@opensteer/control-plane-protocol";
import { useEffect, useState } from "react";
import type { HostClient } from "../host/client.js";
import { readWorkPolicy } from "../host/work-home.js";

/** One read per client: a Home's policy changes rarely, and every surface asks the same. */
const reads = new WeakMap<HostClient, Promise<EffectiveWorkPolicy | null>>();

function read(client: HostClient): Promise<EffectiveWorkPolicy | null> {
  let pending = reads.get(client);
  if (!pending) {
    pending = readWorkPolicy(client).catch(() => {
      // A failed read is tried again by the next surface that asks; the Home still enforces.
      reads.delete(client);
      return null;
    });
    reads.set(client, pending);
  }
  return pending;
}

/**
 * The Home's work policy: `undefined` while it is read, `null` on a personal Home (or when it
 * couldn't be read), the policy on a work Home.
 */
export function useWorkPolicy(client: HostClient | null): EffectiveWorkPolicy | null | undefined {
  const [result, setResult] = useState<{
    readonly client: HostClient;
    readonly policy: EffectiveWorkPolicy | null;
  }>();
  useEffect(() => {
    if (!client) return;
    let live = true;
    void read(client).then((policy) => {
      if (live) setResult({ client, policy });
    });
    return () => {
      live = false;
    };
  }, [client]);
  if (!client) return null;
  return result?.client === client ? result.policy : undefined;
}
