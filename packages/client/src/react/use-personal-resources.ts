import { useEffect } from "react";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import type { HostClient } from "../host/client.js";

export function usePersonalResources(
  client: HostClient | null,
  kinds: readonly PersonalResourceKind[],
) {
  useEffect(() => {
    const releases = kinds.map((kind) => client?.watchPersonalResource(kind, () => {}));
    return () => {
      for (const release of releases) release?.();
    };
  }, [client, kinds]);
}
