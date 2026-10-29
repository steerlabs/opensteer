import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ArtifactContentPart } from "@opensteer/core";
import type { HostClient } from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { attachmentDetail, isInlineImage } from "./attachment-parts.js";

/**
 * The client a transcript reads attachment bytes through. Without one, as in
 * a transcript drawn for a screenshot, attachments show as names only.
 */
export const AttachmentReader = createContext<HostClient | null>(null);

/**
 * How long a download's object URL outlives the click. The browser copies the
 * bytes when it starts the download, but not synchronously in every engine.
 */
const downloadUrlLifetimeMs = 30_000;

/** The files a message carries, in the order they were sent. */
export function MessageAttachments({
  attachments,
}: {
  readonly attachments: readonly ArtifactContentPart[];
}) {
  const client = useContext(AttachmentReader);
  if (attachments.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="message-attachments">
      {attachments.map((part) => (
        <li key={part.artifactId}>
          {client && isInlineImage(part.mediaType) ? (
            <ImageAttachment client={client} part={part} />
          ) : (
            <FileAttachment client={client} part={part} />
          )}
        </li>
      ))}
    </ul>
  );
}

function ImageAttachment({
  client,
  part,
}: {
  readonly client: HostClient;
  readonly part: ArtifactContentPart;
}) {
  const frameRef = useRef<HTMLButtonElement | null>(null);
  const near = useNearViewport(frameRef);
  const image = useAttachmentImage(client, part, near);
  const [open, setOpen] = useState(false);
  const titleId = useId();

  if (image.failed) {
    return <FileAttachment client={client} note="Preview unavailable" part={part} />;
  }
  return (
    <>
      <button
        aria-label={`Open ${part.name}`}
        className="message-attachment message-attachment--image"
        onClick={() => setOpen(true)}
        ref={frameRef}
        title={part.name}
        type="button"
      >
        {image.url ? (
          <img alt="" src={image.url} />
        ) : (
          <span aria-hidden className="message-attachment__placeholder">
            <span className="spinner" />
          </span>
        )}
      </button>
      {open ? (
        <Dialog
          footer={<DownloadButton client={client} part={part} />}
          labelledBy={titleId}
          onClose={() => setOpen(false)}
          title={part.name}
          wide
        >
          <div className="attachment-preview">
            {image.url ? (
              <img alt={part.name} src={image.url} />
            ) : (
              <span className="spinner" role="status" aria-label="Loading image" />
            )}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function FileAttachment({
  client,
  note,
  part,
}: {
  readonly client: HostClient | null;
  readonly note?: string;
  readonly part: ArtifactContentPart;
}) {
  const { download, error, pending } = useDownload(client, part);
  const detail = note ?? attachmentDetail(part.name, part.mediaType, part.sizeBytes);
  const content = (
    <>
      <span aria-hidden className="message-attachment__icon">
        <Icon name="file" />
      </span>
      <span className="message-attachment__text">
        <span className="message-attachment__name" title={part.name}>
          {part.name}
        </span>
        <span className="message-attachment__detail">{detail}</span>
      </span>
    </>
  );
  if (!download) {
    return <span className="message-attachment message-attachment--file">{content}</span>;
  }
  return (
    <>
      <button
        aria-busy={pending}
        aria-label={`Download ${part.name}, ${detail}`}
        className="message-attachment message-attachment--file"
        disabled={pending}
        onClick={download}
        type="button"
      >
        {content}
        <span aria-hidden className="message-attachment__trailing">
          {pending ? <span className="spinner" /> : <Icon name="download" />}
        </span>
      </button>
      {error ? (
        <p className="form-actions__error message-attachment__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function DownloadButton({
  client,
  part,
}: {
  readonly client: HostClient;
  readonly part: ArtifactContentPart;
}) {
  const { download, error, pending } = useDownload(client, part);
  return (
    <>
      {error ? (
        <span className="form-actions__error" role="alert">
          {error}
        </span>
      ) : null}
      <button className="btn" disabled={pending} onClick={download ?? undefined} type="button">
        <Icon name="download" />
        {pending ? "Downloading…" : "Download"}
      </button>
    </>
  );
}

/**
 * The image's bytes as an object URL, read through the signed-in client once
 * the thumbnail is near the screen and revoked when it leaves. The Host's
 * declared type labels the bytes; only a native raster type reaches here.
 */
function useAttachmentImage(
  client: HostClient,
  part: ArtifactContentPart,
  enabled: boolean,
): { readonly failed: boolean; readonly url: string | null } {
  const [image, setImage] = useState<{
    readonly failed: boolean;
    readonly id: string;
    readonly url: string | null;
  } | null>(null);
  const { artifactId, mediaType } = part;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let url: string | null = null;
    void client.readAttachment(artifactId, controller.signal).then(
      (bytes) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
        setImage({ failed: false, id: artifactId, url });
      },
      () => {
        if (!controller.signal.aborted) setImage({ failed: true, id: artifactId, url: null });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifactId, client, enabled, mediaType]);

  return image?.id === artifactId ? image : { failed: false, url: null };
}

function useDownload(
  client: HostClient | null,
  part: ArtifactContentPart,
): {
  readonly download: (() => void) | null;
  readonly error: string | null;
  readonly pending: boolean;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!client) return { download: null, error: null, pending: false };

  const download = () => {
    if (pending) return;
    setPending(true);
    setError(null);
    void client
      .readAttachment(part.artifactId)
      .then((bytes) => {
        // Saved, never opened in place: an opaque type keeps the browser from
        // rendering whatever the bytes claim to be.
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = part.name;
        anchor.rel = "noopener";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), downloadUrlLifetimeMs);
      })
      .catch((reason: unknown) => {
        if (mounted.current) setError(actionErrorMessage(reason));
      })
      .finally(() => {
        if (mounted.current) setPending(false);
      });
  };
  return { download, error, pending };
}

/** True once the element comes within a screen of view, and from then on. */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}
