import { forwardRef, type ComponentProps, type MouseEvent } from "react";
import { desktopBridge } from "../desktop/desktop-bridge.js";

/**
 * A normal browser link that crosses the Electron renderer boundary through
 * desktop main. Main validates the destination before asking the operating
 * system to open it; web sessions retain ordinary anchor behavior.
 */
export const ExternalLink = forwardRef<
  HTMLAnchorElement,
  Omit<ComponentProps<"a">, "href" | "onClick" | "ref" | "rel" | "target"> & {
    readonly href: string;
    /** Runs inside the press, so it may use what only a person's gesture allows. */
    readonly onOpen?: () => void;
    readonly onOpenError?: (reason: unknown) => void;
  }
>(function ExternalLink({ href, onOpen, onOpenError, ...props }, ref) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    onOpen?.();
    const bridge = desktopBridge();
    if (!bridge) return;
    event.preventDefault();
    void bridge.openExternalUrl({ url: href }).catch((reason: unknown) => {
      if (onOpenError) onOpenError(reason);
      else globalThis.reportError(reason);
    });
  };

  return <a {...props} href={href} onClick={open} ref={ref} rel="noreferrer" target="_blank" />;
});
