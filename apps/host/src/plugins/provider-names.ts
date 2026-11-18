import { createHash } from "node:crypto";

// Local tools and plugins get disjoint address roots, so neither can take the other's name.
// The short identity suffix keeps a local tool's address stable when another one shares its name.
const suffix = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

export function isLocalProviderId(id: string): boolean {
  return id.startsWith("app_device_") || id.startsWith("app_server_");
}

export function pluginNamespace(slug: string): string {
  return /^(?:local|plugin)-/u.test(slug) ? `plugin-${slug.slice(0, 45)}-${suffix(slug)}` : slug;
}

export function localNamespace(slug: string, id: string): string {
  const end = `-${suffix(id)}`;
  if (slug.startsWith("local-") && slug.endsWith(end)) return slug;
  return `local-${slug.slice(0, 48).replace(/-+$/u, "")}${end}`;
}

/** The engine's address rule: a DNS label, never one of its reserved roots. */
export function slugify(value: string): string {
  const label = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
  return !label || ["search", "constructor", "prototype", "then"].includes(label)
    ? `local-${label || "tool"}`
    : label;
}

// The engine renders canonical tool names as JavaScript dot/bracket expressions.
export function localToolPath(slug: string, tool: string): string {
  return (
    "tools" +
    `${slug}.${tool}`
      .split(".")
      .map((segment) =>
        /^[A-Za-z_$][\w$]*$/u.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
      )
      .join("")
  );
}
