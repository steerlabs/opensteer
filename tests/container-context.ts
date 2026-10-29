/** Strict subset shared by the upload and COPY guards; unsupported syntax fails closed. */
export function excludedFromContext(upload: string, docker = ""): (name: string) => boolean {
  const layers = [upload, docker].map((text, index) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && (!line.startsWith("#") || line.startsWith("#!")))
      .map((line) => {
        // The only supported exception is the public template needed by COPY.
        const include = index === 0 && line === "!**/.env.example";
        return { include, pattern: contextPattern(include ? line.slice(1) : line, index === 0) };
      }),
  );
  const excluded = (name: string) =>
    layers.some((rules) => {
      // An exception cannot reopen a file below an excluded parent directory.
      const parts = name.split("/");
      return parts.some((_part, index) => {
        const ancestor = parts.slice(0, index + 1).join("/");
        return rules.reduce(
          (excluded, rule) => (rule.pattern.test(ancestor) ? !rule.include : excluded),
          false,
        );
      });
    });
  return excluded;
}

export function contextPattern(pattern: string, anywhere = false): RegExp {
  // Only today's positive, relative patterns: literals, *, and a leading **/.
  const recursive = pattern.startsWith("**/");
  const tail = recursive ? pattern.slice(3) : pattern;
  if (!/^[\w.*-]+(?:\/[\w.*-]+)*$/u.test(tail) || /\*\*|(?:^|\/)\.{1,2}(?:\/|$)/u.test(tail))
    throw new Error(`Unsupported COPY/ignore pattern: ${pattern}`);
  const body = tail.replaceAll(".", "\\.").replaceAll("*", "[^/]*");
  const prefix = recursive || (anywhere && !pattern.includes("/")) ? "(?:.*/)?" : "";
  return new RegExp(`^${prefix}${body}(?:/|$)`, "u");
}
