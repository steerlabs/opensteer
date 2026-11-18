/**
 * The picture's own fact while it shows a place as it last was. Input is off
 * then, so a click on the picture bumps `pulse` and the chip acknowledges it.
 */
export function LastPictureChip({
  label = "Last picture",
  pulse = 0,
}: {
  readonly label?: string;
  readonly pulse?: number;
}) {
  return (
    <span
      aria-hidden
      className={pulse === 0 ? "last-picture" : "last-picture last-picture--pulse"}
      key={pulse}
    >
      {label}
    </span>
  );
}
