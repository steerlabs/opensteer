import type { ChannelDelivery } from "@opensteer/channel-core";

/**
 * Slack's mrkdwn is not Markdown: bold is one asterisk, links carry their text
 * inside the angle brackets, and `&`, `<` and `>` must be escaped or Slack
 * reads them as its own markup. An agent writes Markdown, so it is translated
 * here — line by line, because fenced code, tables and list markers are line
 * facts, and inline, because emphasis and links are not.
 */
export function renderSlackMrkdwn(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const rendered: string[] = [];
  let inFence = false;
  let inTable = false;

  for (const line of lines) {
    if (/^\s*(?:`{3,}|~{3,})/u.test(line)) {
      if (inTable) {
        rendered.push("```");
        inTable = false;
      }
      inFence = !inFence;
      rendered.push(line);
      continue;
    }
    if (inFence) {
      rendered.push(line);
      continue;
    }
    // A Markdown table has no mrkdwn equivalent; Slack renders it legibly only
    // as preformatted text, where its column alignment survives.
    if (isTableLine(line)) {
      if (!inTable) {
        rendered.push("```");
        inTable = true;
      }
      rendered.push(line);
      continue;
    }
    if (inTable) {
      rendered.push("```");
      inTable = false;
    }
    rendered.push(renderLine(line));
  }
  if (inTable) rendered.push("```");
  if (inFence) rendered.push("```");
  return rendered.join("\n").trim();
}

/** The text one delivery posts. Artifact parts reach us already written as text. */
export function renderSlackDeliveryText(delivery: ChannelDelivery): string {
  const text = delivery.content
    .filter((part) => part.type === "text")
    .map((part) => renderSlackMrkdwn(part.text))
    .filter((part) => part.length > 0)
    .join("\n");
  return text.length > 0 ? text : "(No text content)";
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/u.test(line);
}

function renderLine(line: string): string {
  const quote = /^(\s*>+\s?)(.*)$/u.exec(line);
  if (quote) return `${quote[1]}${renderLine(quote[2] ?? "")}`;

  const heading = /^\s*(#{1,6})\s+(.*)$/u.exec(line);
  if (heading) {
    // The whole line becomes bold, so emphasis inside it would only nest a
    // second pair of asterisks Slack renders literally.
    const text = renderInline(heading[2] ?? "")
      .replace(/\*/gu, "")
      .trim();
    return text.length > 0 ? `*${text}*` : "";
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line);
  if (bullet) return `${bullet[1] ?? ""}• ${renderInline(bullet[2] ?? "")}`;

  // Numbered lists keep their own markers: Slack renders the digits as typed.
  const numbered = /^(\s*\d+[.)]\s+)(.*)$/u.exec(line);
  if (numbered) return `${numbered[1] ?? ""}${renderInline(numbered[2] ?? "")}`;

  return renderInline(line);
}

/** Split on inline code spans, which pass through untouched, and convert the rest. */
function renderInline(text: string): string {
  return text
    .split(/(`+[^`]*`+)/u)
    .map((segment, index) => (index % 2 === 1 ? segment : renderInlineText(segment)))
    .join("");
}

function renderInlineText(text: string): string {
  const escaped = text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const linked = escaped.replace(
    /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu,
    (_match, label: string, url: string) => (label.trim() ? `<${url}|${label}>` : `<${url}>`),
  );
  // One pass over every emphasis form, so a converted span is never re-read as
  // the next rule's input (`**bold**` becoming `*bold*` is not italic).
  return linked.replace(
    /\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/gsu,
    (match, bold?: string, altBold?: string, strike?: string, italic?: string) => {
      if (bold !== undefined) return `*${bold}*`;
      if (altBold !== undefined) return `*${altBold}*`;
      if (strike !== undefined) return `~${strike}~`;
      if (italic !== undefined) return `_${italic}_`;
      return match;
    },
  );
}
