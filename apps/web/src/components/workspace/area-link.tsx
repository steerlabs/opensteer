import { useCallback } from "react";
import { Link, useNavigate, type LinkProps } from "react-router";
import { useOptionalWorkspace } from "./workspace-context.js";

/**
 * A link to a conversation-area page. Inside the workspace it keeps the place
 * in the middle, so following it never tears the place's viewer down; on a
 * page with no workspace it is an ordinary link.
 */
export function AreaLink({ to, ...props }: Omit<LinkProps, "to"> & { readonly to: string }) {
  const workspace = useOptionalWorkspace();
  return <Link {...props} to={workspace ? workspace.nav.conversationHref(to) : to} />;
}

/** The same rule for a page that moves on by itself: a save, a cancel, a delete. */
export function useAreaNavigate(): (
  to: string,
  options?: { readonly replace?: boolean; readonly state?: unknown },
) => void {
  const workspace = useOptionalWorkspace();
  const navigate = useNavigate();
  const openPage = workspace?.nav.openPage ?? null;
  return useCallback(
    (to, options) => {
      if (openPage) openPage(to, options);
      else
        void navigate(to, {
          ...(options?.replace ? { replace: true } : {}),
          ...(options?.state === undefined ? {} : { state: options.state }),
        });
    },
    [navigate, openPage],
  );
}
