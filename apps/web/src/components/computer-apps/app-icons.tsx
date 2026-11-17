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

/** An app's icon as the Mac drew it, or its initial when the Mac is away. */
export function AppMark({
  iconPng,
  identity,
  machineId,
}: {
  readonly iconPng?: string | undefined;
  readonly identity: ComputerAppIdentity;
  /** The Mac the app is on, to read its real icon from; its initial until then. */
  readonly machineId?: string | null | undefined;
}) {
  const className = "intg-icon computer-use__app-mark";
  const read = useAppIcon(iconPng ? null : machineId, identity);
  const png = iconPng ?? read;
  if (png) {
    return (
      <img alt="" className={className} decoding="async" src={`data:image/png;base64,${png}`} />
    );
  }
  return (
    <span aria-hidden className={`${className} intg-icon--monogram`}>
      {identity.displayName.trim().charAt(0).toUpperCase()}
    </span>
  );
}
