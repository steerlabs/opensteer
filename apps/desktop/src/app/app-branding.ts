export function resolveDesktopAppBranding(version: string): {
  displayName: string;
  track: "beta" | "stable";
} {
  const track = version.endsWith("-insider") ? "beta" : "stable";
  return { displayName: track === "beta" ? "Opensteer (Beta)" : "Opensteer", track };
}
