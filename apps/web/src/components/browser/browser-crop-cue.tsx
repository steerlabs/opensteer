import { browserCropCue } from "@opensteer/shared/browserPresentation";
import type { CSSProperties } from "react";

const cueStyle = {
  "--browser-crop-fade-size": `${browserCropCue.size}px`,
  "--browser-crop-right-gradient": browserCropCue.right,
  "--browser-crop-bottom-gradient": browserCropCue.bottom,
} as CSSProperties;

export function BrowserCropCue({
  croppedRight,
  croppedBottom,
  mounted,
}: {
  readonly croppedRight?: boolean;
  readonly croppedBottom?: boolean;
  readonly mounted?: boolean;
}) {
  return (
    <span
      aria-hidden
      className="browser-crop-cue"
      style={mounted ? { ...cueStyle, borderRadius: browserCropCue.radius } : cueStyle}
      data-cropped-right={croppedRight}
      data-cropped-bottom={croppedBottom}
    />
  );
}
