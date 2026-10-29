import { modelLabLabels } from "@opensteer/core";

/**
 * Canonical provider ids are open-ended, so unknown labs keep a readable name.
 * The registry names every lab the product knows — "MiniMax", "OpenCode",
 * "Z.ai" — and title-casing is only for a provider id nobody has named yet.
 */
export function providerLabel(providerId: string): string {
  const known = modelLabLabels[providerId];
  if (known !== undefined) return known;
  return providerId
    .split(/([._-])/u)
    .map((part) =>
      /^[._-]$/u.test(part) ? part : part.charAt(0).toLocaleUpperCase() + part.slice(1),
    )
    .join("");
}
