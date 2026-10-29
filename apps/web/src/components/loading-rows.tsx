/**
 * A list that is still loading, shown as the shape of what is coming rather
 * than as a sentence in the empty state. An empty list and a pending list mean
 * different things, so they never look the same.
 *
 * The placeholder is decorative; `label` is what a screen reader hears.
 */
export function LoadingRows({
  label = "Loading",
  rows = 3,
}: {
  readonly label?: string;
  readonly rows?: number;
}) {
  return (
    <div aria-busy aria-label={label} className="loading-rows" role="status">
      {Array.from({ length: rows }, (_, index) => (
        <span
          aria-hidden
          className="skeleton"
          key={index}
          style={{ width: `${[68, 84, 54][index % 3]}%` }}
        />
      ))}
    </div>
  );
}
