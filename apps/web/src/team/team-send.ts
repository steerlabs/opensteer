import type { TeamMember } from "@opensteer/protocol";

export interface TeamMention {
  readonly userId: string;
  readonly kind: "person" | "agent";
}

const mentionLimit = 20;

/**
 * What a composer's words become on the wire. `@handle` names a person and
 * `@handle-agent` names that person's agent. Asking one's own agent puts its
 * handle first, so everyone reads who was asked; anyone else's agent is only
 * a reference, which the team server never wakes.
 */
export function teamMessage(
  input: { readonly body: string; readonly toMyAgent: boolean },
  me: Pick<TeamMember, "userId" | "handle">,
  members: ReadonlyMap<string, Pick<TeamMember, "userId" | "handle">>,
): { readonly bodyMarkdown: string; readonly mentions: readonly TeamMention[] } {
  const ownAgent = `@${me.handle}-agent`;
  const named = new RegExp(`(^|\\s)${ownAgent.replace(/[-]/gu, "\\-")}(?=$|[\\s.,;:!?])`, "u");
  const bodyMarkdown =
    input.toMyAgent && !named.test(input.body) ? `${ownAgent} ${input.body}`.trim() : input.body;
  const byHandle = new Map([...members.values(), me].map((member) => [member.handle, member]));
  const mentions = new Map<string, TeamMention>();
  for (const match of bodyMarkdown.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/gu)) {
    const handle = match[1]!;
    const person = byHandle.get(handle);
    const owner = handle.endsWith("-agent") ? byHandle.get(handle.slice(0, -6)) : undefined;
    const mention: TeamMention | null = person
      ? { userId: person.userId, kind: "person" }
      : owner
        ? { userId: owner.userId, kind: "agent" }
        : null;
    if (mention) mentions.set(`${mention.kind}:${mention.userId}`, mention);
  }
  return { bodyMarkdown, mentions: [...mentions.values()].slice(0, mentionLimit) };
}
