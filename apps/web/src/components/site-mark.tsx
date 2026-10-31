import { useState } from "react";
import type { BrowserFavicon } from "@opensteer/client/host";
import { Icon } from "./icon.js";

/** A neutral tile stays beneath the site's icon as it decodes and fades in. */
export function SiteMark({ favicon }: { readonly favicon: BrowserFavicon }) {
  return (
    <span aria-hidden className="site-mark">
      <Icon name="globe" />
      {favicon ? <SiteImage key={favicon} src={favicon} /> : null}
    </span>
  );
}

function SiteImage({ src }: { readonly src: string }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      alt=""
      className={`site-mark__image${ready ? " is-ready" : ""}`}
      decoding="async"
      draggable={false}
      src={src}
      onError={() => setFailed(true)}
      onLoad={({ currentTarget: image }) => {
        // Placeholder pixels cannot serve as recognizable site icons.
        if (image.naturalWidth < 8) {
          setFailed(true);
          return;
        }
        const decoded = typeof image.decode === "function" ? image.decode() : Promise.resolve();
        void decoded.then(
          () => {
            if (image.isConnected) setReady(true);
          },
          () => {
            if (image.isConnected) setFailed(true);
          },
        );
      }}
    />
  );
}
