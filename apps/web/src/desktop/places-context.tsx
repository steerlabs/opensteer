import { createContext, useContext, useEffect } from "react";
import type { DeploymentAccessSnapshot, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";

/**
 * Everything a list of places needs, provided once by the Desktop shell to
 * every screen it shows — the full window before a place is open and the
 * sidebar inside one. A browser has no list of places, so it has no provider,
 * and its sidebar keeps the plain menu.
 */
export interface DesktopPlaces {
  readonly bridge: OpensteerDesktopBridge;
  /** Deployments the signed-in Account created in Opensteer Cloud. */
  readonly cloudDeploymentIds: ReadonlySet<string>;
  /** Opens the screen that adds a computer or server. */
  readonly onAddPlace: () => void;
  readonly snapshot: DeploymentAccessSnapshot;
}

const DesktopPlacesContext = createContext<DesktopPlaces | null>(null);

export const DesktopPlacesProvider = DesktopPlacesContext.Provider;

export function useDesktopPlaces(): DesktopPlaces | null {
  return useContext(DesktopPlacesContext);
}

/** Often enough that a list left open stays true; rarely enough to cost nothing. */
const recheckIntervalMilliseconds = 30_000;

/**
 * Keeps a list of places checked for as long as it is on screen: once when it
 * opens, then on an interval. The Desktop shares one check among every caller,
 * so a list that opens twice in a row costs one check, not two.
 */
export function usePlaceChecks(
  bridge: Pick<OpensteerDesktopBridge, "checkDeployments">,
  visible: boolean,
): void {
  useEffect(() => {
    if (!visible) return;
    const check = () => void bridge.checkDeployments().catch(() => undefined);
    check();
    const timer = window.setInterval(check, recheckIntervalMilliseconds);
    return () => window.clearInterval(timer);
  }, [bridge, visible]);
}
