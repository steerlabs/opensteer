import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { HostClient } from "@opensteer/client/host";
import type { TranscriptFileState } from "@opensteer/client/host";
import { TranscriptImageContext, useAssetImage } from "@opensteer/client/react";
import type { FileOpenInput } from "@opensteer/client/references";
import type { ThreadId } from "@opensteer/core";
import type { FileResource, FileSource } from "@opensteer/protocol";
import { attachmentDetail } from "../attachments/attachment-parts.js";
import { handleModalKeyDown } from "../dialog.js";
import { Icon } from "../icon.js";
import { NativeBrowserOverlay } from "../native-browser-overlays.js";
import { fileGlyph } from "./reference-glyphs.js";

/** Each line's height in the text view; lines are drawn only near the screen. */
export const fileLineHeight = 20;
const overscan = 40;
const downloadUrlLifetimeMs = 30_000;

function pathParts(source: FileSource): { readonly name: string; readonly dir: string } {
  if (source.kind !== "path") return { name: "Attachment", dir: "" };
  const separator = Math.max(source.path.lastIndexOf("/"), source.path.lastIndexOf("\\"));
  return {
    name: source.path.slice(separator + 1) || source.path,
    dir: source.path.slice(0, Math.max(separator, 0)),
  };
}

/**
 * A file a transcript names, read through the Host, which alone decides
 * whether this reader may see it. A drawer beside the conversation on a wide
 * screen and the whole screen on a narrow one; closing it returns focus to
 * the chip that opened it.
 */
export function FileViewer({
  client,
  input,
  onClose,
  threadId,
}: {
  readonly client: HostClient;
  readonly input: FileOpenInput;
  readonly onClose: () => void;
  readonly threadId: ThreadId | null;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    close.current?.focus();
    const from = opener.current;
    return () => from?.focus();
  }, []);
  const sourceKey = JSON.stringify(input.source);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<TranscriptFileState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    client.transcriptFiles.open(threadId, input.source, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState(value);
      },
      () => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      },
    );
    return () => controller.abort();
  }, [client, threadId, sourceKey, attempt]);
  const shown = state?.status === "offline" ? state.cached : state?.status === "ok" ? state : null;
  const parts = pathParts(input.source);
  const name = shown?.name ? (shown.name.split(/[\\/]/u).at(-1) ?? shown.name) : parts.name;
  const retry = () => setAttempt((value) => value + 1);
  return (
    <NativeBrowserOverlay>
      <div
        className="file-viewer-layer"
        onKeyDown={(event) => handleModalKeyDown(event, panel.current, onClose)}
        role="presentation"
      >
        <button
          aria-label="Close file"
          className="dialog-scrim"
          onClick={onClose}
          tabIndex={-1}
          type="button"
        />
        <div
          aria-labelledby={titleId}
          aria-modal="true"
          className="file-viewer"
          ref={panel}
          role="dialog"
        >
          <header className="file-viewer__header">
            <Icon name={fileGlyph(name)} />
            <div className="file-viewer__name">
              <h2 className="file-viewer__title" id={titleId} title={name}>
                {name}
              </h2>
              {parts.dir ? <FolderPath dir={parts.dir} /> : null}
            </div>
            {shown ? (
              <DownloadButton
                client={client}
                name={name}
                resource={shown.resource}
                threadId={threadId}
              />
            ) : null}
            <button
              aria-label="Close"
              className="icon-btn"
              onClick={onClose}
              ref={close}
              type="button"
            >
              <Icon name="close" />
            </button>
          </header>
          <div className="file-viewer__body">
            <FileBody
              client={client}
              input={input}
              name={name}
              retry={retry}
              state={state}
              threadId={threadId}
            />
          </div>
        </div>
      </div>
    </NativeBrowserOverlay>
  );
}

/** The folder, cut in its middle so its root and its last folder both stay. */
function FolderPath({ dir }: { readonly dir: string }) {
  const separator = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  const head = dir.slice(0, separator);
  const tail = dir.slice(separator);
  return (
    <span className="file-viewer__dir" title={dir}>
      <span className="file-viewer__dir-head">{head}</span>
      <span className="file-viewer__dir-tail">
        {/* An isolate keeps the right-to-left trick from reordering the path's own characters. */}
        <bdi dir="ltr">{tail}</bdi>
      </span>
    </span>
  );
}

