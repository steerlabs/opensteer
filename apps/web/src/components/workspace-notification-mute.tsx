import { useState } from "react";
import type { WorkspaceSummary } from "@opensteer/client/host";
import { useShell } from "./app-shell.js";

/**
 * Silences this agent's replies and the work it could not finish. Approval and
 * question requests still notify, because an unanswered one stalls the work.
 * Its messages still count as unread, and the agent carries on. The control
 * says so, because a mute that might hide work is one nobody uses.
 */
export function WorkspaceNotificationMute({ workspace }: { readonly workspace: WorkspaceSummary }) {
  const { hostClient, reportActionError, snapshot } = useShell();
  const [pending, setPending] = useState(false);
  const muted = (snapshot.notificationMutes ?? []).includes(workspace.id);
  return (
    <div className="workspace-mute">
      <button
        aria-pressed={muted}
        className="btn btn--ghost btn--small"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void hostClient
            .setWorkspaceNotificationMute(workspace.id, !muted)
            .catch(reportActionError)
            .finally(() => setPending(false));
        }}
        type="button"
      >
        {muted
          ? `Unmute notifications from ${workspace.name}`
          : `Mute notifications from ${workspace.name}`}
      </button>
      <p className="workspace-mute__note">
        {muted
          ? "This specialist's own conversations and tasks no longer notify you. Approvals and questions still do, and so does Opensteer when it passes something on from this specialist. Its work keeps running."
          : "Silences this specialist's own conversations and tasks. Approvals and questions still notify you, and so does Opensteer when it passes something on from this specialist."}
      </p>
    </div>
  );
}
