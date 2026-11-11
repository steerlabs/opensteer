import { z } from "zod";
import { TeamChannelIdSchema, TeamMessageIdSchema } from "./ids.js";

export const TeamOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
}, "Team origin must be a canonical HTTPS origin");
export const TeamPageTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("invite"),
    selector: z.string().regex(/^[A-Za-z0-9_-]{24,96}$/),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),
  }),
  z.strictObject({ kind: z.literal("channel"), channelId: TeamChannelIdSchema }),
  z.strictObject({
    kind: z.literal("message"),
    channelId: TeamChannelIdSchema,
    messageId: TeamMessageIdSchema,
  }),
]);
export const TeamPageLinkSchema = z.strictObject({
  origin: TeamOriginSchema,
  target: TeamPageTargetSchema,
});
export type TeamPageLink = z.infer<typeof TeamPageLinkSchema>;
export function teamPageUrl(link: TeamPageLink): string {
  const { origin, target } = TeamPageLinkSchema.parse(link);
  switch (target.kind) {
    case "invite":
      return `${origin}/invite/${target.selector}#${target.verifier}`;
    case "channel":
      return `${origin}/c/${target.channelId}`;
    case "message":
      return `${origin}/c/${target.channelId}/m/${target.messageId}`;
  }
}
export function parseTeamPageLink(value: string): TeamPageLink | null {
  try {
    const url = new URL(value);
    if (
      url.search ||
      url.username ||
      url.password ||
      !TeamOriginSchema.safeParse(url.origin).success
    )
      return null;
    const parts = url.pathname.split("/");
    const target =
      parts.length === 3 && parts[1] === "invite"
        ? { kind: "invite", selector: parts[2], verifier: url.hash.slice(1) }
        : !url.hash && parts.length === 3 && parts[1] === "c"
          ? { kind: "channel", channelId: parts[2] }
          : !url.hash && parts.length === 5 && parts[1] === "c" && parts[3] === "m"
            ? { kind: "message", channelId: parts[2], messageId: parts[4] }
            : null;
    const parsed = TeamPageLinkSchema.safeParse({ origin: url.origin, target });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function teamPageAppLink(link: TeamPageLink, applicationScheme: string): string {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(applicationScheme))
    throw new Error("Invalid application scheme");
  return `${applicationScheme}:/team?${new URLSearchParams({ url: teamPageUrl(link) })}`;
}
export function parseTeamPageAppLink(
  value: string,
  applicationScheme: string,
): TeamPageLink | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${applicationScheme}:` ||
      url.host ||
      url.pathname !== "/team" ||
      url.hash ||
      url.searchParams.size !== 1
    )
      return null;
    const page = url.searchParams.get("url");
    return page === null ? null : parseTeamPageLink(page);
  } catch {
    return null;
  }
}
