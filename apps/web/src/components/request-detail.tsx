import { lazy, Suspense } from "react";
import { MessageFold } from "./message-fold.js";
import { readableMarkdown } from "./references/readable-markdown.js";

const Markdown = lazy(() => import("./markdown.js"));

/** Enough to show a short draft whole while the answers stay in view. */
const detailFoldLines = 8;

/**
 * What a Request asks about, folded until the reader opens it. An agent's
 * question is Markdown, so its draft reads as a draft does in a message. An
 * `excerpt` was cut to fit: it always offers more, and its blocks no copy.
 */
export function RequestDetail({
  excerpt = false,
  markdown,
  mono = false,
  onOpenChange,
  open,
  text,
}: {
  excerpt?: boolean;
  markdown: boolean;
  mono?: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  text: string;
}) {
  const plain = (words: string) => (
    <div
      className={mono ? "request-detail__text request-detail__text--mono" : "request-detail__text"}
    >
      {words}
    </div>
  );
  return (
    <div className="request-detail">
      <MessageFold lines={detailFoldLines} more={excerpt} onOpenChange={onOpenChange} open={open}>
        {markdown ? (
          <Suspense fallback={plain(readableMarkdown(text))}>
            <Markdown excerpt={excerpt} text={text} />
          </Suspense>
        ) : (
          plain(text)
        )}
      </MessageFold>
    </div>
  );
}
