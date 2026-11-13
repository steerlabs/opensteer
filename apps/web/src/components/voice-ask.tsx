import { useVoiceValue } from "@opensteer/client/react";
import type { VoiceAsk as VoiceAskValue, VoiceSnapshot } from "@opensteer/client/voice";
import type { Request } from "@opensteer/core";
import { ShellScope, useShell } from "./app-shell.js";
import { RequestStack, useRequestDock } from "./input-surface.js";
import { PasswordsSuggestion } from "./passwords-suggestion.js";
import { useDeviceGrantFollowUps } from "./thread-device-access-action.js";

const noRequests: readonly Request[] = [];
const selectAsk = ({ ask }: VoiceSnapshot) => ask;

/**
 * What needs the person on this call: the same cards a conversation docks. The
 * call follows them onto pages with a stable shell, so the cards read it live.
 * A macOS grant a request left to finish stays after the ask ends.
 */
export function VoiceAsk() {
  const ask = useVoiceValue(selectAsk);
  return (
    <ShellScope live={ask !== null}>
      {ask ? <VoiceAskCards ask={ask} /> : <VoiceFollowUps />}
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

function VoiceFollowUps() {
  const { voiceThreadId } = useShell().snapshot;
  return voiceThreadId ? <VoiceFollowUpCards threadId={voiceThreadId} /> : null;
}

function VoiceFollowUpCards({ threadId }: { readonly threadId: string }) {
  const followUps = useDeviceGrantFollowUps({ threadId });
  return followUps ? <div className="request-stack">{followUps}</div> : null;
}
