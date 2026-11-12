import { useCallback, useRef, useState } from "react";
import { settingsSessionRows } from "@opensteer/client/settings";
import { Link } from "react-router";
import type { AuthSessionSummary } from "@opensteer/core";
import { computerGlyph, hostsDeployment } from "@opensteer/client/computers";
import {
  formatRelativeTime,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { computerIcon } from "../../computers/device-art.js";
import type { IconName } from "../../icon.js";
import { LoadingRows } from "../../loading-rows.js";
import { useToast } from "../../toast.js";
import {
  SettingsError,
  SettingsGroup,
  SettingsRow,
  SettingsSignOut,
  formatWhen,
  type SettingsView,
} from "../primitives.js";
import { useSettingsRead } from "../use-settings-read.js";

/** Every device you are signed in from, this one first, in one list. */
export function SignedInDevicesSection({
  view,
  sessionId,
}: {
  readonly view: SettingsView;
  readonly sessionId?: string;
}) {
  const sessions = useSessions();
  const list = sessionId
    ? (sessions.list?.filter((session) => session.id === sessionId) ?? null)
    : sessions.list;
  const current = list?.find((session) => session.current) ?? null;
  const others = list?.filter((session) => !session.current) ?? [];
  return (
    <SettingsGroup heading="Where you’re signed in" headingId="settings-sessions-heading">
      {current ? <CurrentSessionRow current={current} name={view.name} /> : null}
      {others.map((session) => (
        <SettingsRow
          action={
            <SettingsSignOut
              label={`Actions for ${session.deviceLabel}`}
              warning={`Sign out ${session.deviceLabel}? Its access ends. Your agents, files and conversations stay on this Opensteer.`}
              pending={sessions.pending !== null}
              onConfirm={() => sessions.remove(session)}
            />
          }
          detail={sessionActivity(session.lastSeenAt)}
          icon={sessionIcon(session)}
          key={session.id}
          title={
            <Link to={`/settings/account/sessions/${encodeURIComponent(session.id)}`}>
              {session.deviceLabel}
            </Link>
          }
        />
      ))}
      {list === null ? <LoadingRows label="Loading devices" rows={2} /> : null}
      <SettingsError message={sessions.error} />
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------------- *
 * Shared pieces
 * ------------------------------------------------------------------------- */

export interface SessionsState {
  readonly error: string | null;
  /** Null until the Host has answered. */
  readonly list: readonly AuthSessionSummary[] | null;
  readonly pending: string | null;
  readonly remove: (session: AuthSessionSummary) => void;
}

/** One read of `sessions.list` per page, shared by every card on it. */
export function useSessions(): SessionsState {
  const { hostClient } = useShell();
  const toast = useToast();
  const sessions = useSettingsRead(
    () => hostClient.rpc["sessions.list"]({}).then(unwrapRpcResult),
    "account-sessions",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const owner = useRef(hostClient);
  owner.current = hostClient;
  const remove = useCallback(
    (session: AuthSessionSummary) => {
      if (pending) return;
      setPending(session.id);
      setError(null);
      void hostClient
        .dispatch({
          idempotencyKey: mutationIdempotencyKey(`session:${session.id}`),
          sessionId: session.id,
          type: "session.revoke",
        })
        .then(() => {
          if (owner.current !== hostClient) return;
          sessions.reload();
          toast.success(`${session.deviceLabel} no longer has access.`);
        })
        .catch((reason: unknown) => {
          if (owner.current === hostClient) setError(actionErrorMessage(reason));
        })
        .finally(() => {
          if (owner.current === hostClient) setPending(null);
        });
    },
    [hostClient, pending, toast, sessions.reload],
  );

  return {
    error: error ?? (sessions.error ? actionErrorMessage(sessions.error) : null),
    list: sessions.data ? settingsSessionRows(sessions.data.sessions) : null,
    pending,
    remove,
  };
}

/** The Mac a Personal Opensteer runs on, as the Computers page draws it. */
export function useHomeComputer(): { readonly icon: IconName; readonly name: string | null } {
  const { snapshot } = useShell();
  const home = snapshot.machines.find(hostsDeployment);
  return {
    icon: home ? computerIcon(computerGlyph(home)) : "desktop",
    name: home?.name ?? null,
  };
}

export function sessionIcon(session: AuthSessionSummary): IconName {
  if (session.form === "mobile") return "phone";
  if (session.form === "computer") return "laptop";
  return "devices";
}

/** "Active 3h ago", or the date once it is more than a week old. */
export function sessionActivity(lastSeenAt: string, now = new Date()): string {
  const relative = formatRelativeTime(lastSeenAt, now);
  if (relative === "now") return "Active now";
  return /^\d+[mhd]$/u.test(relative) ? `Active ${relative} ago` : `Last active ${relative}`;
}

/** Signing out here ends this device's Host session, independently of its Account sign-in. */
function CurrentSessionRow({
  current,
  name,
}: {
  readonly current: AuthSessionSummary;
  readonly name: string;
}) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function disconnect() {
    if (pending) return;
    setPending(true);
    setError(null);
    void revokeCurrentSession(hostClient)
      .then(() => window.location.assign("/"))
      .catch((reason: unknown) => {
        setError(actionErrorMessage(reason));
        setPending(false);
      });
  }

  return (
    <>
      <SettingsRow
        action={
          <SettingsSignOut
            label="Session actions"
            warning={`Sign out of ${name} on this device? Nothing on ${name} changes, and you can sign in again anytime.`}
            pending={pending}
            onConfirm={disconnect}
          />
        }
        detail={`Signed in ${formatWhen(current.createdAt)}`}
        icon={sessionIcon(current)}
        title={
          <>
            <Link to={`/settings/account/sessions/${encodeURIComponent(current.id)}`}>
              {current.deviceLabel}
            </Link>
            <span className="chip">This device</span>
          </>
        }
      />
      <SettingsError message={error} />
    </>
  );
}

/** Ends the current Host session for every credential family. */
export async function revokeCurrentSession(
  hostClient: Pick<HostClient, "dispatch" | "rpc">,
): Promise<void> {
  const { sessions } = unwrapRpcResult(await hostClient.rpc["sessions.list"]({}));
  const current = sessions.find((session) => session.current);
  if (!current) throw new Error("This device no longer has an active session.");
  await hostClient.dispatch({
    idempotencyKey: mutationIdempotencyKey(`session:${current.id}`),
    sessionId: current.id,
    type: "session.revoke",
  });
}
