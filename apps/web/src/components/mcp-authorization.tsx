import {
  AgentConnectionAuthorizationTargetSchema,
  agentConnectionDeepLink,
} from "@opensteer/protocol";
import {
  opensteerDesktopClient,
  opensteerMobileClient,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useEffect, useRef, useState } from "react";
import type { AgentConnectionConsent } from "@opensteer/protocol";
import { Icon } from "./icon.js";
import { SectionHeader } from "./settings/primitives.js";
import {
  accessModeOptions,
  answerAgentConnection,
  connectionDestination,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";

export function McpAuthorization({
  client,
  requestId,
  desktopBridge = null,
  onClose,
}: {
  readonly client: HostClient;
  readonly requestId: string | null;
  readonly desktopBridge?: Pick<OpensteerDesktopBridge, "openExternalUrl"> | null;
  readonly onClose?: (() => void) | undefined;
}) {
  const [consent, setConsent] = useState<AgentConnectionConsent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<ThreadAccessMode>("approval-required");
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    ++revision.current;
    setConsent(null);
    setError(null);
    setBusy(false);
    setLabel("");
    setMode("approval-required");
    if (!requestId) {
      setError("This connection request is missing. Start again from the agent.");
      return;
    }
    void client.rpc["connections.authorization.get"]({ requestId }, { signal: controller.signal })
      .then(unwrapRpcResult)
      .then((result) => {
        if (controller.signal.aborted) return;
        setConsent(result);
        setLabel(result.clientName);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("This connection request could not be loaded. Start again from the agent.");
      });
    return () => {
      controller.abort();
      ++revision.current;
    };
  }, [client, requestId]);
  async function decide(approve: boolean) {
    if (!consent || busy) return;
    const currentRevision = revision.current;
    setBusy(true);
    setError(null);
    try {
      const completion = await answerAgentConnection(
        client,
        consent,
        approve ? { kind: "approve", label, accessMode: mode } : { kind: "deny" },
      );
      if (currentRevision !== revision.current) return;
      if (desktopBridge) {
        await desktopBridge.openExternalUrl({ url: completion });
        if (currentRevision === revision.current) onClose?.();
      } else window.location.assign(completion);
    } catch {
      if (currentRevision !== revision.current) return;
      setError("The connection could not be approved. Refresh and try again.");
      setBusy(false);
    }
  }
  return (
    <main className="page settings settings-layout">
      <div className="settings-content">
        <div className="settings-content__inner agent-consent">
          {consent ? (
            <>
              <SectionHeader
                title={`Allow ${consent.clientName} to use Opensteer?`}
                lead="App names come from the app and are not verified. Only allow an agent you just added."
              />
              <p className="agent-consent__where">
                <Icon name="globe" />
                <span>{connectionDestination(consent.redirectUri)}</span>
              </p>
              <fieldset className="settings-group" disabled={busy}>
                <legend className="settings-group__title">What it can change</legend>
                <div className="card">
                  {accessModeOptions.map((option) => (
                    <label className="card__row agent-consent__mode" key={option.mode}>
                      <input
                        checked={mode === option.mode}
                        name="agent-consent-mode"
                        onChange={() => setMode(option.mode)}
                        type="radio"
                        value={option.mode}
                      />
                      <span className="card__row-body">
                        <span className="card__row-title">{option.label}</span>
                        <span className="card__row-detail">{option.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="text-input"
                  value={label}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <p className="settings-footnote">
                It can't approve requests, see passwords or give anyone access. This lasts 30 days,
                and you can remove it any time in Settings → External agents.
              </p>
              <div className="form-actions">
                <button
                  className="btn"
                  disabled={busy}
                  type="button"
                  onClick={() => void decide(false)}
                >
                  Deny
                </button>
                <button
                  className="btn btn--primary"
                  disabled={busy || !label.trim()}
                  type="button"
                  onClick={() => void decide(true)}
                >
                  Allow
                </button>
              </div>
            </>
          ) : !error ? (
            <p role="status">Loading connection request…</p>
          ) : null}
          {error ? (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          ) : null}
          {onClose ? (
            <button className="btn" type="button" onClick={onClose}>
              Back to Opensteer
            </button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/**
 * A phone or tablet hands the request to the mobile app; anything else to the
 * desktop app. iPad Safari presents itself as a Mac, so touch tells them apart.
 */
function installedClient() {
  const agent = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/u.test(agent) ||
    (/Macintosh/u.test(agent) && navigator.maxTouchPoints > 1)
    ? { client: opensteerMobileClient, device: "phone" }
    : { client: opensteerDesktopClient, device: "computer" };
}

export function McpAuthorizationLaunch({
  requestId,
  deploymentId,
}: {
  readonly requestId: string | null;
  readonly deploymentId: string | null;
}) {
  const target = AgentConnectionAuthorizationTargetSchema.safeParse({ requestId, deploymentId });
  const { client, device } = installedClient();
  return (
    <main className="page settings settings-layout">
      <div className="settings-content">
        <div className="settings-content__inner">
          <SectionHeader
            title="Review the agent in Opensteer"
            lead={`Open the Opensteer app on this ${device} to choose what the agent can do. This link carries no sign-in and approves nothing.`}
          />
          {target.success ? (
            <a
              className="btn btn--primary"
              href={agentConnectionDeepLink(client.applicationId, target.data)}
            >
              Open Opensteer
            </a>
          ) : (
            <p className="notice notice--error" role="alert">
              This connection request is invalid. Start again from the agent.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
