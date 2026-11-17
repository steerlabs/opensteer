import { createHash } from "node:crypto";

// Reserve disjoint address roots without restricting the names people may register.
export function pluginNamespace(slug: string): string {
  return /^(?:local|plugin)-/u.test(slug)
    ? `plugin-${slug.slice(0, 23)}-${createHash("sha256").update(slug).digest("hex").slice(0, 32)}`
    : slug;
}

export function localNamespace(slug: string, id: string): string {
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 32);
  if (slug.startsWith("local-") && slug.endsWith(`-${suffix}`)) return slug;
  return `local-${slug.slice(0, 24).replace(/-+$/u, "")}-${suffix}`;
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
