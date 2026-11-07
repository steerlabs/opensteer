import { createContext, useContext } from "react";
import type { PairingOffer } from "../navigation-state.js";

/**
 * The app root's answers to a computer's codes, for a screen that reads one
 * itself. They are the same answers an operating-system link gets, so a
 * scanned code and a tapped link supersede earlier links in the same way.
 */
export interface AppLinks {
  /** Opens a computer from its Connect code, through the Account. */
  readonly openComputer: (deploymentId: string) => void;
  /** Fills in the pairing form for the person to confirm. Never pairs on its own. */
  readonly offerPairing: (offer: PairingOffer) => void;
}

const AppLinksContext = createContext<AppLinks | null>(null);

export const AppLinksProvider = AppLinksContext.Provider;

export function useAppLinks(): AppLinks {
  const links = useContext(AppLinksContext);
  if (links === null) throw new Error("This screen was rendered outside the Opensteer app root.");
  return links;
}
