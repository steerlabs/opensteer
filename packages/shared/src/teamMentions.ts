import { markdownSourceTree, visitMarkdownSource } from "./markdownParser.js";

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
  const named = teamMentionHandles(input.body).includes(`${me.handle}-agent`);
  const bodyMarkdown = input.toMyAgent && !named ? `${ownAgent} ${input.body}`.trim() : input.body;
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
  return teamMentionHandleRanges(bodyMarkdown).map(({ handle }) => handle);
}

/** Source offsets keep escapes and replacement boundaries meaningful to sanitation. */
export function teamMentionHandleRanges(
  bodyMarkdown: string,
): readonly { handle: string; start: number; end: number }[] {
  if (!bodyMarkdown.includes("@")) return [];
  const ranges: { start: number; end: number }[] = [];
  visitMarkdownSource(markdownSourceTree(bodyMarkdown), (node) => {
    if (["link", "linkReference", "image", "imageReference", "definition"].includes(node.type))
      return false;
    if (node.type === "text") {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    }
    return true;
  });
  const matches: { handle: string; start: number; end: number }[] = [];
  let rangeIndex = 0;
  for (const match of bodyMarkdown.matchAll(/(?:^|\s)@([a-z0-9]+(?:-[a-z0-9]+)*)/gu)) {
    const start = match.index + match[0].indexOf("@");
    const end = start + match[1]!.length + 1;
    while (ranges[rangeIndex] && ranges[rangeIndex]!.end <= start) rangeIndex++;
    const range = ranges[rangeIndex];
    if (range && start >= range.start && end <= range.end)
      matches.push({ handle: match[1]!, start, end });
  }
  return matches;
}
