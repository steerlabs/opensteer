import { useState } from "react";
import type { WorkspaceSummary } from "@opensteer/client/host";
import { useShell } from "./app-shell.js";
import { Icon } from "./icon.js";

/**
 * Silences this project's replies and the work it could not finish. Approval
 * and question requests still notify, because an unanswered one stalls the
 * work. Its messages still count as unread, and the agent carries on. The
 * control says so, because a mute that might hide work is one nobody uses.
 */
export function WorkspaceNotificationMute({
  disabled = false,
  workspace,
}: {
  readonly disabled?: boolean;
  readonly workspace: WorkspaceSummary;
}) {
  const { hostClient, reportActionError, snapshot } = useShell();
  const [pending, setPending] = useState(false);
  const muted = (snapshot.notificationMutes ?? []).includes(workspace.id);
  return (
    <label className="card__row workspace-mute">
      <span className="card__row-glyph">
        <Icon name="message" />
      </span>
      <span className="card__row-body">
        <span className="card__row-title">Mute this project</span>
        <span className="card__row-detail card__row-detail--wrap">
          {muted
            ? "Its own conversations and tasks don’t notify you. Approvals and questions still do, and so does Opensteer when it passes something on. Its work keeps running."
            : "Silences its own conversations and tasks. Approvals and questions still notify you, and so does Opensteer when it passes something on."}
        </span>
      </span>
      <input
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        aria-label={`Mute notifications from ${workspace.name}`}
        checked={muted}
        className="switch"
        disabled={disabled}
        onChange={() => {
          if (pending) return;
          setPending(true);
          void hostClient
            .setWorkspaceNotificationMute(workspace.id, !muted)
            .catch(reportActionError)
            .finally(() => setPending(false));
        }}
        role="switch"
        type="checkbox"
      />
    </label>
  );
}
