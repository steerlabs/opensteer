import { createContext, useContext } from "react";
import type { HostInstance } from "react-native";

/**
 * The sidebar, as the screens under it see it.
 *
 * Control and visibility are two contexts so a header button that only opens
 * the sidebar never re-renders when it moves. Visibility changes at the
 * drawer's own state boundaries — a drag begins, a settle ends — and never per
 * frame: the movement itself stays on the UI thread.
 */
export interface SidebarControl {
  readonly close: () => void;
  /**
   * The Menu, where the sidebar is a drawer: it opens it over the current
   * root destination. Docked, the sidebar is already in view and this does
   * nothing. The trigger, when it is a view this app drew, gets screen-reader
   * focus back when the drawer closes without going anywhere.
   */
  readonly open: (trigger?: HostInstance | null) => void;
}

/**
 * Whether the sidebar is docked beside the screens. The window's room alone
 * decides: where there is room it is always docked, and elsewhere it is the
 * drawer.
 */
export const SidebarDockedContext = createContext(false);

export function useSidebarDocked(): boolean {
  return useContext(SidebarDockedContext);
}

export const SidebarControlContext = createContext<SidebarControl | null>(null);

/**
 * True from the moment the drawer starts to cover the screen until it has fully
 * left. A docked sidebar covers nothing: it is beside the screen, not over it.
 */
export const SidebarVisibleContext = createContext(false);

export function useSidebarControl(): SidebarControl | null {
  return useContext(SidebarControlContext);
}

/**
 * Whether the sidebar is over the screen. A controlled drawer does not blur the
 * native route beneath it, so anything that reads "the reader is looking at
 * this" — read markers, alert suppression — asks here as well as for focus.
 */
export function useSidebarVisible(): boolean {
  return useContext(SidebarVisibleContext);
}
