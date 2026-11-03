import { redirectSettingsPath } from "@opensteer/client/settings";
import { Navigate, useLocation } from "react-router";

/** Existing bookmarks and OAuth callbacks retain their suffix, query, and fragment. */
export function SettingsRedirect({ from, to }: { readonly from: string; readonly to: string }) {
  const location = useLocation();
  return (
    <Navigate
      replace
      to={
        redirectSettingsPath(`${location.pathname}${location.search}${location.hash}`) ??
        `${to}${location.pathname.slice(from.length)}${location.search}${location.hash}`
      }
    />
  );
}
