import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useShell } from "./app-shell.js";
import { composerDraftKeyFor, composerDrafts, homeDraftId } from "./composer-drafts.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/** Opens Home with these words in its draft, for the person to finish and send. */
export function useStartTask(): (text: string) => void {
  const { snapshot } = useShell();
  const nav = useOptionalWorkspace()?.nav;
  const navigate = useNavigate();
  const { deploymentId } = snapshot;
  const userId = snapshot.user?.id;
  return useCallback(
    (text: string) => {
      const key = composerDraftKeyFor(deploymentId, userId, { kind: "task", draftId: homeDraftId });
      if (key) composerDrafts.update(key, { text });
      if (nav) nav.openConversation("/");
      else void navigate("/");
    },
    [deploymentId, nav, navigate, userId],
  );
}

/** Where a task opens, from pages that may stand outside a workspace. */
export function useThreadPath(): (threadId: string) => string {
  const nav = useOptionalWorkspace()?.nav;
  return nav?.threadPath ?? ((threadId) => `/tasks/${encodeURIComponent(threadId)}`);
}
