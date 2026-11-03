import { Link } from "react-router";
import { Icon } from "../../icon.js";
import { useState } from "react";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import type { PersonalRemoteAccessMode } from "@opensteer/protocol";
import { Dialog } from "../../dialog.js";
import { useShell } from "../../app-shell.js";
import { SettingsError, SettingsGroup, SettingsRow, type SettingsView } from "../primitives.js";
import { linkAccountFromWeb } from "../link-personal-account.js";

export function RemoteAccessSection({
  view,
  compact = false,
}: {
  readonly view: SettingsView;
  readonly compact?: boolean;
}) {
  const shell = useShell();
  const remote = usePersonalRemoteAccess(shell.hostClient);
  const [choosingMode, setChoosingMode] = useState(false);
  const [draft, setDraft] = useState<PersonalRemoteAccessMode | null>(null);
  const [privateOrigin, setPrivateOrigin] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const access = remote.status?.access;
  const mode = draft ?? access?.mode ?? "off";
  const origin =
    privateOrigin ??
    (access?.mode === "private" ? (access.route?.document.route.origin ?? "") : "");
  const operation = remote.status?.operation;
  const pending = operation?.state === "pending" || operation?.state === "running";
  const busy = remote.working || linking;
  const request = (intent: Parameters<NonNullable<typeof remote.request>>[0]) => {
    if (
      (intent.action === "unlink" || (intent.action === "configure" && access?.mode !== "off")) &&
      !window.confirm(remoteAccessDisconnectWarning)
    )
      return;
    void remote.request?.(intent);
  };
  return (
    <SettingsGroup
      heading="Open Opensteer from anywhere"
      headingId="settings-remote-access-heading"
    >
      <SettingsRow
        icon="globe"
        title={
          compact ? (
            <Link to="/settings/account/remote-access">Open Opensteer from anywhere</Link>
          ) : (
            "Open Opensteer from anywhere"
          )
        }
        detail={
          access?.mode === "private"
            ? "Private network"
            : access?.mode === "connect"
              ? "Connect · ready"
              : "Off"
        }
        action={
          <input
            type="checkbox"
            className="switch"
            role="switch"
            aria-label="Open Opensteer from anywhere"
            checked={access !== undefined && access.mode !== "off"}
            disabled={!access || busy || pending}
            onChange={(event) => {
              if (event.currentTarget.checked) {
                setDraft(remote.status?.accountIssuer ? "connect" : "private");
                setChoosingMode(true);
              } else request({ action: "configure", mode: "off", privateOrigin: null });
            }}
          />
        }
      />
      {compact ? null : (
        <button className="btn btn--ghost" type="button" onClick={() => setChoosingMode(true)}>
          Connection options <Icon name="chevron-right" />
        </button>
      )}
      {choosingMode ? (
        <Dialog
          labelledBy="remote-mode-title"
          title="Open from anywhere"
          onClose={() => setChoosingMode(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setChoosingMode(false);
              request({
                action: "configure",
                mode,
                privateOrigin: mode === "private" ? origin.trim() : null,
              });
            }}
          >
            <div className="settings-plugin-filters" role="group" aria-label="Remote access">
              {(
                [
                  "off",
                  ...(remote.status?.accountIssuer ? ["connect" as const] : []),
                  "private",
                ] as const
              ).map((value) => (
                <button
                  className="btn"
                  aria-pressed={mode === value}
                  type="button"
                  disabled={busy}
                  key={value}
                  onClick={() => setDraft(value)}
                >
                  {value === "off"
                    ? "Off"
                    : value === "connect"
                      ? "Opensteer Connect"
                      : "Private network"}
                </button>
              ))}
            </div>
            <p className="settings-footnote">{remoteAccessDisconnectWarning}</p>
            {mode === "private" ? (
              <label>
                Private HTTPS address
                <input
                  aria-label="Private HTTPS address"
                  type="url"
                  required
                  value={origin}
                  onChange={(event) => setPrivateOrigin(event.target.value)}
                />
              </label>
            ) : null}
            <button
              className="btn btn--small"
              type="submit"
              disabled={!access || busy || (pending && mode !== "off")}
            >
              Apply
            </button>
          </form>
        </Dialog>
      ) : null}
      {compact ? null : (
        <>
          {" "}
          <SettingsRow
            icon="devices"
            title="Connection"
            detail={
              access
                ? `${access.mode}${access.route ? ` · ${access.route.document.route.origin}` : ""}`
                : "Loading remote access…"
            }
          />
          {operation ? (
            <SettingsRow icon="devices" title={operation.state} detail={operation.detail} />
          ) : null}
          {access?.mode === "connect" ? (
            <SettingsRow
              icon="devices"
              title="Connect credential"
              action={
                <button
                  className="btn btn--small"
                  type="button"
                  disabled={busy || pending}
                  onClick={() => request({ action: "rotate" })}
                >
                  Rotate
                </button>
              }
            />
          ) : null}
          <SettingsRow
            icon="devices"
            title="Recovery"
            action={
              <button
                className="btn btn--small"
                type="button"
                disabled={busy || pending}
                onClick={() => request({ action: "recover" })}
              >
                Recover
              </button>
            }
          />
          {remote.status?.accountIssuer ? (
            <SettingsRow
              icon="devices"
              title="Opensteer Account"
              detail={
                access?.accountLink
                  ? `${access.accountLink.issuer} · ${access.accountLink.subject} · ${access.accountLink.state}`
                  : "No Account linked"
              }
              action={
                access?.accountLink ? (
                  <button
                    className="btn btn--small"
                    disabled={busy || pending}
                    type="button"
                    onClick={() => request({ action: "unlink" })}
                  >
                    Unlink
                  </button>
                ) : (
                  <button
                    className="btn btn--small"
                    disabled={busy || pending}
                    type="button"
                    onClick={() => {
                      if (!remote.status) return;
                      setLinking(true);
                      setLinkError(null);
                      void linkAccountFromWeb(shell, remote.status, view.name)
                        .catch((error: unknown) =>
                          setLinkError(
                            error instanceof Error ? error.message : "Account linking failed",
                          ),
                        )
                        .finally(() => setLinking(false));
                    }}
                  >
                    {linking ? "Linking…" : "Link Account"}
                  </button>
                )
              }
            />
          ) : null}
          {access?.mode === "private" ? (
            <SettingsRow
              icon="devices"
              title="Add another device"
              detail="Pairing codes expire after ten minutes and can be used once."
              action={
                <button
                  className="btn btn--small"
                  disabled={busy || pending}
                  type="button"
                  onClick={() => void remote.pair?.()}
                >
                  Create pairing code
                </button>
              }
            />
          ) : null}
          {remote.pairing ? (
            <SettingsRow
              icon="devices"
              title="Pairing code"
              detail={
                <>
                  <code>{remote.pairing.code}</code>
                  <p>Expires {new Date(remote.pairing.expiresAt).toLocaleTimeString()}</p>
                </>
              }
            />
          ) : null}
        </>
      )}
      <SettingsError message={linkError ?? remote.error} />
    </SettingsGroup>
  );
}
