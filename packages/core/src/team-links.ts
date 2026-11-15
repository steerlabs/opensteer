import { z } from "zod";
import { opensteerNativeClient, type OpensteerNativeApplication } from "./identity.js";
import {
  DeploymentIdSchema,
  KnowledgeTopicIdSchema,
  KnowledgeNoteIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  TeamNoticeIdSchema,
} from "./ids.js";

export const TeamOriginSchema = z.url().refine((value) => {
  // A refinement still runs after `z.url()` rejects, so a non-URL must fail here, not throw.
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
}, "Team origin must be a canonical HTTPS origin");
/**
 * What an invite link carries: the selector names the invite row, the verifier proves possession.
 * The verifier travels only in a URL fragment or a request body, never a path, query or log.
 */
export const TeamInviteSecretSchema = z.strictObject({
  selector: z.string().regex(/^[A-Za-z0-9_-]{24,96}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),
});
export type TeamInviteSecret = z.infer<typeof TeamInviteSecretSchema>;
export const TeamPageTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("invite"), ...TeamInviteSecretSchema.shape }),
  z.strictObject({ kind: z.literal("channel"), channelId: TeamChannelIdSchema }),
  z.strictObject({
    kind: z.literal("message"),
    channelId: TeamChannelIdSchema,
    messageId: TeamMessageIdSchema,
  }),
  z.strictObject({
    kind: z.literal("thread"),
    channelId: TeamChannelIdSchema,
    threadRootId: TeamMessageIdSchema,
    messageId: TeamMessageIdSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("knowledge-topic"), topicId: KnowledgeTopicIdSchema }),
  z.strictObject({
    kind: z.literal("knowledge-note"),
    topicId: KnowledgeTopicIdSchema,
    noteId: KnowledgeNoteIdSchema,
  }),
]);
export type TeamPageTarget = z.infer<typeof TeamPageTargetSchema>;
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
    case "thread":
      return `${origin}/c/${target.channelId}/t/${target.threadRootId}${target.messageId ? `/m/${target.messageId}` : ""}`;
    case "knowledge-topic":
      return `${origin}/knowledge/${target.topicId}`;
    case "knowledge-note":
      return `${origin}/knowledge/${target.topicId}?note=${target.noteId}`;
  }
}
export function parseTeamPageLink(value: string): TeamPageLink | null {
  try {
    const url = new URL(value);
    if (
      /[\p{Cc}\s]/u.test(value) ||
      url.username ||
      url.password ||
      !TeamOriginSchema.safeParse(url.origin).success
    )
      return null;
    const hasQuery = value.includes("?");
    const hasFragment = value.includes("#");
    const parts = url.pathname.split("/");
    let target: unknown = null;
    if (parts.length === 3 && parts[1] === "knowledge" && !hasFragment) {
      if (!hasQuery) target = { kind: "knowledge-topic", topicId: parts[2] };
      else if (url.searchParams.size === 1 && url.searchParams.has("note"))
        target = {
          kind: "knowledge-note",
          topicId: parts[2],
          noteId: url.searchParams.get("note"),
        };
    } else if (!hasQuery) {
      if (parts.length === 3 && parts[1] === "invite")
        target = { kind: "invite", selector: parts[2], verifier: url.hash.slice(1) };
      else if (!hasFragment && parts[1] === "c") {
        if (parts.length === 3) target = { kind: "channel", channelId: parts[2] };
        else if (parts.length === 5 && parts[3] === "m")
          target = { kind: "message", channelId: parts[2], messageId: parts[4] };
        else if (
          (parts.length === 5 || (parts.length === 7 && parts[5] === "m")) &&
          parts[3] === "t"
        )
          target = {
            kind: "thread",
            channelId: parts[2],
            threadRootId: parts[4],
            ...(parts.length === 7 ? { messageId: parts[6] } : {}),
          };
      }
    }
    const parsed = TeamPageLinkSchema.safeParse({ origin: url.origin, target });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** The team Host's native OAuth authorization endpoint. */
export const teamNativeAuthorizePath = "/v1/auth/native/oauth2/authorize";
/**
 * The team's invite page, told to prove `invite` in this browser and then continue to the native
 * sign-in `authorization` names, so the team's sign-in callback finds the invite's admission.
 */
export function teamInviteSignInUrl(authorization: string, invite: TeamInviteSecret): string {
  const url = new URL(authorization);
  if (url.pathname !== teamNativeAuthorizePath || url.hash || url.username || url.password)
    throw new Error("Only the team's native sign-in can follow an invite.");
  const { selector, verifier } = TeamInviteSecretSchema.parse(invite);
  return `${url.origin}/invite/${selector}?${new URLSearchParams({ authorize: url.search.slice(1) })}#${verifier}`;
}
/** Each application claims its own scheme, so a link opens exactly the app it names. */
export function teamAppScheme(application: OpensteerNativeApplication): string {
  return opensteerNativeClient(application).applicationId;
}
/** `<scheme>:/team?url=<team page URL>`: the one app link for team pages. */
export function teamPageAppLink(
  link: TeamPageLink,
  application: OpensteerNativeApplication,
): string {
  return `${teamAppScheme(application)}:/team?${new URLSearchParams({ url: teamPageUrl(link) })}`;
}
export function parseTeamPageAppLink(
  value: string,
  application: OpensteerNativeApplication,
): TeamPageLink | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${teamAppScheme(application)}:` ||
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

export const TeamNoticeLinkSchema = z.strictObject({
  origin: TeamOriginSchema,
  teamId: DeploymentIdSchema,
  noticeId: TeamNoticeIdSchema,
});
export type TeamNoticeLink = z.infer<typeof TeamNoticeLinkSchema>;

export function teamNoticeAppLink(input: TeamNoticeLink, applicationScheme: string): string {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(applicationScheme))
    throw new Error("Invalid application scheme");
  const link = TeamNoticeLinkSchema.parse(input);
  return `${applicationScheme}:/team-notice?${new URLSearchParams(link)}`;
}

export function parseTeamNoticeAppLink(
  value: string,
  applicationScheme: string,
): TeamNoticeLink | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${applicationScheme}:` ||
      url.host ||
      url.pathname !== "/team-notice" ||
      value.includes("#") ||
      url.searchParams.size !== 3
    )
      return null;
    const parsed = TeamNoticeLinkSchema.safeParse({
      origin: url.searchParams.get("origin"),
      teamId: url.searchParams.get("teamId"),
      noticeId: url.searchParams.get("noticeId"),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
