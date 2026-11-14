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

export function classifyMarkdownImageSource(source: string): MarkdownImageSource {
  void source;
  throw new Error("classifyMarkdownImageSource is implemented by the harness builder");
}

/** Append `![](<path>)` for each path the reply does not already embed. */
export function appendImageEmbeds(markdown: string, paths: readonly string[]): string {
  void markdown;
  void paths;
  throw new Error("appendImageEmbeds is implemented by the harness builder");
}

/** Replace every local-file image with its alt text, for text leaving this computer. */
export function stripLocalImageEmbeds(markdown: string): string {
  void markdown;
  throw new Error("stripLocalImageEmbeds is implemented by the harness builder");
}
