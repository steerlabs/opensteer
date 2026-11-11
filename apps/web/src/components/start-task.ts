import { mainWorkspace } from "@opensteer/client/host";
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useShell } from "./app-shell.js";
import { composerDraftKeyFor, composerDrafts } from "./composer-drafts.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/** Opens a new task in Main with its words already written, for the person to finish and send. */
export function useStartTask(): (text: string) => void {
  const { snapshot } = useShell();
  const nav = useOptionalWorkspace()?.nav;
  const navigate = useNavigate();
  const { deploymentId } = snapshot;
  const userId = snapshot.user?.id;
  const workspaceId = mainWorkspace(snapshot)?.id;
  return useCallback(
    (text: string) => {
      const draftId = globalThis.crypto.randomUUID();
      const key = composerDraftKeyFor(deploymentId, userId, { kind: "task", draftId });
      if (key) composerDrafts.update(key, { text, ...(workspaceId ? { workspaceId } : {}) });
      if (nav) nav.openConversation("/new", { draftId });
      else void navigate(`/new?draft=${encodeURIComponent(draftId)}`);
    },
    [deploymentId, nav, navigate, userId, workspaceId],
  );
}

/** Where a task opens, from pages that may stand outside a workspace. */
export function useThreadPath(): (threadId: string) => string {
  const nav = useOptionalWorkspace()?.nav;
  return nav?.threadPath ?? ((threadId) => `/tasks/${encodeURIComponent(threadId)}`);
}
