import { isValidElement, memo, useMemo, useRef, type ComponentProps, type MouseEvent } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { repairStrong, splitMarkdownBlocks } from "@opensteer/shared/markdown";
import { transcriptLinkUrl } from "@opensteer/shared/transcriptLinks";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import { CopyMark } from "./copy-mark.js";
import { ExternalLink } from "./external-link.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

type MarkdownTree = Parameters<typeof repairStrong>[0];

const remarkRepairStrong = () => (tree: MarkdownTree) => repairStrong(tree);
const remarkRepairStreaming = () => (tree: MarkdownTree) => repairStrong(tree, { streaming: true });

const remarkPlugins = [remarkGfm, remarkRepairStrong];
const streamingRemarkPlugins = [remarkGfm, remarkRepairStreaming];
const rehypePlugins = [rehypeHighlight];

/**
 * An agent wrote this link. A web page opens as a workspace tab, as if its
 * address were typed on the start page: the agent's computer can reach its
 * own localhost and network, and its profiles hold its sign-ins, where the
 * reader's device may not. A browser keeps its own gestures for a link; the
 * desktop window has none, so there a middle click opens it too. Anything
 * else keeps its words: an address the app resolved itself would replace the
 * app with whatever lives at that path.
 */
function TranscriptLink({ children, href }: ComponentProps<"a">) {
  const workspace = useOptionalWorkspace();
  const url = href === undefined ? null : transcriptLinkUrl(href);
  if (!url) return <span>{children}</span>;
  if (url.protocol === "mailto:")
    return desktopBridge() ? (
      <span>{children}</span>
    ) : (
      <ExternalLink href={url.href}>{children}</ExternalLink>
    );
  if (!workspace) return <span>{children}</span>;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    const gesture =
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    // A right click raises auxclick too; it never opens a link.
    if (desktopBridge() ? event.button > 1 : gesture) return;
    event.preventDefault();
    workspace.openWebLink(url.href);
  };
  return (
    <a href={url.href} onAuxClick={open} onClick={open} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

/** An agent's image is never fetched from the reader's device; its words stay. */
function TranscriptImage({ alt, src }: ComponentProps<"img">) {
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

const bareComponents: Components = { a: TranscriptLink, img: TranscriptImage };
const components: Components = { ...bareComponents, pre: TranscriptBlock };

/** An image's address is only ever shown as words, so it keeps the agent's spelling. */
const urlTransform: UrlTransform = (url, key, node) =>
  node.tagName === "img" && key === "src" ? url : defaultUrlTransform(url);

/**
 * Assistant markdown. Blocks are memoized so a streaming message only redraws
 * its trailing block; their index is their key, so that block keeps its place,
 * and a selection in it, as it grows. `bare` is for code that is a bubble of its
 * own, whose copy mark stands beside it; code held in words keeps its own.
 */
export const Markdown = memo(function Markdown({
  bare = false,
  streaming = false,
  text,
}: {
  bare?: boolean;
  streaming?: boolean;
  text: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <div className="md-prose">
      {blocks.map((block, index) => (
        <MarkdownBlock
          bare={bare}
          key={index}
          streaming={streaming && index === blocks.length - 1}
          text={block}
        />
      ))}
    </div>
  );
});

const MarkdownBlock = memo(function MarkdownBlock({
  bare,
  streaming,
  text,
}: {
  bare: boolean;
  streaming: boolean;
  text: string;
}) {
  return (
    <ReactMarkdown
      components={bare ? bareComponents : components}
      remarkPlugins={streaming ? streamingRemarkPlugins : remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
    >
      {text}
    </ReactMarkdown>
  );
});

export default Markdown;
