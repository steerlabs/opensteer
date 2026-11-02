import { useCallback, useEffect, useState } from "react";
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
import { HerePin } from "../../computers/here-pin.js";
import type { IconName } from "../../icon.js";
import { LoadingRows } from "../../loading-rows.js";
import { useToast } from "../../toast.js";
import { settingsItem } from "../copy.js";
import {
  SectionHeader,
  SettingsError,
  SettingsGroup,
  SettingsRow,
  formatWhen,
  type SettingsView,
} from "../primitives.js";
import { RemoteAccessSection } from "./remote-access.js";

/** Every device administers the same Deployment and sees its own session inventory. */
export function DevicesSettings({ view }: { readonly view: SettingsView }) {
  return (
    <>
      {view.kind === "personal" && view.administrator ? <RemoteAccessSection view={view} /> : null}
      <SignedInDevicesSection view={view} />
    </>
  );
}

export function DevicesHeader({
  lead,
  view,
}: {
  readonly lead: string;
  readonly view: SettingsView;
}) {
  return <SectionHeader lead={lead} title={settingsItem("devices", view.kind).label} />;
}

/** Every device you are signed in from, this one first. */
function SignedInDevicesSection({ view }: { readonly view: SettingsView }) {
  const sessions = useSessions();
  const current = sessions.list?.find((session) => session.current) ?? null;
  return (
    <>
      <DevicesHeader
        lead={`Where you’re signed in to ${view.name}. Remove any device you don’t recognize.`}
        view={view}
      />
      <ThisDeviceGroup
        current={current}
        detail={current ? `Signed in ${formatWhen(current.createdAt)}` : null}
        loading={sessions.list === null}
        name={view.name}
      />
      <OtherDevicesGroup sessions={sessions} />
      <ComputersPointer />
    </>
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
  const [list, setList] = useState<readonly AuthSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    hostClient.rpc["sessions.list"]({})
      .then((result) => {
        if (!cancelled) setList(unwrapRpcResult(result).sessions);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(actionErrorMessage(reason));
        setList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [hostClient]);

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
          setList((current) => current?.filter((item) => item.id !== session.id) ?? null);
          toast.success(`${session.deviceLabel} no longer has access.`);
        })
        .catch((reason: unknown) => setError(actionErrorMessage(reason)))
        .finally(() => setPending(null));
    },
    [hostClient, pending, toast],
  );

  return { error, list, pending, remove };
}

/** The Mac a Personal Opensteer runs on, as the Computers page draws it. */
export function useHomeComputer(): { readonly icon: IconName; readonly name: string | null } {
  const { snapshot } = useShell();
  const home = snapshot.machines.find((machine) =>
    hostsDeployment(machine, snapshot.deploymentShape?.kind ?? null),
  );
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

/** Removing this device ends its Host session independently of its Account sign-in. */
function ThisDeviceGroup({
  current,
  detail,
  loading,
  name,
}: {
  readonly current: AuthSessionSummary | null;
  readonly detail: string | null;
  readonly loading: boolean;
  readonly name: string;
}) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!loading && !current) return null;

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
    <SettingsGroup
      heading="This device"
      headingId="settings-this-device-heading"
      note={`Disconnecting ends this device’s access to ${name}. Nothing on ${name} changes, and you can connect again anytime.`}
    >
      {current ? (
        <SettingsRow
          action={
            <button
              className="btn btn--small"
              disabled={pending}
              onClick={disconnect}
              type="button"
            >
              {pending ? "Removing…" : "Remove"}
            </button>
          }
          detail={detail}
          icon={sessionIcon(current)}
          title={
            <>
              {current.deviceLabel}
              <HerePin />
            </>
          }
        />
      ) : (
        <LoadingRows label="Loading this device" rows={1} />
      )}
      <SettingsError message={error} />
    </SettingsGroup>
  );
}

/** Every other signed-in session, including the desktop bootstrap session. */
export function OtherDevicesGroup({
  heading = "Other devices",
  note = null,
  sessions,
}: {
  readonly heading?: string;
  readonly note?: string | null;
  readonly sessions: SessionsState;
}) {
  const others = sessions.list?.filter((session) => !session.current) ?? [];
  return (
    <SettingsGroup heading={heading} headingId="settings-other-devices-heading" note={note}>
      {others.map((session) => (
        <SettingsRow
          action={
            <button
              aria-label={`Remove ${session.deviceLabel}`}
              className="btn btn--small"
              disabled={sessions.pending !== null}
              onClick={() => sessions.remove(session)}
              type="button"
            >
              {sessions.pending === session.id ? "Removing…" : "Remove"}
            </button>
          }
          detail={sessionActivity(session.lastSeenAt)}
          icon={sessionIcon(session)}
          key={session.id}
          title={session.deviceLabel}
        />
      ))}
      {sessions.list === null ? (
        <LoadingRows label="Loading devices" rows={2} />
      ) : others.length === 0 ? (
        <p className="card__empty">No other devices are signed in.</p>
      ) : null}
      <SettingsError message={sessions.error} />
    </SettingsGroup>
  );
}

/**
 * The line that answers the question people bring here by mistake. Devices
 * are where you open Opensteer; the computers agents use are elsewhere.
 */
export function ComputersPointer() {
  return (
    <p className="settings-footnote">
      Want agents to use another computer’s apps and files?{" "}
      <Link to="/settings/computers">Add it in Computers</Link>.
    </p>
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
