import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A code a phone's camera opens. Drawn as one path of dark modules on a light
 * tile with its quiet zone, because cameras read dark-on-light whatever the
 * app's theme is.
 */
export function QrCode({ label, value }: { readonly label: string; readonly value: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(value, { border: 2, ecc: "M" });
    let d = "";
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path: d, size: qr.size };
  }, [value]);
  return (
    <svg
      aria-label={label}
      className="setup-scan__svg"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <rect fill="#f5f4f2" height={size} width={size} />
      <path d={path} fill="#111" />
    </svg>
  );
}
