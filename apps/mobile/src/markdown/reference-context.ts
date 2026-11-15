import type {
  PersonalReferenceNavigationPorts,
  ReferenceNavigationPorts,
  ReferenceRenderContext,
} from "@opensteer/client/references";
import { createContext, useContext } from "react";

/**
 * How the links in what is on screen open: the Deployment or team that owns
 * those words, captured where they are drawn. A tap never asks which
 * Deployment is selected now; the words name their owner and only that owner
 * may answer for them.
 */
export interface ReferenceNavigation {
  readonly context: ReferenceRenderContext;
  readonly ports: ReferenceNavigationPorts | PersonalReferenceNavigationPorts;
  /** Opens what an internal link names. A failure is told to the person, never thrown. */
  readonly open: (href: string) => Promise<void>;
}

export const ReferenceNavigationContext = createContext<ReferenceNavigation | null>(null);

export function useReferenceNavigation(): ReferenceNavigation | null {
  return useContext(ReferenceNavigationContext);
}

/**
 * Whether what is drawn here can be seen now, so its references may be looked
 * up. Words folded out of sight still show what this phone already holds.
 */
export const ReferenceVisibility = createContext(true);
