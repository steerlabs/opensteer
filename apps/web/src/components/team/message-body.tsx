import { memo, useMemo, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink } from "../external-link.js";
import { Icon, type IconName } from "../icon.js";
import { attachmentDetail, isInlineImage } from "../attachments/attachment-parts.js";
import { MentionChip } from "./team-marks.js";
import type { FileView, MentionView } from "./team-models.js";

/** The parts of a Markdown tree this file reads and writes. */
interface MarkdownNode {
  readonly type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: object;
}

const noTerms: readonly string[] = [];
const skipped = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

/**
 * Turns `@handle` into a mention the reader's words can render, and wraps
 * search terms in <mark>. Only handles the message resolved become chips, so
 * a stray "@" in prose stays prose.
 */
function remarkTeamText(handles: ReadonlySet<string>, terms: readonly string[]) {
  const pattern = buildPattern(handles, terms);
  return () => (tree: MarkdownNode) => {
    if (pattern) visit(tree);
  };

  function visit(node: MarkdownNode) {
    const children = node.children;
    if (!children || skipped.has(node.type)) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child) continue;
      if (child.type !== "text" || typeof child.value !== "string") {
        visit(child);
        continue;
      }
      const pieces = split(child.value);
      if (pieces.length === 1 && pieces[0]?.type === "text") continue;
      children.splice(index, 1, ...pieces);
      index += pieces.length - 1;
    }
  }

  function split(text: string): MarkdownNode[] {
    if (!pattern) return [{ type: "text", value: text }];
    const pieces: MarkdownNode[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start > last) pieces.push({ type: "text", value: text.slice(last, start) });
      const word = match[0];
      const handle = word.startsWith("@") ? word.slice(1).toLowerCase() : null;
      pieces.push(
        handle !== null && handles.has(handle)
          ? {
              type: "text",
              value: word,
              data: { hName: "data", hProperties: { value: handle } },
            }
          : { type: "text", value: word, data: { hName: "mark" } },
      );
      last = start + word.length;
    }
    if (last < text.length) pieces.push({ type: "text", value: text.slice(last) });
    return pieces;
  }
}

function buildPattern(handles: ReadonlySet<string>, terms: readonly string[]): RegExp | null {
  const parts = [
    ...[...handles].map((handle) => `@${escape(handle)}(?![\\w-])`),
    ...terms.filter((term) => term.trim().length > 1).map((term) => escape(term.trim())),
  ];
  return parts.length === 0 ? null : new RegExp(parts.join("|"), "giu");
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function BodyLink({ children, href }: ComponentProps<"a">) {
  if (!href || !/^https?:\/\//iu.test(href)) return <span>{children}</span>;
  return <ExternalLink href={href}>{children}</ExternalLink>;
}

/** Images in a message body are never fetched; a file is attached instead. */
function BodyImage({ alt }: ComponentProps<"img">) {
  return alt ? <span>{alt}</span> : null;
}

/**
 * A team message's words: Markdown (never HTML), with mentions in the
 * reader's own words and, in search, the matched terms marked.
 */
export const MessageBody = memo(function MessageBody({
  highlight = noTerms,
  mentions,
  text,
}: {
  readonly highlight?: readonly string[] | undefined;
  readonly mentions: readonly MentionView[];
  readonly text: string;
}) {
  const byHandle = useMemo(
    () => new Map(mentions.map((mention) => [mention.handle.toLowerCase(), mention])),
    [mentions],
  );
  const plugins = useMemo(
    () => [remarkGfm, remarkTeamText(new Set(byHandle.keys()), highlight)],
    [byHandle, highlight],
  );
  const components = useMemo<Components>(
    () => ({
      a: BodyLink,
      img: BodyImage,
      data: ({ value }) => {
        const mention = typeof value === "string" ? byHandle.get(value) : undefined;
        return mention ? <MentionChip mention={mention} /> : <span>@{String(value)}</span>;
      },
    }),
    [byHandle],
  );
  return (
    <div className="md-prose team-body">
      <ReactMarkdown components={components} remarkPlugins={plugins}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * The files a message carries. Images show the uploader's small preview and
 * load the original only when opened; other files are a card that downloads.
 */
export function MessageFiles({
  files,
  onOpen,
}: {
  readonly files: readonly FileView[];
  readonly onOpen?: ((file: FileView) => void) | undefined;
}) {
  if (files.length === 0) return null;
  const images = files.filter((file) => isInlineImage(file.mediaType) && file.previewUrl);
  const others = files.filter((file) => !images.includes(file));
  return (
    <div className="team-files">
      {images.length > 0 ? (
        <ul aria-label="Images" className="team-files__images">
          {images.map((file) => (
            <li key={file.id}>
              <button
                aria-label={`Open ${file.name}`}
                className="team-image"
                onClick={() => onOpen?.(file)}
                type="button"
              >
                <img alt="" decoding="async" loading="lazy" src={file.previewUrl ?? undefined} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {others.length > 0 ? (
        <ul aria-label="Files" className="team-files__cards">
          {others.map((file) => (
            <li key={file.id}>
              <FileCard file={file} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FileCard({
  file,
  onOpen,
}: {
  readonly file: FileView;
  readonly onOpen?: ((file: FileView) => void) | undefined;
}) {
  return (
    <button
      className="message-attachment message-attachment--file team-file"
      onClick={() => onOpen?.(file)}
      title={`Download ${file.name}`}
      type="button"
    >
      <span aria-hidden className={`message-attachment__icon team-file__icon--${fileTone(file)}`}>
        <Icon name={fileIcon(file)} />
      </span>
      <span className="message-attachment__text">
        <span className="message-attachment__name">{file.name}</span>
        <span className="message-attachment__detail">
          {attachmentDetail(file.name, file.mediaType, file.sizeBytes)}
        </span>
      </span>
    </button>
  );
}

export function fileIcon(file: Pick<FileView, "mediaType" | "name">): IconName {
  if (isInlineImage(file.mediaType)) return "image";
  if (fileTone(file) === "sheet") return "table";
  return "file";
}

function fileTone(file: Pick<FileView, "mediaType" | "name">): "pdf" | "sheet" | "plain" {
  if (file.mediaType === "application/pdf" || /\.pdf$/iu.test(file.name)) return "pdf";
  if (/sheet|excel|csv/iu.test(file.mediaType) || /\.(xlsx?|csv|numbers)$/iu.test(file.name))
    return "sheet";
  return "plain";
}