function FileBody({
  client,
  input,
  name,
  retry,
  state,
  threadId,
}: {
  readonly client: HostClient;
  readonly input: FileOpenInput;
  readonly name: string;
  readonly retry: () => void;
  readonly state: TranscriptFileState | null;
  readonly threadId: ThreadId | null;
}) {
  if (state === null)
    return (
      <div aria-label="Loading file" className="file-viewer__skeleton" role="status">
        {[72, 54, 88, 40, 66, 80, 48].map((width) => (
          <span key={width} style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  switch (state.status) {
    case "unavailable":
      return (
        <ViewerState
          body="It may have been moved or deleted, or it's outside what Opensteer can show."
          icon="help-circle"
          title="This isn't available"
        />
      );
    case "failed":
      return (
        <ViewerState
          action={<RetryButton retry={retry} />}
          body="Try again in a moment."
          icon="alert-circle"
          title="Couldn't open this file"
        />
      );
    case "offline":
      return state.cached && state.cached.preview.kind === "text" ? (
        <>
          <p className="file-viewer__banner" role="status">
            <Icon name="cloud-off" />
            You're offline. This is the copy you opened before.
            <RetryButton retry={retry} />
          </p>
          <TextLines input={input} text={state.cached.preview.text} />
        </>
      ) : (
        <ViewerState
          action={<RetryButton retry={retry} />}
          body="Reconnect to open this file."
          icon="cloud-off"
          title="You're offline"
        />
      );
    case "ok": {
      const { preview } = state;
      if (preview.kind === "text")
        return (
          <>
            {preview.truncated ? (
              <p className="file-viewer__banner" role="status">
                <Icon name="alert-circle" />
                Showing the start of this file. Download it to see all of it.
              </p>
            ) : null}
            <TextLines input={input} text={preview.text} />
          </>
        );
      if (preview.kind === "image")
        return (
          <TranscriptImageContext value={{ client, threadId }}>
            <ViewerImage
              name={name}
              onStale={retry}
              revision={state.resource.revision}
              source={input.source}
            />
          </TranscriptImageContext>
        );
      return (
        <ViewerState
          action={
            <DownloadButton
              client={client}
              labelled
              name={name}
              resource={state.resource}
              threadId={threadId}
            />
          }
          body={attachmentDetail(name, state.mediaType, state.sizeBytes)}
          icon="file"
          title="This file can't be shown here"
        />
      );
    }
  }
}

function ViewerState({
  action,
  body,
  icon,
  title,
}: {
  readonly action?: ReactNode;
  readonly body: string;
  readonly icon: "alert-circle" | "cloud-off" | "file" | "help-circle";
  readonly title: string;
}) {
  return (
    <div className="ref-unavailable" role="status">
      <Icon name={icon} />
      <p className="ref-unavailable__title">{title}</p>
      <p className="ref-unavailable__body">{body}</p>
      {action ? <div className="ref-unavailable__actions">{action}</div> : null}
    </div>
  );
}

function RetryButton({ retry }: { readonly retry: () => void }) {
  return (
    <button className="btn btn--small" onClick={retry} type="button">
      <Icon name="reload" />
      Retry
    </button>
  );
}

/** The file's lines, with the one the link names lit and a third of the way down. */
function TextLines({ input, text }: { readonly input: FileOpenInput; readonly text: string }) {
  const lines = useMemo(() => {
    const split = text.split(/\r\n|\r|\n/u);
    if (split.length > 1 && split.at(-1) === "") split.pop();
    return split;
  }, [text]);
  const widest = useMemo(() => lines.reduce((max, line) => Math.max(max, line.length), 0), [lines]);
  const first = input.line === undefined ? null : Math.min(input.line, lines.length);
  const last =
    first === null ? null : Math.min(Math.max(input.endLine ?? first, first), lines.length);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: overscan * 2 });
  const update = (top: number) => {
    const height = scroller.current?.clientHeight ?? 0;
    const start = Math.max(0, Math.floor(top / fileLineHeight) - overscan);
    const end = Math.min(lines.length, Math.ceil((top + height) / fileLineHeight) + overscan);
    setRange((held) => (held.start === start && held.end === end ? held : { start, end }));
  };
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const top =
      first === null ? 0 : Math.max(0, (first - 1) * fileLineHeight - element.clientHeight / 3);
    element.scrollTop = top;
    update(top);
  }, [lines, first]);
  const digits = String(lines.length).length;
  return (
    <div
      aria-label="File contents"
      className="file-viewer__text"
      onScroll={(event) => update(event.currentTarget.scrollTop)}
      ref={scroller}
      role="region"
      style={{ "--gutter-digits": digits } as CSSProperties}
      tabIndex={0}
    >
      <div
        className="file-viewer__lines"
        style={{
          height: lines.length * fileLineHeight,
          width: `calc(${widest + digits}ch + 6ch)`,
        }}
      >
        {lines.slice(range.start, range.end).map((line, index) => {
          const number = range.start + index + 1;
          const target = first !== null && last !== null && number >= first && number <= last;
          return (
            <div
              aria-current={target && number === first ? "location" : undefined}
              className={target ? "file-line file-line--target" : "file-line"}
              data-line={number}
              key={number}
              style={{ top: (number - 1) * fileLineHeight }}
            >
              <span className="file-line__number">{number}</span>
              <span className="file-line__text">{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The image the open already minted (it seeds the shared image store). A later
 * mint naming another revision opens the file again, so Download stays on what is shown.
 */
function ViewerImage({
  name,
  onStale,
  revision,
  source,
}: {
  readonly name: string;
  readonly onStale: () => void;
  readonly revision: string;
  readonly source: FileSource;
}) {
  const [original, setOriginal] = useState(false);
  const image = useAssetImage(source, original ? "original" : "preview");
  const stale = image.image !== null && image.image.revision !== revision;
  useEffect(() => {
    if (stale) onStale();
  }, [stale]);
  return (
    <>
      <div
        className={
          original ? "file-viewer__image file-viewer__image--original" : "file-viewer__image"
        }
      >
        {image.failed ? (
          <ViewerState body="Its preview couldn't be loaded." icon="help-circle" title={name} />
        ) : image.image && !stale ? (
          <img alt={name} key={image.retry} onError={image.onError} src={image.image.source} />
        ) : (
          <span aria-label="Loading image" className="spinner" role="status" />
        )}
      </div>
      <p className="file-viewer__banner">
        <button
          aria-pressed={original}
          className="btn btn--small btn--ghost"
          onClick={() => setOriginal(!original)}
          type="button"
        >
          <Icon name={original ? "fit" : "expand"} />
          {original ? "Fit" : "Original"}
        </button>
      </p>
    </>
  );
}

function DownloadButton({
  client,
  labelled = false,
  name,
  resource,
  threadId,
}: {
  readonly client: HostClient;
  readonly labelled?: boolean;
  readonly name: string;
  readonly resource: FileResource;
  readonly threadId: ThreadId | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const download = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void client.transcriptFiles
      .download(threadId, resource)
      .then((result) => {
        if (result.status !== "ok") {
          if (mounted.current)
            setError(
              result.status === "offline"
                ? "You're offline."
                : result.status === "unavailable"
                  ? "This file isn't available."
                  : "Couldn't download this file.",
            );
          return;
        }
        // Saved, never opened in place: an opaque type keeps the browser from rendering it.
        const url = URL.createObjectURL(
          new Blob([result.bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.rel = "noopener";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), downloadUrlLifetimeMs);
      })
      .catch(() => {
        if (mounted.current) setError("Couldn't download this file.");
      })
      .finally(() => {
        if (mounted.current) setPending(false);
      });
  };
  return (
    <>
      {error ? (
        <span className="form-actions__error" role="alert">
          {error}
        </span>
      ) : null}
      <button
        aria-busy={pending}
        aria-label={labelled ? undefined : "Download"}
        className={labelled ? "btn" : "icon-btn"}
        disabled={pending}
        onClick={download}
        title="Download"
        type="button"
      >
        <Icon name="download" />
        {labelled ? (pending ? "Downloading…" : "Download") : null}
      </button>
    </>
  );
}
