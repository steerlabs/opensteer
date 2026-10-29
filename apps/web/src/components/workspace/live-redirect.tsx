import { Navigate, useLocation } from "react-router";

const placeParams = [
  "browser",
  "browserTab",
  "computerSession",
  "app",
  "mac",
  "phone",
  "display",
] as const;

/**
 * Watch is gone: its address opens Chat, keeping a place it explicitly named
 * and inventing none. It replaces itself, so Back never returns to it.
 */
export function LiveRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const name of placeParams) {
    const value = params.get(name);
    if (value !== null) kept.set(name, value);
  }
  if ([...kept.keys()].length > 0) kept.set("panel", "browser");
  const query = kept.toString();
  return <Navigate replace to={{ pathname: "/", search: query ? `?${query}` : "" }} />;
}
