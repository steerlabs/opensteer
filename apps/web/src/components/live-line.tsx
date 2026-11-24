import type { LiveTurn } from "@opensteer/client/host";
import { useLiveTurnLine } from "@opensteer/client/react";

/**
 * The line above a task's composer while its Run is under way: what the agent
 * is doing — between steps, the step it last finished — how long the Run has
 * gone, and how recent that is. It stays in view however far the reader has
 * scrolled, so a long turn never reads as one that stopped. It ticks only while
 * this reader is in touch with the Host; out of touch, nothing on it moves.
 */
export function LiveLine({ connected, live }: { connected: boolean; live: LiveTurn }) {
  const line = useLiveTurnLine(live, connected);
  const moving = line.tone === "working" && live.active;
  const meta = [line.since, line.elapsed].filter(Boolean).join(" · ");
  return (
    <div aria-label="Agent status" className={`live-line live-line--${line.tone}`}>
      <div className="live-line__row">
        <span aria-hidden className="live-line__orb" />
        <span className={moving ? "live-line__label live-line__label--moving" : "live-line__label"}>
          {line.label}
        </span>
        {line.detail ? (
          <span
            className={
              line.detail.code ? "live-line__detail live-line__detail--code" : "live-line__detail"
            }
            title={line.detail.text}
          >
            {line.detail.text}
          </span>
        ) : null}
        {meta ? (
          // Ticks every second: kept from assistive technology, which reads the words.
          <span aria-hidden className="live-line__meta">
            {meta}
          </span>
        ) : null}
      </div>
      {line.note ? <p className="live-line__note">{line.note}</p> : null}
    </div>
  );
}
