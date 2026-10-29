import { memo, useMemo, type ComponentProps, type MouseEvent } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { transcriptLinkUrl } from "@opensteer/shared/transcriptLinks";
import { desktopBridge } from "../desktop/desktop-bridge.js";
import { ExternalLink } from "./external-link.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

const remarkPlugins = [remarkGfm];
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
    workspace.nav.showLauncher({ address: url.href });
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

const components: Components = { a: TranscriptLink, img: TranscriptImage };

/** An image's address is only ever shown as words, so it keeps the agent's spelling. */
const urlTransform: UrlTransform = (url, key, node) =>
  node.tagName === "img" && key === "src" ? url : defaultUrlTransform(url);

/**
 * Assistant markdown. Blocks are split on blank lines and memoized so a
 * streaming message only re-renders its trailing block.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="md-prose">
      {blocks.map((block, index) => (
        <MarkdownBlock key={`${index}:${block.length}`} text={block} />
      ))}
    </div>
  );
});

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={components}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
    >
      {text}
    </ReactMarkdown>
  );
});

export default Markdown;

/** Splits markdown into stable blocks, keeping fenced code intact. */
function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line.trimStart())) inFence = !inFence;
    if (!inFence && line.trim() === "" && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks.length > 0 ? blocks : [text];
}
