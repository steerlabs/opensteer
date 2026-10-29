import { useState } from "react";
import { deploymentStatusInfoLabel } from "@opensteer/protocol/deployment-status";
import type { DeploymentStatusInfo } from "@opensteer/protocol/desktop";
import type { PlaceRow } from "../../desktop/places.js";
import { Icon } from "../icon.js";

export interface PlaceListProps {
  /** True while a choice is being carried out; every row waits for it. */
  readonly busy?: boolean;
  /**
   * Whether the current row explains a problem when chosen. Only where
   * choosing it would otherwise just close the list; elsewhere choosing it
   * is how a person asks for the fix.
   */
  readonly explainCurrent?: boolean;
  readonly label: string;
  readonly onCheck: () => void;
  readonly onOpen: (row: PlaceRow) => void;
  readonly onRemove?: ((row: PlaceRow) => void) | null;
  readonly rows: readonly PlaceRow[];
}

/**
 * The one list of places, for the sidebar's menu and for the full window alike.
 *
 * A place that is fine opens on one click. A place that is not — asleep,
 * remote access off, could not be checked — explains itself on that click
 * instead, with the one thing a person can do about it, so no row is ever a
 * dead end and no row ever fails silently after it was chosen.
 */
export function PlaceList({
  busy = false,
  explainCurrent = false,
  label,
  onCheck,
  onOpen,
  onRemove = null,
  rows,
}: PlaceListProps) {
  const [explained, setExplained] = useState<string | null>(null);
  return (
    <ul aria-label={label} className="place-list">
      {rows.map((row) => {
        const explains = row.current
          ? explainCurrent && !plainStatus(row.status) && Boolean(row.status.reason)
          : !row.opens || !plainStatus(row.status);
        // A healthy place shared with this person opens on its row, so the
        // way to drop it from their list sits beside it instead.
        const more = !explains && row.removable;
        const open = (explains || more) && explained === row.id;
        return (
          <li className="place-list__item" key={row.id}>
            <div className="place-row-line">
              <button
                aria-current={row.current ? "true" : undefined}
                aria-expanded={explains ? open : undefined}
                className={`place-row${row.current ? " is-current" : ""}`}
                data-autofocus={row.current ? "" : undefined}
                disabled={busy && !row.current}
                onClick={() => {
                  if (explains) setExplained(open ? null : row.id);
                  else onOpen(row);
                }}
                type="button"
              >
                <span aria-hidden className="place-row__check">
                  {row.current ? <Icon name="check" /> : null}
                </span>
                <span aria-hidden className="place-row__mark">
                  <Icon name={row.icon} />
                </span>
                <span className="place-row__text">
                  <span className="place-row__name">{row.name}</span>
                  <span className="place-row__detail">{row.detail}</span>
                </span>
                <PlaceStatus status={row.status} />
              </button>
              {more ? (
                <button
                  aria-expanded={open}
                  aria-label={`More for ${row.name}`}
                  className="place-row__more"
                  onClick={() => setExplained(open ? null : row.id)}
                  type="button"
                >
                  <Icon name="more" />
                </button>
              ) : null}
            </div>
            {open ? (
              <div className="place-row__explain">
                {row.status.reason ? <p>{row.status.reason}</p> : null}
                <div className="place-row__actions">
                  {row.opens && !row.current ? (
                    <button
                      className="btn btn--small"
                      disabled={busy}
                      onClick={() => onOpen(row)}
                      type="button"
                    >
                      {plainStatus(row.status) ? "Open" : "Open anyway"}
                    </button>
                  ) : null}
                  <button className="btn btn--small" onClick={onCheck} type="button">
                    Check again
                  </button>
                  {row.removable && onRemove ? (
                    <button
                      className="btn btn--small btn--ghost"
                      disabled={busy}
                      onClick={() => onRemove(row)}
                      type="button"
                    >
                      Remove from your list
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Ready says nothing but its dot; everything else names itself. */
function PlaceStatus({ status }: { readonly status: DeploymentStatusInfo }) {
  const label = deploymentStatusInfoLabel(status);
  if (status.status === "ready") {
    return (
      <span className="place-status" title={label}>
        <span aria-hidden className="place-status__dot place-status__dot--ready" />
        <span className="visually-hidden">{label}</span>
      </span>
    );
  }
  if (status.status === "checking" || status.status === "starting") {
    return (
      <span className="place-status">
        <span aria-hidden className="spinner place-status__spinner" />
        {label}
      </span>
    );
  }
  return (
    <span className={`place-status place-status--${status.status}`}>
      <span aria-hidden className={`place-status__dot place-status__dot--${status.status}`} />
      {label}
    </span>
  );
}

function plainStatus(status: DeploymentStatusInfo): boolean {
  return status.status === "ready" || status.status === "checking" || status.status === "starting";
}
