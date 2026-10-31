import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";
import type { ComputerAppIdentity, DesktopUseComputerViewResult } from "@opensteer/protocol";
import { useMediaQuery } from "../../ui-utils.js";
import { placeSelection, type PlaceSelection, type WorkspaceNavigation } from "./navigation.js";

/**
 * What every part of the workspace agrees on: which place the address shows,
 * how the conversation sits beside it, and which rows the pointer is linking.
 * It never chooses anything itself; only the person's controls navigate.
 */
export interface WorkspaceState {
  /** How many tasks (Chat included) need the reader: the drawer button carries it. */
  readonly attention: number;
  readonly nav: WorkspaceNavigation;
  readonly openWebLink: (address: string) => void;
  readonly selection: PlaceSelection;
  /** A place or the launcher is in the middle. */
  readonly work: boolean;
  /** Below 1200px: the sidebar is a drawer. */
  readonly drawer: boolean;
  /** ≤ 700px: one surface at a time; the conversation is a sheet under a place. */
  readonly phone: boolean;
  readonly openDrawer: () => void;
  /** The conversation beside the place, or put away. */
  readonly dock: DockState;
  readonly highlight: HighlightStore;
  /** Whether the place's size is still moving, for what follows its size remotely. */
  readonly layout: LayoutPhaseStore;
  /**
   * The Mac this app runs on, as the Desktop's supervised Runner names it for
   * the selected deployment; null in a browser or before it is known. Only
   * this machine's apps can be brought forward here.
   */
  readonly localMachine: LocalMachine | null;
  /** The open start page's own leave and focus, for its row in the sidebar and for ⌘T. */
  readonly startPage: StartPageHandle;
}

/** What the open start page answers to from outside it; nothing while none is open. */
export class StartPageHandle {
  #leave: (() => void) | null = null;
  #focus: (() => void) | null = null;
  readonly register = (leave: () => void, focus: () => void): (() => void) => {
    this.#leave = leave;
    this.#focus = focus;
    return () => {
      if (this.#leave !== leave) return;
      this.#leave = null;
      this.#focus = null;
    };
  };
  readonly leave = (): void => this.#leave?.();
  readonly focus = (): void => this.#focus?.();
}

export interface DockState {
  readonly open: boolean;
  readonly close: () => void;
  readonly show: () => void;
}

export interface LocalMachine {
  readonly machineId: string;
  /** Brings the view's exact app forward on this Mac; absent where the Desktop cannot. */
  readonly useApp:
    | ((
        view: { readonly viewId: string; readonly generation: number },
        app: ComputerAppIdentity,
      ) => Promise<DesktopUseComputerViewResult>)
    | null;
}

/**
 * How the place's size is moving: `settling` while the dock opens or closes,
 * `dragging` while its divider is held, `settled` otherwise. A page sized to
 * the place waits out `settling`, slows down while `dragging`, and follows
 * once more when it settles. Kept outside React state: nothing re-renders
 * for it.
 */
export type LayoutPhase = "settled" | "settling" | "dragging";
export class LayoutPhaseStore {
  #phase: LayoutPhase = "settled";
  readonly #listeners = new Set<() => void>();
  readonly get = (): LayoutPhase => this.#phase;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly set = (phase: LayoutPhase): void => {
    if (phase === this.#phase) return;
    this.#phase = phase;
    for (const listener of this.#listeners) listener();
  };
}

/**
 * Below 1200px the sidebar is a drawer, so the place keeps its width; it
 * answers to the window's width alone.
 */
export const drawerQuery = "(max-width: 1199px)";

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace(): WorkspaceState {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("The workspace is not available here.");
  return value;
}

/** The workspace where one exists; settings pages and isolated views have none. */
export function useOptionalWorkspace(): WorkspaceState | null {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({
  attention,
  children,
  localMachine = null,
  nav,
  openDrawer,
  openWebLink: suppliedOpenWebLink,
}: {
  readonly attention: number;
  readonly children: ReactNode;
  readonly localMachine?: LocalMachine | null;
  readonly nav: WorkspaceNavigation;
  readonly openWebLink?: (address: string) => void;
  readonly openDrawer: () => void;
}) {
  const { pathname, search } = useLocation();
  const selection = useMemo(() => placeSelection(new URLSearchParams(search)), [search]);
  const selectionKey = JSON.stringify(selection);
  // Stable while the address names the same thing, so the middle does not
  // re-render because a conversation's path changed.
  const stableSelection = useMemo(() => selection, [selectionKey]);
  const drawer = useMediaQuery(drawerQuery);
  const phone = useMediaQuery("(max-width: 700px)");
  const [dockOpen, setDockOpen] = useState(true);
  // Choosing a conversation is choosing to read it.
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    setDockOpen(true);
  }, [pathname]);
  const close = useCallback(() => setDockOpen(false), []);
  const show = useCallback(() => setDockOpen(true), []);
  const dock = useMemo<DockState>(() => ({ close, open: dockOpen, show }), [close, dockOpen, show]);
  const highlight = useMemo(() => new HighlightStore(), []);
  const layout = useMemo(() => new LayoutPhaseStore(), []);
  const startPage = useMemo(() => new StartPageHandle(), []);
  const openWebLink = useCallback(
    (address: string) => {
      if (suppliedOpenWebLink) suppliedOpenWebLink(address);
      else nav.showLauncher({ address });
    },
    [nav, suppliedOpenWebLink],
  );
  const value = useMemo<WorkspaceState>(
    () => ({
      attention,
      dock,
      drawer,
      highlight,
      layout,
      localMachine,
      nav,
      openDrawer,
      openWebLink,
      phone,
      selection: stableSelection,
      startPage,
      work: stableSelection.kind !== "talk",
    }),
    [
      attention,
      dock,
      drawer,
      highlight,
      layout,
      localMachine,
      nav,
      openDrawer,
      openWebLink,
      phone,
      stableSelection,
      startPage,
    ],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/* ---- Hover links between task rows, tab rows and viewfinders ---- */

export interface Highlight {
  /** A task the pointer is on: the places it occupies light up. */
  readonly threadId: string | null;
  /** A place the pointer is on, from its tab row or a viewfinder. */
  readonly placeKey: string | null;
  /** The tasks in that place: their rows light up. */
  readonly threadIds: readonly string[];
}

const noHighlight: Highlight = { placeKey: null, threadId: null, threadIds: [] };

/**
 * Which task or place the pointer is on, outside React state, so one row's
 * hover re-renders only the rows whose match changes.
 */
export class HighlightStore {
  #value: Highlight = noHighlight;
  readonly #listeners = new Set<() => void>();
  readonly get = (): Highlight => this.#value;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly set = (value: Highlight | null): void => {
    const next = value ?? noHighlight;
    if (
      next.threadId === this.#value.threadId &&
      next.placeKey === this.#value.placeKey &&
      next.threadIds.join() === this.#value.threadIds.join()
    )
      return;
    this.#value = next;
    for (const listener of this.#listeners) listener();
  };
}

/** Whether the row is lit by the pointer elsewhere; re-renders only when that answer changes. */
export function useHighlightMatch(
  store: HighlightStore,
  matches: (highlight: Highlight) => boolean,
): boolean {
  const read = useCallback(() => matches(store.get()), [matches, store]);
  return useSyncExternalStore(store.subscribe, read, read);
}
