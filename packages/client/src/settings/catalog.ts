import type { PluginRow, PluginsDirectoryView } from "@opensteer/protocol";

export type PluginCatalogEntry = PluginsDirectoryView["catalog"][number];

/** One thing a person can add, with every way the catalog offers to reach it. */
export interface PluginCatalogProduct {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string | null;
  readonly popular: boolean;
  /** The default way in first. */
  readonly variants: readonly [PluginCatalogEntry, ...PluginCatalogEntry[]];
}

const categoryLabels: Readonly<Record<string, string>> = {
  communication: "Communication",
  work: "Work",
  developer: "Developer tools",
  web: "Web, AI and data",
  devices: "On your devices",
};

/** Browsing categories, in the order a Host listed its products. */
export function pluginCatalogCategories(
  products: readonly PluginCatalogProduct[],
): readonly { readonly id: string; readonly label: string }[] {
  const ids = [...new Set(products.flatMap(({ category }) => (category ? [category] : [])))];
  return ids.map((id) => ({ id, label: pluginCategoryLabel(id) }));
}

export function pluginCategoryLabel(id: string): string {
  return categoryLabels[id] ?? id[0]!.toUpperCase() + id.slice(1).replaceAll("-", " ");
}

/**
 * The directory's entries as products, in the Host's order. An entry without a
 * product (a Host before product listings) is a product of its own.
 */
export function pluginCatalogProducts(
  catalog: readonly PluginCatalogEntry[],
): PluginCatalogProduct[] {
  const products = new Map<string, PluginCatalogEntry[]>();
  for (const entry of catalog) {
    const id = entry.product?.id ?? entry.definitionId;
    products.set(id, [...(products.get(id) ?? []), entry]);
  }
  return [...products].map(([id, entries]) => {
    const first = entries.find((entry) => entry.definitionId === id) ?? entries[0]!;
    const variants = [first, ...entries.filter((entry) => entry !== first)] as const;
    return {
      id,
      title: first.product?.title ?? first.title,
      description: first.description,
      category: first.product?.category ?? null,
      popular: first.product?.popular ?? false,
      variants,
    };
  });
}

/** What the person can still add: products none of whose ways in is already theirs. */
export function pluginCatalogToAdd(
  products: readonly PluginCatalogProduct[],
  rows: readonly PluginRow[],
): PluginCatalogProduct[] {
  const yours = new Set(
    rows.flatMap(({ target }) =>
      target.kind === "service" || target.kind === "device-app" ? [target.definitionId] : [],
    ),
  );
  return products.filter(({ variants }) => !variants.some((v) => yours.has(v.definitionId)));
}

/** A remote MCP server's name, from what a person calls it: "My CRM!" is "my-crm". */
export function remoteMcpSlug(title: string): string {
  const slug = title
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/gu, "");
  return slug || "mcp-server";
}

export function pluginCatalogMatches(product: PluginCatalogProduct, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  return [
    product.title,
    product.description,
    product.category && pluginCategoryLabel(product.category),
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(term);
}
