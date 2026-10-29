interface CodeFence {
  readonly opening: string;
  readonly marker: string;
}

/**
 * Split Markdown within the provider's hard UTF-16 limit, preferring whole
 * lines. Fences that leave room for content are closed and reopened at each
 * boundary. Oversized fence syntax is ordinary text: no delimiter can make
 * a part exceed the delivery limit.
 */
export function splitMessageText(text: string, maxChars: number): readonly string[] {
  if (!Number.isInteger(maxChars) || maxChars < 8) {
    throw new RangeError("Message parts need room for a code fence");
  }
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (normalized.length <= maxChars) return [normalized];

  const parts: string[] = [];
  let current = "";
  let fence: CodeFence | null = null;
  const flush = () => {
    const part = fence ? `${current}\n${fence.marker}` : current.trimEnd();
    if (part.length > 0) parts.push(part);
    current = fence?.opening ?? "";
  };

  for (const line of normalized.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    const marker = match?.[1];
    if (
      fence &&
      marker &&
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      match?.[2]?.trim() === ""
    ) {
      // The reserved closing delimiter already fits. A longer closing run
      // has the same Markdown meaning, so use the opening run's length.
      current += `\n${fence.marker}`;
      fence = null;
      continue;
    }
    const opening: CodeFence | null =
      !fence &&
      marker &&
      !(marker[0] === "`" && match?.[2]?.includes("`")) &&
      line.length + marker.length + 4 <= maxChars
        ? { opening: line, marker }
        : null;
    if (opening) {
      if (current.length + 1 + line.length + 1 + opening.marker.length > maxChars) flush();
      current += current.length > 0 ? `\n${line}` : line;
      fence = opening;
      continue;
    }

    let rest = line;
    const closingRoom = fence ? fence.marker.length + 1 : 0;
    const freshRoom = maxChars - (fence ? fence.opening.length + 1 : 0) - closingRoom;
    // Prefer a whole line on the next part when it can fit there. Otherwise
    // fill the space left here before cutting the line.
    if (
      current &&
      current.length + 1 + rest.length + closingRoom > maxChars &&
      rest.length <= freshRoom
    )
      flush();
    for (;;) {
      const separator = current.length > 0 ? "\n" : "";
      const room = maxChars - current.length - separator.length - closingRoom;
      if (rest.length <= room) {
        current += separator + rest;
        break;
      }
      let cut = Math.max(0, room);
      const space = rest.lastIndexOf(" ", cut - 1);
      if (cut > 0 && space >= cut / 2) cut = space + 1;
      // A fresh part always fits a full code point. If this one cannot, flush
      // without consuming input; the next iteration must make progress.
      if (cut > 0 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
      if (cut > 0) {
        current += separator + rest.slice(0, cut);
        rest = rest.slice(cut);
      }
      flush();
    }
  }
  if (current.length > 0) flush();
  return parts;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
