import {
  AgentConnectionAuthorizationTargetSchema,
  agentConnectionDeepLink,
} from "@opensteer/protocol";
import { opensteerDesktopClient } from "@opensteer/core";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useEffect, useRef, useState } from "react";
import type { AgentConnectionConsent } from "@opensteer/protocol";
import { ThreadAccessModeSchema, type ThreadAccessMode } from "@opensteer/core";
import {
  connectionAccessLabel,
  mutationIdempotencyKey,
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
  const [reach, setReach] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    ++revision.current;
    setConsent(null);
    setError(null);
    setBusy(false);
    setLabel("");
    setMode("approval-required");
    setReach("");
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
        setReach(result.workspaces[0]?.id ?? "user");
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
    if (!consent || busy || !reach) return;
    const currentRevision = revision.current;
    setBusy(true);
    setError(null);
    try {
      const result = await client.dispatch({
        type: "connection.authorize",
        requestId: consent.requestId,
        idempotencyKey: mutationIdempotencyKey("connection-consent"),
        decision: approve
          ? {
              kind: "approve",
              label,
              accessMode: mode,
              reach:
                reach === "user"
                  ? { kind: "user" }
                  : {
                      kind: "workspace",
                      workspaceId: consent.workspaces.find((w) => w.id === reach)!.id,
                    },
            }
          : { kind: "deny" },
      });
      if (currentRevision !== revision.current) return;
      if (result.type !== "connection.authorize") throw new Error();
      if (desktopBridge) {
        await desktopBridge.openExternalUrl({
          url: new URL(result.completionPath, consent.resource).href,
        });
        if (currentRevision === revision.current) onClose?.();
      } else window.location.assign(result.completionPath);
    } catch {
      if (currentRevision !== revision.current) return;
      setError("The connection could not be approved. Refresh and try again.");
      setBusy(false);
    }
  }
  return (
    <main className="page settings">
      <div className="settings-content">
        <div className="settings-content__inner">
          <h1>Connect an agent</h1>
          {consent ? (
            <>
              <p>
                <strong>{consent.clientName}</strong> wants to act for you in Opensteer. App names
                are supplied by the app and are not verified.
              </p>
              <p>
                Returns to <strong>{new URL(consent.redirectUri).origin}</strong>. Connect only an
                agent you recognize.
              </p>
              <label>
                Connection name{" "}
                <input
                  value={label}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label>
                Access ceiling{" "}
                <select
                  value={mode}
                  disabled={busy}
                  onChange={(event) => setMode(ThreadAccessModeSchema.parse(event.target.value))}
                >
                  {ThreadAccessModeSchema.options.map((value) => (
                    <option key={value} value={value}>
                      {connectionAccessLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reach{" "}
                <select
                  value={reach}
                  disabled={busy}
                  onChange={(event) => setReach(event.target.value)}
                >
                  {consent.workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                  <option value="user">Everything I can access</option>
                </select>
              </label>
              <p>
                The agent cannot approve consent, reveal credentials, sign in, or grant access. This
                connection expires in 30 days. You can revoke it in Settings → Devices → Connected
                agents.
              </p>
              <button
                className="btn"
                disabled={busy || !label.trim()}
                type="button"
                onClick={() => void decide(true)}
              >
                Allow connection
              </button>
              <button
                className="btn"
                disabled={busy}
                type="button"
                onClick={() => void decide(false)}
              >
                Deny
              </button>
            </>
          ) : !error ? (
            <p role="status">Loading connection request…</p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
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

export function McpAuthorizationLaunch({
  requestId,
  deploymentId,
}: {
  readonly requestId: string | null;
  readonly deploymentId: string | null;
}) {
  const target = AgentConnectionAuthorizationTargetSchema.safeParse({ requestId, deploymentId });
  return (
    <main className="page settings">
      <div className="settings-content">
        <div className="settings-content__inner">
          <h1>Review the agent connection in Opensteer</h1>
          <p>
            Your Opensteer app is already signed in on this computer. Open it to review the agent’s
            permissions. This link carries no login credential and approves nothing.
          </p>
          {target.success ? (
            <a
              className="btn"
              href={agentConnectionDeepLink(opensteerDesktopClient.applicationId, target.data)}
            >
              Open {opensteerDesktopClient.name}
            </a>
          ) : (
            <p role="alert">This connection request is invalid. Start again from the agent.</p>
          )}
        </div>
      </div>
    </main>
  );
}
