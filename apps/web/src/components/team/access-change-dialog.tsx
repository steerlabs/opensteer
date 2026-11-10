import { useEffect, useRef, useState, type ReactNode } from "react";
import { teamErrorIsStale, type TeamAccess } from "@opensteer/client/host";
import type { AccessChange, AccessPreview } from "@opensteer/protocol";
import { Dialog } from "../dialog.js";
import { AccessPreviewPanel, TeamError } from "./team-ui.js";

/** Previews one batch of access changes against a revision; returns the latest answer. */
export function useAccessPreview(
  team: TeamAccess,
  revision: number,
  changes: readonly AccessChange[] | null,
) {
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);
  const key = changes
    ? JSON.stringify(changes.map((change) => ({ ...change, id: undefined })))
    : "";
  const current = useRef(changes);
  current.current = changes;
  useEffect(() => {
    const batch = current.current;
    const read = ++latest.current;
    setPreview(null);
    setError(null);
    if (!batch?.length) return;
    team.previewAccess(revision, batch).then(
      (next) => {
        if (read === latest.current) setPreview(next);
      },
      (next: unknown) => {
        if (read === latest.current) setError(next);
      },
    );
  }, [team, revision, key]);
  return { preview, error };
}

/** Confirms one access batch with its preview: who gains, who loses, what survives. */
export function AccessChangeDialog({
  changes,
  children,
  confirm,
  danger = false,
  names,
  onClose,
  onDone,
  onStale,
  revision,
  team,
  teamName,
  title,
}: {
  readonly changes: readonly AccessChange[];
  readonly children?: ReactNode;
  readonly confirm: string;
  readonly danger?: boolean;
  readonly names?: ReadonlyMap<string, string>;
  readonly onClose: () => void;
  readonly onDone?: () => void;
  readonly onStale: () => void;
  readonly revision: number;
  readonly team: TeamAccess;
  readonly teamName: string;
  readonly title: string;
}) {
  const { preview, error: previewError } = useAccessPreview(team, revision, changes);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const shown = error ?? previewError;
  return (
    <Dialog labelledBy="team-access-change" onClose={() => !pending && onClose()} title={title}>
      {children}
      <AccessPreviewPanel names={names} preview={previewError ? null : preview} team={teamName} />
      <TeamError
        error={shown}
        onRetry={
          teamErrorIsStale(shown)
            ? () => {
                onStale();
                onClose();
              }
            : undefined
        }
        team={teamName}
      />
      <div className="form-actions">
        <button className="btn" disabled={pending} onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className={danger ? "btn btn--danger" : "btn btn--primary"}
          disabled={pending || !preview?.allowed}
          onClick={() => {
            setPending(true);
            setError(null);
            void team
              .applyAccess(revision, changes)
              .then(() => {
                onClose();
                onDone?.();
              })
              .catch(setError)
              .finally(() => setPending(false));
          }}
          type="button"
        >
          {pending ? "Saving…" : confirm}
        </button>
      </div>
    </Dialog>
  );
}
