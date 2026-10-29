import { Navigate, useLocation } from "react-router";

/** Existing bookmarks and OAuth callbacks retain their suffix, query, and fragment. */
export function SettingsRedirect({ from, to }: { readonly from: string; readonly to: string }) {
  const location = useLocation();
  return (
    <Navigate
      replace
      to={`${to}${location.pathname.slice(from.length)}${location.search}${location.hash}`}
    />
  );
}
