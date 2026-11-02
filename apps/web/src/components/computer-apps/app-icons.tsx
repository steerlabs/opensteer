import { createContext, useContext, type ReactNode } from "react";
import type { ComputerAppIdentity } from "@opensteer/protocol";
import type { HostClient } from "@opensteer/client/host";
import { useAppIcon as useSharedAppIcon } from "@opensteer/client/react";

const AppIconContext = createContext<HostClient | null>(null);

export function AppIconProvider({
  children,
  hostClient,
}: {
  readonly children: ReactNode;
  readonly hostClient: HostClient;
}) {
  return <AppIconContext.Provider value={hostClient}>{children}</AppIconContext.Provider>;
}

/** The app's own icon from its Mac; an initial is drawn until an authorized read answers. */
export function useAppIcon(
  machineId: string | null | undefined,
  identity: ComputerAppIdentity,
): string | null {
  return useSharedAppIcon(useContext(AppIconContext), machineId, identity);
}
