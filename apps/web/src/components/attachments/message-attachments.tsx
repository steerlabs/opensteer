import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentIdSchema, type ArtifactContentPart } from "@opensteer/core";
import type { HostClient } from "@opensteer/client/host";
import { act, failureWords } from "../use-action.js";
import { saveFile } from "../file-actions.js";
import { Icon } from "../icon.js";
import { attachmentDetail, isInlineImage } from "./attachment-parts.js";
import { useImageActions } from "../image-actions.js";
import { isPersonalScope, useReferenceScope } from "../references/reference-scope.js";
import { useNearViewport } from "../use-near-viewport.js";

/**
 * The HostClient available to transcript content. Without one, attachments
 * show as names and apps are unavailable.
 */
export const TranscriptHostClientContext = createContext<HostClient | null>(null);

/** The files a message carries, in the order they were sent. */
export function MessageAttachments({
  attachments,
}: {
  readonly attachments: readonly ArtifactContentPart[];
}) {
  const client = useContext(TranscriptHostClientContext);
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
  const scope = useReferenceScope();
  const attachmentId = AttachmentIdSchema.safeParse(part.artifactId);
  const { artifactId, mediaType, name } = part;
  const read = useMemo(
    () => async () =>
      new File([await client.readAttachment(artifactId)], name, { type: mediaType }),
    [artifactId, client, mediaType, name],
  );
  const actions = useImageActions(read);

  if (image.failed) {
    return <FileAttachment client={client} note="Preview unavailable" part={part} />;
  }
  return (
    <>
      <button
        aria-label={`Open ${part.name}`}
        className="message-attachment message-attachment--image"
        onClick={() => {
          if (isPersonalScope(scope) && attachmentId.success)
            void scope.navigation.openReference({
              kind: "attachment",
              attachmentId: attachmentId.data,
            });
        }}
        ref={frameRef}
        title={part.name}
        type="button"
        {...actions.target}
      >
        {image.url ? (
          <img alt="" src={image.url} />
        ) : (
          <span aria-hidden className="message-attachment__placeholder">
            <span className="spinner" />
          </span>
        )}
      </button>
      {actions.menu}
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
    void act(client, { label: "download this file", done: "downloaded" }, () =>
      client.readAttachment(part.artifactId),
    )
      .then((bytes) => saveFile(bytes, part.name))
      .catch((reason: unknown) => {
        if (mounted.current) setError(failureWords(reason));
      })
      .finally(() => {
        if (mounted.current) setPending(false);
      });
  };
  return { download, error, pending };
}
