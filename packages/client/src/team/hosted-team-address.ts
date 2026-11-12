import {
  HostedTeamSlugSchema,
  hostedTeamsDomain,
  maximumLiveHostedTeamsPerAccount,
  reservedHostedTeamSlugs,
  type HostedTeamAvailability,
} from "@opensteer/control-plane-protocol/hosted-teams";

/** The address a team name suggests until the person edits it: "Acme Design" → "acme-design". */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32)
    .replace(/-+$/u, "");
}

/** What someone types into the address field, kept to address characters as they type. */
export function slugFromTyping(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 32);
}

/** What can be said about an address before Account is asked, or null to ask. */
export function localAddressHint(
  slug: string,
): { readonly ok: false; readonly hint: string } | null {
  if (slug === "") return { ok: false, hint: "Lowercase letters, numbers and dashes." };
  if (slug.length < 3) return { ok: false, hint: "At least 3 characters." };
  if (reservedHostedTeamSlugs.has(slug)) return { ok: false, hint: "That address is reserved." };
  const parsed = HostedTeamSlugSchema.safeParse(slug);
  if (!parsed.success)
    return { ok: false, hint: parsed.error.issues[0]?.message ?? "That address can't be used." };
  return null;
}

export function availabilityHint(slug: string, answer: HostedTeamAvailability): string {
  if (answer.available) return `${slug}.${hostedTeamsDomain} is available`;
  if (answer.reason === "reserved") return "That address is reserved.";
  if (answer.reason === "taken") return "Someone already uses that address.";
  return "Use 3–32 lowercase letters, digits or hyphens.";
}

/** Account's refusal of a new team, in the person's words. */
export function createRefusal(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
  if (reason === "hosted-team-address-taken") return "Someone already uses that address.";
  if (reason === "hosted-team-limit-reached")
    return `You can have ${maximumLiveHostedTeamsPerAccount} teams at a time. Delete one to make another.`;
  return error instanceof Error && error.message ? error.message : "The team wasn't created.";
}
