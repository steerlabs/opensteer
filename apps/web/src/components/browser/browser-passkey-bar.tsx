import {
  passkeyAgentNotice,
  passkeyNotice,
  type BrowserPasskeyState,
} from "@opensteer/client/host";
import { useState } from "react";
export function BrowserPasskeyBar({
  state,
  onContinue,
}: {
  readonly state: BrowserPasskeyState;
  readonly onContinue: () => Promise<void>;
}) {
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state) return null;
  return (
    <div className="browser-passkey-bar" role="status">
      {state.kind === "notice" ? (
        <span>{passkeyNotice}</span>
      ) : (
        <>
          <span>
            <strong>{state.rpId}</strong> wants to use a passkey
            {state.agent ? <small>{passkeyAgentNotice}</small> : null}
            {error ? <small>{error}</small> : null}
          </span>
          <button
            className="btn"
            type="button"
            disabled={continuing}
            onClick={() => {
              setContinuing(true);
              setError(null);
              void onContinue().catch(() => {
                setError("The passkey request ended. Try again on the page.");
                setContinuing(false);
              });
            }}
          >
            Continue
          </button>
        </>
      )}
    </div>
  );
}
