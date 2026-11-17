/**
 * A section whose content never arrived, drawn still in its real shape: never
 * a fake empty list and never connection words. Nothing shimmers, because a
 * shimmer redraws forever and reads as loading forever.
 */
const bars = [
  [60, 35],
  [55, 30],
  [62, 38],
] as const;

export function PlaceholderRows({
  count = 3,
  label = "Not loaded yet",
  rowHeight,
}: {
  readonly count?: number;
  readonly label?: string;
  /** The real row's height, so the content lands without moving anything. */
  readonly rowHeight?: number;
}) {
  return (
    <div aria-label={label} className="placeholder-rows" role="img">
      {Array.from({ length: count }, (_, index) => {
        const [first, second] = bars[index % bars.length] ?? bars[0];
        return (
          <div
            className="placeholder-row"
            key={index}
            style={rowHeight === undefined ? undefined : { minHeight: rowHeight }}
          >
            <span className="placeholder-row__square" />
            <span className="placeholder-row__lines">
              <span className="placeholder-bar" style={{ width: `${first}%` }} />
              <span className="placeholder-bar" style={{ width: `${second}%` }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A setting's value that was never loaded. */
export function PlaceholderValue({ label = "Not loaded yet" }: { readonly label?: string }) {
  return <span aria-label={label} className="placeholder-bar placeholder-value" role="img" />;
}

/** A switch whose state was never loaded: a track with no knob, never "off". */
export function UnknownToggle({ label }: { readonly label: string }) {
  return (
    <span
      aria-disabled
      aria-label={label}
      aria-valuetext="Not loaded yet"
      className="unknown-toggle"
      role="switch"
    />
  );
}

/** A detail value, such as a count, that was never loaded. */
export function UnknownValue({ label = "Not loaded yet" }: { readonly label?: string }) {
  return (
    <span aria-label={label} className="unknown-value">
      –
    </span>
  );
}
