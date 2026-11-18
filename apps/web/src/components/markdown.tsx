import { useTranscriptImages } from "@opensteer/client/react";
import { classifyHref } from "@opensteer/core";
import { classifyMarkdownImageSource } from "@opensteer/shared/markdownImages";
import { personMarkdownGfmOptions, personMarkdownTree } from "@opensteer/shared/personMarkdown";
import { AssetImage } from "./asset-image.js";
import { isValidElement, memo, useMemo, useRef, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type Options, type UrlTransform } from "react-markdown";

type PluggableList = NonNullable<Options["remarkPlugins"]>;
import remarkGfm from "remark-gfm";
import {
  hideIncompleteLinkTail,
  repairStrong,
  splitMarkdownBlocks,
} from "@opensteer/shared/markdown";
import { CopyMark } from "./copy-mark.js";
import { createMarkdownHighlight } from "./markdown-highlight.js";
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

const bareComponents: Components = { a: ReferenceLink, img: TranscriptImage };
const components: Components = { ...bareComponents, pre: TranscriptBlock };

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
 */
export const Markdown = memo(function Markdown({
  bare = false,
  profile = "assistant",
  streaming = false,
  text,
}: {
  bare?: boolean;
  profile?: MarkdownProfile;
  streaming?: boolean;
  text: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div className={profile === "person" ? "md-prose md-prose--person" : "md-prose"}>
      {blocks.map((block, index) => (
        <MarkdownBlock
          bare={bare}
          key={index}
          profile={profile}
          streaming={streaming && index === blocks.length - 1}
          text={block}
        />
      ))}
    </div>
  );
});

const MarkdownBlock = memo(function MarkdownBlock({
  bare,
  profile,
  streaming,
  text,
}: {
  bare: boolean;
  profile: MarkdownProfile;
  streaming: boolean;
  text: string;
}) {
  const person = profile === "person";
  const highlight = useMemo(createMarkdownHighlight, []);
  return (
    <ReactMarkdown
      components={bare ? bareComponents : components}
      remarkPlugins={
        person ? personRemarkPlugins : streaming ? streamingRemarkPlugins : remarkPlugins
      }
      rehypePlugins={person ? noRehypePlugins : [[highlight, { streaming }]]}
      urlTransform={urlTransform}
    >
      {streaming ? hideIncompleteLinkTail(text) : text}
    </ReactMarkdown>
  );
});

export default Markdown;
