import type { ComponentProps, MouseEvent } from "react";
import { desktopBridge } from "../desktop/desktop-bridge.js";

/**
 * A normal browser link that crosses the Electron renderer boundary through
 * desktop main. Main validates the destination before asking the operating
 * system to open it; web sessions retain ordinary anchor behavior.
 */
export function ExternalLink({
  href,
  onOpenError,
  ...props
}: Omit<ComponentProps<"a">, "href" | "onClick" | "rel" | "target"> & {
  readonly href: string;
  readonly onOpenError?: (reason: unknown) => void;
}) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    const bridge = desktopBridge();
    if (!bridge) return;
    event.preventDefault();
    void bridge.openExternalUrl({ url: href }).catch((reason: unknown) => {
      if (onOpenError) onOpenError(reason);
      else globalThis.reportError(reason);
    });
  };

  return <a {...props} href={href} onClick={open} rel="noreferrer" target="_blank" />;
}
