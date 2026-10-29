import { useEffect, useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { fullAccessDeclineLabel, fullDiskAccessLabel } from "@opensteer/client/host";
import { Icon } from "../components/icon.js";

/** How often macOS is asked again while the pane is open. */
const pollIntervalMs = 1_000;
/** Long enough for the person to read that it worked before the panel goes. */
const doneLingerMs = 1_200;

/** Everything the floating panel needs; it never talks to a Host. */
export type FullAccessPanelBridge = Pick<
  OpensteerDesktopBridge,
  "checkFullDiskAccess" | "closeFullDiskAccessPanel"
>;

/**
 * The small window the desktop floats over System Settings' Full Disk Access
 * pane: the app icon to look for in the list, what to do with its switch, and
 * a way out.
 *
 * macOS offers no way to ask for this grant, so the panel does the only thing
 * a program can — keep asking whether the grant has arrived. The app is
 * already in the list (macOS adds it on the first denied probe), so nothing is
 * dragged; nothing here writes the switch. macOS applies the grant to a running
 * app only once it has quit ("will not have full disk access until it is
 * quit", with a Quit & Reopen button), so the copy sends the person through
 * that button; the Runner probes again on launch and reports the grant.
 */
export function FullAccessPanel({
  appName,
  bridge,
}: {
  /** How the macOS list names this app: "Opensteer", or "Opensteer Beta". */
  readonly appName: string;
  readonly bridge: FullAccessPanelBridge;
}) {
  const [granted, setGranted] = useState(false);

  // The window is transparent so only the card shows; the attribute scopes
  // that to this page rather than to every document the app renders.
  useEffect(() => {
    document.documentElement.dataset.panel = "full-access";
    return () => {
      delete document.documentElement.dataset.panel;
    };
  }, []);

  useEffect(() => {
    if (granted) return;
    const timer = globalThis.setInterval(() => {
      void bridge
        .checkFullDiskAccess()
        .then((status) => {
          if (status.granted) setGranted(true);
        })
        // A probe that fails answers nothing, so the panel keeps the answer it
        // has and asks again a second later.
        .catch(() => undefined);
    }, pollIntervalMs);
    return () => globalThis.clearInterval(timer);
  }, [bridge, granted]);

  useEffect(() => {
    if (!granted) return;
    const timer = globalThis.setTimeout(() => {
      void bridge.closeFullDiskAccessPanel().catch(() => undefined);
    }, doneLingerMs);
    return () => globalThis.clearTimeout(timer);
  }, [bridge, granted]);

  return (
    <div className="full-access-panel">
      <div className="full-access-panel__main">
        <img
          alt=""
          className="full-access-panel__icon"
          decoding="async"
          draggable={false}
          src="/opensteer.png"
        />
        <div className="full-access-panel__body">
          {granted ? (
            <p className="full-access-panel__headline">
              <Icon name="check" />
              {fullDiskAccessLabel} is on.
            </p>
          ) : (
            <>
              <p className="full-access-panel__headline">
                Turn on {appName} in the {fullDiskAccessLabel} list.
              </p>
              <p className="full-access-panel__sub">
                macOS asks for your password or Touch ID, then offers to quit and reopen {appName}.
                Choose Quit &amp; Reopen.
              </p>
            </>
          )}
        </div>
      </div>
      {granted ? null : (
        <div className="full-access-panel__actions">
          <button
            className="btn btn--ghost btn--small full-access-panel__dismiss"
            onClick={() => void bridge.closeFullDiskAccessPanel().catch(() => undefined)}
            type="button"
          >
            {fullAccessDeclineLabel}
          </button>
        </div>
      )}
    </div>
  );
}
