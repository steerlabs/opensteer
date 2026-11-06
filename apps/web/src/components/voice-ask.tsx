import { useVoice } from "@opensteer/client/react";
import type { VoiceAsk as VoiceAskValue } from "@opensteer/client/voice";
import type { Request } from "@opensteer/core";
import { ShellScope, useShell, type ShellSharedContext } from "./app-shell.js";
import { RequestStack, useRequestDock } from "./input-surface.js";
import { PasswordsSuggestion } from "./passwords-suggestion.js";

const noRequests: readonly Request[] = [];

/**
 * What needs the person on this call: the same cards a conversation docks. The
 * call follows them onto pages with a stable shell, so the cards read it live.
 */
export function VoiceAsk({ shell }: { readonly shell: ShellSharedContext }) {
  const { ask } = useVoice().snapshot;
  if (!ask) return null;
  return (
    <ShellScope context={shell} live>
      <VoiceAskCards ask={ask} />
    </ShellScope>
  );
}

function VoiceAskCards({ ask }: { readonly ask: VoiceAskValue }) {
  const { voiceThreadId } = useShell().snapshot;
  if (!voiceThreadId) return null;
  return ask.kind === "passwords" ? (
    <div className="voice-ask">
      <PasswordsSuggestion offer={ask.offer} />
    </div>
  ) : (
    <VoiceRequests threadId={voiceThreadId} />
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
