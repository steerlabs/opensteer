import { useRef, useState } from "react";
import { useAssetImage } from "@opensteer/client/react";
import { ImagePreviewDialog } from "./attachments/message-attachments.js";
import { useNearViewport } from "./use-near-viewport.js";

/** An image the Host serves, asked for only once it comes near the screen. */
export function AssetImage({ path, alt = "" }: { path: string; alt?: string }) {
  const frame = useRef<HTMLSpanElement | null>(null);
  const near = useNearViewport(frame);
  const preview = useAssetImage(path, "preview", { enabled: near });
  const [open, setOpen] = useState(false);
  if (preview.failed) return <span>{alt || "Image unavailable"}</span>;
  if (!preview.available) return <span>{alt || path}</span>;
  return (
    <span className="asset-image" ref={frame}>
      <button
        type="button"
        className="message-attachment message-attachment--image"
        onClick={() => setOpen(true)}
        aria-label={alt || "Open image"}
      >
        {preview.image ? (
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
            aria-label="Loading image"
          />
        )}
      </button>
      {open ? <OriginalImage path={path} alt={alt} close={() => setOpen(false)} /> : null}
    </span>
  );
}
function OriginalImage({ path, alt, close }: { path: string; alt: string; close: () => void }) {
  const original = useAssetImage(path, "original");
  return (
    <ImagePreviewDialog title={alt || "Image"} onClose={close}>
      {original.failed ? (
        "Image unavailable"
      ) : original.image ? (
        <img
          key={original.retry}
          src={original.image.source}
          alt={alt}
          onError={original.onError}
        />
      ) : (
        <span className="spinner" aria-label="Loading image" />
      )}
    </ImagePreviewDialog>
  );
}
