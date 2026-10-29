import { createContext, useContext, type ReactNode } from "react";
import { Icon } from "./icon.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

interface SidebarChromeState {
  readonly onRestore: () => void;
  readonly restoreVisible: boolean;
}

const SidebarChromeContext = createContext<SidebarChromeState | null>(null);

export function SidebarChromeProvider({
  children,
  onRestore,
  restoreVisible,
}: SidebarChromeState & { readonly children: ReactNode }) {
  return (
    <SidebarChromeContext.Provider value={{ onRestore, restoreVisible }}>
      {children}
    </SidebarChromeContext.Provider>
  );
}

/**
 * The desktop restore control belongs to the titlebar whose drag region it
 * interrupts. Electron resolves drag and no-drag regions in document order,
 * independently of CSS stacking, so a floating control from an ancestor can
 * look correct while a later titlebar still captures its clicks.
 */
export function SidebarRestoreButton() {
  const state = useContext(SidebarChromeContext);
  const count = useOptionalWorkspace()?.attention ?? 0;
  if (!state?.restoreVisible) return null;

  // The sidebar is gone while put away, so what needs the reader travels here.
  return (
    <button
      aria-controls="app-sidebar"
      aria-label={count > 0 ? `Show sidebar, ${count} need you` : "Show sidebar"}
      className="drawer-btn sidebar__restore"
      onClick={state.onRestore}
      title="Show sidebar · ⌘\\"
      type="button"
    >
      <Icon name="panel" />
      {count > 0 ? (
        <span aria-hidden className="side-needs side-needs--inline">
          <span className="side-needs__bang">!</span>
          {count}
        </span>
      ) : null}
    </button>
  );
}
