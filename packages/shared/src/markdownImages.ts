import type { Nodes } from "mdast";
import { markdownSourceTree as parse } from "./markdownParser.js";
import { isNetworkPath } from "./fileHref.js";
export { isNetworkPath } from "./fileHref.js";

/**
 * Markdown image handling shared by the Runner (embedding generated images in
 * a reply), the Host (keeping local paths out of team and bridge text) and
 * every client (deciding what an image source may load). Browser-safe.
 */

/**
 * What a markdown image source may become. `local` is a file on the hosting
 * computer, served only through the Host's `asset.urls`; `remote` is an
 * internet address, which is never loaded automatically; `none` stays words.
 */
export type MarkdownImageSource =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "remote"; readonly url: string }
  | { readonly kind: "none" };

/** Renderers hand over a percent-encoded destination; the file's name is decoded once. */
export function classifyMarkdownImageSource(source: string): MarkdownImageSource {
  const trimmed = source.trim();
  if (/^https?:/i.test(trimmed)) return { kind: "remote", url: trimmed };
  let path = trimmed;
  if (!/^file:/i.test(path))
    try {
      path = decodeURIComponent(path);
    } catch {
      /* A malformed escape is part of the name. */
    }
  if (!path || isNetworkPath(path)) return { kind: "none" };
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return { kind: "none" };
      return { kind: "local", path };
    } catch {
      return { kind: "none" };
    }
  }
  if (/^[a-z]:[\\/]/i.test(path)) return { kind: "local", path };
  return /^[a-z][a-z\d+.-]*:/i.test(path) ? { kind: "none" } : { kind: "local", path };
}

function isWindowsDrivePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path);
}
function isUncPath(path: string): boolean {
  return path.startsWith("\\\\");
}
function key(path: string, encoded = false): string {
  let value = path;
  try {
    if (encoded) value = decodeURIComponent(value);
  } catch {
    /* Keep malformed escapes literal. */
  }
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      value = url.hostname ? `//${url.hostname}${url.pathname}` : url.pathname;
    } catch {
      /* Keep literal path. */
    }
    if (/^\/[a-z]:/i.test(value)) value = value.slice(1);
  }
  if (isWindowsDrivePath(value) || isUncPath(value) || value.startsWith("//"))
    return value.replaceAll("\\", "/").toLowerCase();
  return value;
}
function imageNodes(markdown: string) {
  const tree = parse(markdown);
  const definitions = new Map<string, string>();
  const walk = (node: Nodes, visit: (node: Nodes) => void): void => {
    visit(node);
    if ("children" in node) for (const child of node.children) walk(child, visit);
  };
  walk(tree, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
  });
  const images: { url: string; alt: string; start: number; end: number }[] = [];
  walk(tree, (node) => {
    if (node.type !== "image" && node.type !== "imageReference") return;
    const url = node.type === "image" ? node.url : definitions.get(node.identifier);
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (url !== undefined && start !== undefined && end !== undefined)
      images.push({ url, alt: node.alt ?? "", start, end });
  });
  return images;
}
function imageEmbed(path: string): string {
  // Forward slashes read the same in every client parser; UNC paths also need file: to
  // distinguish them from protocol-relative web URLs.
  const destination = isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
  // Clients split `?`/`#`, decode `%` and `&` entities, and read POSIX backslashes as escapes;
  // line breaks end an angle destination.
  const escaped = destination.replace(/[%?#&\\\r\n]/g, encodeURIComponent).replace(/[<>]/g, "\\$&");
  return `![](<${escaped}>)`;
}

// An unclosed fence or raw HTML block swallows the rest of the reply. Only a root-level block
// can swallow appended embeds; nested ones end with their container.
function unclosedBlockEnd(text: string): string | undefined {
  const last = parse(text).children.at(-1);
  const source = text.slice(last?.position?.start.offset, last?.position?.end.offset);
  if (last?.type === "html") {
    const tag = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(source)?.[1];
    if (tag !== undefined) {
      return /<\/(?:script|pre|style|textarea)>/i.test(source) ? undefined : `</${tag}>`;
    }
    return /^ {0,3}<!--/.test(source) && !source.includes("-->") ? "-->" : undefined;
  }
  if (last?.type !== "code") return undefined;
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(source)?.[1];
  if (fence === undefined) return undefined;
  const lines = source.split(/\r\n|\r|\n/);
  const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(lines.at(-1) ?? "")?.[1];
  const closed =
    lines.length > 1 &&
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length;
  return closed ? undefined : fence;
}

export function appendImageEmbeds(markdown: string, paths: readonly string[]): string {
  const shown = new Set(imageNodes(markdown).map((image) => key(image.url, true)));
  const missing = paths.filter((path) => {
    const id = key(path);
    if (shown.has(id)) return false;
    shown.add(id);
    return true;
  });
  if (!missing.length) return markdown;
  const end = unclosedBlockEnd(markdown);
  let result =
    end === undefined ? markdown : `${markdown}${/[\r\n]$/.test(markdown) ? "" : "\n"}${end}`;
  for (const path of missing) result += `${result ? "\n\n" : ""}${imageEmbed(path)}`;
  return result;
}
export function stripLocalImageEmbeds(markdown: string): string {
  let result = markdown;
  const replacements = imageNodes(markdown).filter(
    (image) =>
      classifyMarkdownImageSource(image.url).kind === "local" ||
      /^file:/i.test(image.url) ||
      isUncPath(image.url),
  );
  const localUrls = new Set(replacements.map((image) => image.url));
  const gather = (node: Nodes): void => {
    if (
      node.type === "definition" &&
      localUrls.has(node.url) &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    )
      replacements.push({
        url: node.url,
        alt: "",
        start: node.position.start.offset,
        end: node.position.end.offset,
      });
    if ("children" in node) node.children.forEach(gather);
  };
  gather(parse(markdown));
  for (const image of replacements.sort((a, b) => b.start - a.start)) {
    // Network file references must not leak out either, even though clients refuse them.
    if (
      classifyMarkdownImageSource(image.url).kind !== "local" &&
      !/^file:/i.test(image.url) &&
      !isUncPath(image.url)
    )
      continue;
    result = result.slice(0, image.start) + image.alt + result.slice(image.end);
  }
  return result;
}
