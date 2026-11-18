import { PlaceholderRows } from "./placeholder.js";

/**
 * A list whose first answer hasn't arrived, drawn still in the shape of what
 * is coming: never a fake empty list, never connection words, and never a
 * shimmer that reads as loading forever through an outage.
 */
export function LoadingRows({
  label = "Not loaded yet",
  rows = 3,
}: {
  readonly label?: string;
  readonly rows?: number;
}) {
  return <PlaceholderRows count={rows} label={label} />;
}
