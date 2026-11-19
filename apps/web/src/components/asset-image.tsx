import { useContext, useMemo, useRef } from "react";
import { TranscriptImageContext, useAssetImage } from "@opensteer/client/react";
import { transcriptImageRead, useImageActions } from "./image-actions.js";
import { isPersonalScope, useReferenceScope } from "./references/reference-scope.js";
import { useNearViewport } from "./use-near-viewport.js";

/**
 * An image the Host serves, asked for only once it comes near the screen. It
 * opens in the file viewer, like any file a task names.
 */
export function AssetImage({ path, alt = "" }: { path: string; alt?: string }) {
  const frame = useRef<HTMLSpanElement | null>(null);
  const near = useNearViewport(frame);
  const preview = useAssetImage(path, "preview", { enabled: near });
  const images = useContext(TranscriptImageContext);
  const scope = useReferenceScope();
  const read = useMemo(
    () =>
      images ? transcriptImageRead(images.client, images.threadId, { kind: "path", path }) : null,
    [images, path],
  );
  const actions = useImageActions(read);
  if (preview.failed) return <span>{alt || "Image unavailable"}</span>;
  if (!preview.available) return <span>{alt || path}</span>;
  const image = preview.image ? (
    <img
      key={preview.retry}
      alt={alt}
      src={preview.image.source}
      width={preview.image.width ?? 320}
      height={preview.image.height ?? 240}
      style={{ maxWidth: "min(640px, 100%)", maxHeight: "none", height: "auto" }}
      loading="lazy"
      decoding="async"
      onError={preview.onError}
    />
  ) : (
    <span
      style={{ display: "inline-block", width: 320, height: 240 }}
      aria-label={alt ? undefined : "Loading image"}
    >
      {alt}
    </span>
  );
  return (
    <span className="asset-image" ref={frame}>
      {isPersonalScope(scope) ? (
        <button
          type="button"
          className="message-attachment message-attachment--image"
          onClick={() => void scope.navigation.openFile({ source: { kind: "path", path } })}
          aria-label={alt || "Open image"}
          {...actions.target}
        >
          {image}
        </button>
      ) : (
        <span className="message-attachment message-attachment--image" {...actions.target}>
          {image}
        </span>
      )}
      {actions.menu}
    </span>
  );
}

export function RetainedToolImage({ imageId }: { imageId: string }) {
  const frame = useRef<HTMLSpanElement | null>(null);
  const near = useNearViewport(frame);
  const preview = useAssetImage({ kind: "transcript-image", imageId }, "preview", {
    enabled: near,
  });
  return (
    <span className="asset-image" ref={frame}>
      {preview.image ? (
        <img
          key={preview.retry}
          alt="Tool image"
          src={preview.image.source}
          width={preview.image.width ?? 320}
          height={preview.image.height ?? 240}
          loading="lazy"
          onError={preview.onError}
        />
      ) : preview.failed ? (
        "Image unavailable"
      ) : null}
    </span>
  );
}
