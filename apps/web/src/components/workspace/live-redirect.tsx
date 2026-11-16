import { Navigate, useLocation } from "react-router";

/**
 * Watch is gone: its address opens Chat, keeping a tab it explicitly named
 * and inventing none. It replaces itself, so Back never returns to it.
 */
export function LiveRedirect() {
  const tab = new URLSearchParams(useLocation().search).get("tab");
  const query = tab === null ? "" : new URLSearchParams({ panel: "browser", tab }).toString();
  return <Navigate replace to={{ pathname: "/", search: query ? `?${query}` : "" }} />;
}
