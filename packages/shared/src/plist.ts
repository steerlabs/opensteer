/** A property list of strings, booleans, integers and string arrays. */
export function plist(entries: Readonly<Record<string, unknown>>): string {
  const escape = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const value = (item: unknown): string => {
    if (typeof item === "boolean") return `<${String(item)}/>`;
    if (typeof item === "string") return `<string>${escape(item)}</string>`;
    if (Number.isSafeInteger(item)) return `<integer>${String(item)}</integer>`;
    if (Array.isArray(item)) return `<array>${item.map(value).join("")}</array>`;
    throw new Error("Unsupported property list value.");
  };
  const body = Object.entries(entries)
    .map(([key, item]) => `\t<key>${escape(key)}</key>\n\t${value(item)}`)
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
    `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
  );
}
