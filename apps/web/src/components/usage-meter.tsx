import { currentConnectionUsage, type UsageModelScope } from "@opensteer/client/host";
import type { HarnessObservedConnection } from "@opensteer/protocol";

/**
 * How much of an account's plan is spent, as a bar a glance can read before
 * the words are. Drawn from the window closest to running out, and only while
 * that reading still stands — an elapsed window draws nothing rather than an
 * empty bar that would read as "plenty left".
 */
export function UsageMeter({
  connection,
  model,
  now = Date.now(),
}: {
  readonly connection: HarnessObservedConnection;
  /** The model this bar is about, when the reader is looking at a route. */
  readonly model?: UsageModelScope;
  readonly now?: number;
}) {
  const usage = currentConnectionUsage(connection, now, model);
  const window = usage?.constrainingWindow;
  if (!window) return null;
  const percent = usage.limitReached ? 100 : Math.round(window.usedPercent);
  const tone = percent >= 95 ? "usage-meter--out" : percent >= 75 ? "usage-meter--low" : "";
  return (
    <span
      aria-label={`${percent}% of the ${window.label} limit used`}
      className={tone ? `usage-meter ${tone}` : "usage-meter"}
      role="img"
    >
      <span className="usage-meter__fill" style={{ width: `${percent}%` }} />
    </span>
  );
}
