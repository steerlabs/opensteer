import { useVoice } from "@opensteer/client/react";
import type { Request } from "@opensteer/core";
import { useShell } from "./app-shell.js";
import { RequestStack, useRequestDock } from "./input-surface.js";
import { PasswordsSuggestion } from "./passwords-suggestion.js";

const noRequests: readonly Request[] = [];

/** What needs the person on this call: the same cards a conversation docks. */
export function VoiceAsk() {
  const { snapshot } = useVoice();
  const { snapshot: host } = useShell();
  const { ask } = snapshot;
  if (!ask || !host.voiceThreadId) return null;
  return ask.kind === "passwords" ? (
    <div className="voice-ask">
      <PasswordsSuggestion card={ask.card} site={ask.site} />
    </div>
  ) : (
    <VoiceRequests threadId={host.voiceThreadId} />
  );
}

function VoiceRequests({ threadId }: { readonly threadId: string }) {
  const { snapshot } = useShell();
  const dock = useRequestDock(threadId, snapshot.requests[threadId] ?? noRequests);
  return (
    <RequestStack
      disabled={false}
      items={dock.items}
      onOpen={dock.setOpenId}
      openId={dock.openId}
      threadId={threadId}
    />
  );
}
