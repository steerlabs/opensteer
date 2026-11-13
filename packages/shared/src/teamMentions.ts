export interface TeamMention<UserId extends string = string> {
  readonly userId: UserId;
  readonly kind: "person" | "agent";
}

const mentionLimit = 20;

export function teamMessage<UserId extends string>(
  input: { readonly body: string; readonly toMyAgent: boolean },
  me: { readonly userId: UserId; readonly handle: string },
  members: ReadonlyMap<string, { readonly userId: UserId; readonly handle: string }>,
): { readonly bodyMarkdown: string; readonly mentions: readonly TeamMention<UserId>[] } {
  const ownAgent = `@${me.handle}-agent`;
  // Handles are [a-z0-9-], so the handle needs no escaping in a pattern.
  const named = new RegExp(`(^|\\s)${ownAgent}(?=$|[\\s.,;:!?])`, "u");
  const bodyMarkdown =
    input.toMyAgent && !named.test(input.body) ? `${ownAgent} ${input.body}`.trim() : input.body;
  return { bodyMarkdown, mentions: teamMentions(bodyMarkdown, [...members.values(), me]) };
}

export function teamMentions<UserId extends string>(
  bodyMarkdown: string,
  members: Iterable<{ readonly userId: UserId; readonly handle: string }>,
): readonly TeamMention<UserId>[] {
  const byHandle = new Map([...members].map((member) => [member.handle, member]));
  const mentions = new Map<string, TeamMention<UserId>>();
  for (const handle of teamMentionHandles(bodyMarkdown)) {
    const person = byHandle.get(handle);
    const owner = handle.endsWith("-agent") ? byHandle.get(handle.slice(0, -6)) : undefined;
    const mention: TeamMention<UserId> | null = person
      ? { userId: person.userId, kind: "person" }
      : owner
        ? { userId: owner.userId, kind: "agent" }
        : null;
    if (mention) mentions.set(`${mention.kind}:${mention.userId}`, mention);
  }
  return [...mentions.values()].slice(0, mentionLimit);
}

export function teamMentionHandles(bodyMarkdown: string): readonly string[] {
  return [...bodyMarkdown.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/gu)].map(
    (match) => match[1]!,
  );
}
