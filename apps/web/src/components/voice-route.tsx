import { useContext, useState } from "react";
import { VoiceContext } from "@opensteer/client/react";
import { useShell } from "./app-shell.js";
import { ThreadSurface } from "./thread-view.js";
import { AreaHeader } from "./workspace/conversation-header.js";
import { Icon } from "./icon.js";

/**
 * Voice: control Opensteer by talking. Its own place, holding the calls'
 * history and anything a call asked; the tasks it starts are ordinary tasks.
 */
export function VoiceRoute() {
  const { hostClient, reportActionError, snapshot } = useShell();
  const controller = useContext(VoiceContext);
  const [opening, setOpening] = useState(false);
  if (snapshot.voiceThreadId) return <ThreadSurface threadId={snapshot.voiceThreadId} />;
  return (
    <div className="thread">
      <AreaHeader hostClient={hostClient} title="Voice" />
      <div className="hero">
        <div className="hero__inner">
          <h1 className="hero__title">Talk to Opensteer</h1>
          <p className="hero__subtitle">
            Ask out loud. Your agent starts tasks, answers what waits on you and shows you what it
            did.
          </p>
          <button
            className="btn btn--primary"
            disabled={!controller || opening}
            onClick={() => {
              setOpening(true);
              void controller
                ?.openThread()
                .catch(reportActionError)
                .finally(() => setOpening(false));
            }}
            type="button"
          >
            <Icon name="waveform" /> {opening ? "Opening…" : "Start Voice"}
          </button>
        </div>
      </div>
    </div>
  );
}
