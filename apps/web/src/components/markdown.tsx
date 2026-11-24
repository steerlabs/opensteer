import { useTranscriptImages } from "@opensteer/client/react";
import { classifyHref } from "@opensteer/core";
import { classifyMarkdownImageSource } from "@opensteer/shared/markdownImages";
import { personMarkdownGfmOptions, personMarkdownTree } from "@opensteer/shared/personMarkdown";
import { AssetImage } from "./asset-image.js";
import {
  isValidElement,
  memo,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactElement,
} from "react";
import drawMarkdown, { type Components, type Options, type UrlTransform } from "react-markdown";

type PluggableList = NonNullable<Options["remarkPlugins"]>;
import remarkGfm from "remark-gfm";
import {
  hideIncompleteLinkTail,
  repairStrong,
  splitMarkdownBlocks,
} from "@opensteer/shared/markdown";
import { BoundedCache } from "@opensteer/shared/boundedCache";
import { CopyMark } from "./copy-mark.js";
import { markdownHighlight } from "./markdown-highlight.js";
import { remarkChipPunctuation } from "./references/chip-punctuation.js";
import { ReferenceLink } from "./references/reference-link.js";

type MarkdownTree = Parameters<typeof repairStrong>[0];
export type MarkdownProfile = "assistant" | "person";

const remarkRepairStrong = () => (tree: MarkdownTree) => repairStrong(tree);
const remarkRepairStreaming = () => (tree: MarkdownTree) => repairStrong(tree, { streaming: true });
const remarkPersonWords = () => (tree: MarkdownTree) => void personMarkdownTree(tree);

const remarkPlugins = [remarkGfm, remarkRepairStrong, remarkChipPunctuation];
const streamingRemarkPlugins = [remarkGfm, remarkRepairStreaming, remarkChipPunctuation];
// A person's words: no single-tilde strikethrough, and raw HTML or line breaks read as typed.
const personRemarkPlugins: PluggableList = [
  [remarkGfm, personMarkdownGfmOptions],
  remarkPersonWords,
  remarkChipPunctuation,
];
const noRehypePlugins: [] = [];
const rehypePlugins: PluggableList = [[markdownHighlight, { streaming: false }]];
const streamingRehypePlugins: PluggableList = [[markdownHighlight, { streaming: true }]];

function TranscriptImage({ alt, src }: ComponentProps<"img">) {
  const images = useTranscriptImages();
  const source = classifyMarkdownImageSource(typeof src === "string" ? src : "");
  // Internet images stay words: loading one could carry a secret out.
  if (images && source.kind === "local") return <AssetImage path={source.path} alt={alt ?? ""} />;
  const words = alt || (typeof src === "string" ? src : "");
  return words ? <span>{words}</span> : null;
}

/** A fence tagged `draft` is words the person will send as their own, so it reads as words. */
function isDraft(children: ComponentProps<"pre">["children"]): boolean {
  return (
    isValidElement<{ className?: string }>(children) &&
    children.props.className?.split(" ").includes("language-draft") === true
  );
}

/** Code or a draft in a reading column, where its copy mark has no gutter to stand in. */
function TranscriptBlock({ children }: ComponentProps<"pre">) {
  const words = useRef<HTMLPreElement | null>(null);
  const draft = isDraft(children);
  return (
    <div className={draft ? "md-block md-block--draft" : "md-block"}>
      <pre ref={words}>{children}</pre>
      <CopyMark
        className="md-block__copy"
        label={draft ? "Copy draft" : "Copy code"}
        text={() => words.current?.textContent?.replace(/\n$/u, "") ?? ""}
      />
    </div>
  );
}

/** A block cut short: copying it would hand over part as if it were whole. */
function ExcerptBlock({ children }: ComponentProps<"pre">) {
  return (
    <div className={isDraft(children) ? "md-block md-block--draft" : "md-block"}>
      <pre>{children}</pre>
    </div>
  );
}

const bareComponents: Components = { a: ReferenceLink, img: TranscriptImage };
const components: Components = { ...bareComponents, pre: TranscriptBlock };
const excerptComponents: Components = { ...bareComponents, pre: ExcerptBlock };

/**
 * A link keeps its destination only when it is one Opensteer knows how to
 * open; the link decides what it becomes. An image's address is only ever
 * loaded through the Host or shown as words, so it keeps the writer's spelling.
 */
const urlTransform: UrlTransform = (url, key, node) =>
  node.tagName === "img" && key === "src" ? url : classifyHref(url).kind === "none" ? "" : url;

/**
 * Markdown an agent or a person wrote. Blocks are memoized so a streaming
 * message only redraws its trailing block; their index is their key, so that
 * block keeps its place, and a selection in it, as it grows. Only that block
 * holds back a link whose destination is still arriving. `bare` is for code
 * that is a bubble of its own, whose copy mark stands beside it; code held in
 * words keeps its own. `person` reads a person's words as they typed them.
 * `excerpt` is for text cut short, whose blocks offer no copy.
 */
export const Markdown = memo(function Markdown({
  bare = false,
  excerpt = false,
  profile = "assistant",
  streaming = false,
  text,
}: {
  bare?: boolean;
  excerpt?: boolean;
  profile?: MarkdownProfile;
  streaming?: boolean;
  text: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  const variant = bare ? "bare" : excerpt ? "excerpt" : "block";
  return (
    <div className={profile === "person" ? "md-prose md-prose--person" : "md-prose"}>
      {blocks.map((block, index) => (
        <MarkdownBlock
          components={bare ? bareComponents : excerpt ? excerptComponents : components}
          key={index}
          profile={profile}
          streaming={streaming && index === blocks.length - 1}
          text={block}
          variant={`${profile}:${variant}`}
        />
      ))}
    </div>
  );
});

/**
 * Each finished block, drawn, by how it was drawn and its words, shared by every reply on every
 * screen. An element never changes, so a block mounted again (a task switched back to, a row
 * scrolled back into view) reuses it instead of parsing again, and parsing is most of what drawing
 * Markdown costs. An element and the tree it keeps hold about 20 bytes per character written, so
 * this stays near 10 MB. A block still being written is never kept: it would only fill this with
 * its prefixes.
 */
export const drawnBlocks = new BoundedCache<string, ReactElement>({ maxSize: 500_000 });
// A short block still holds a whole element tree.
const blockOverheadChars = 200;

const MarkdownBlock = memo(function MarkdownBlock({
  components,
  profile,
  streaming,
  text,
  variant,
}: {
  components: Components;
  profile: MarkdownProfile;
  streaming: boolean;
  text: string;
  variant: string;
}) {
  const person = profile === "person";
  const draw = () =>
    drawMarkdown({
      children: streaming ? hideIncompleteLinkTail(text) : text,
      components,
      rehypePlugins: person ? noRehypePlugins : streaming ? streamingRehypePlugins : rehypePlugins,
      remarkPlugins: person
        ? personRemarkPlugins
        : streaming
          ? streamingRemarkPlugins
          : remarkPlugins,
      urlTransform,
    });
  if (streaming) return draw();
  // Kept as it is drawn, not once committed: a render React restarts (a switch is a transition)
  // finds its blocks already drawn.
  const key = `${variant}\u0000${text}`;
  const held = drawnBlocks.get(key);
  if (held) return held;
  const element = draw();
  drawnBlocks.set(key, element, key.length + blockOverheadChars);
  return element;
});

export default Markdown;
