import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { settingsSessionRows } from "@opensteer/client/settings";
import type { AuthSessionSummary } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Linking } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import {
  accountSettingsModel,
  sessionActivityLine,
  signOutAccountInOrder,
} from "./settings-model.js";
import {
  remoteAccessSections,
  type RemoteAccessActionId,
  type RemoteAccessTurnOn,
} from "./settings-remote-access.js";
import { useSettingsHost } from "./use-settings-host.js";
import { useSettingsLease } from "./use-settings-read.js";

/** Account: who you are, using this computer from anywhere, and where you're signed in. */
export function AccountSettingsController(props: { readonly sessionId?: string } = {}): ReactNode {
  const [revision, setRevision] = useState(0);
  return (
    <AccountSettingsContent
      key={revision}
      {...props}
      onReload={() => setRevision((value) => value + 1)}
    />
  );
}

function AccountSettingsContent(props: {
  readonly sessionId?: string;
  readonly onReload: () => void;
}): ReactNode {
  const navigation = useNavigation();
  const client = useMobileClient();
  const notifications = useMobileNotifications();
  const { account, selection } = useMobileState();
  const host = selection.hostClient;
  const snapshot = useSettingsHost(host);
  const isCurrent = useSettingsLease(host);
  const remote = usePersonalRemoteAccess(snapshot !== null ? host : null);
  const latestRemote = useRef(remote);
  latestRemote.current = remote;
  const [sessions, setSessions] = useState<readonly AuthSessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountWorking, setAccountWorking] = useState(false);
  const accountInFlight = useRef(false);
  const [turnOn, setTurnOn] = useState<RemoteAccessTurnOn | null>(null);
  const turnOnRun = useRef(0);
  const [privateAddress, setPrivateAddress] = useState<string | null>(null);
  const computer = snapshot?.identityConfig?.deployment.name ?? "This computer";

  useEffect(() => {
    setSessions(null);
    setSessionsError(null);
    if (!host) return;
    void host.rpc["sessions.list"]({})
      .then((result) => {
        if (!isCurrent() || client.getSnapshot().selection.hostClient !== host) return;
        if (result.ok) setSessions(settingsSessionRows(result.data.sessions));
        else setSessionsError(result.error.message);
      })
      .catch(() => {
        if (isCurrent()) setSessionsError("This phone couldn’t load where you’re signed in.");
      });
  }, [client, host, isCurrent]);

  // Turn on hands over to the Host's own operation once it reports one.
  const status = remote.status;
  useEffect(() => {
    if (turnOn?.step !== "request" || turnOn.failed !== null || remote.working) return;
    if (remote.error !== null) setTurnOn({ ...turnOn, failed: remote.error });
    else if (status?.operation || status?.access.mode !== "off") setTurnOn(null);
  }, [turnOn, remote.working, remote.error, status]);

  const runAccount = useCallback((operation: () => Promise<void>, fallback: string) => {
    if (accountInFlight.current) return;
    accountInFlight.current = true;
    setAccountError(null);
    setAccountWorking(true);
    void operation()
      .catch((error: unknown) => setAccountError(operationDetail(error, fallback)))
      .finally(() => {
        accountInFlight.current = false;
        setAccountWorking(false);
      });
  }, []);

  const signOutAccount = () =>
    Alert.alert(
      "Sign out of your Opensteer Account?",
      "Computers your Account lists leave this phone. Computers you added yourself stay.",
      [
        { style: "cancel", text: "Cancel" },
        {
          style: "destructive",
          text: "Sign out",
          onPress: () =>
            runAccount(
              () =>
                signOutAccountInOrder(
                  async () => {
                    await client.clearAccountSavedViews();
                    await notifications.registration.signOut();
                  },
                  () => client.signOutAccount(),
                ),
              "Sign-out didn’t finish. Try again while this phone is online.",
            ),
        },
      ],
    );

  const signOutSession = (session: AuthSessionSummary) =>
    Alert.alert(
      session.current ? "Sign out on this phone?" : `Sign out ${session.deviceLabel}?`,
      session.current
        ? `This phone leaves ${computer}. You can sign in again later.`
        : `It will need to sign in again to open ${computer}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            if (removing || !isCurrent()) return;
            setRemoving(true);
            setSessionsError(null);
            void client
              .removeHostSession(session)
              .then(() => {
                if (!isCurrent()) return;
                setSessions((current) => current?.filter((row) => row.id !== session.id) ?? null);
                if (props.sessionId !== undefined) navigation.goBack();
              })
              .catch((error: unknown) =>
                setSessionsError(operationDetail(error, "Sign-out didn’t finish. Try again.")),
              )
              .finally(() => setRemoving(false));
          },
        },
      ],
    );

  const confirm = (title: string, detail: string, label: string, run: () => void) =>
    Alert.alert(title, detail, [
      { text: "Cancel", style: "cancel" },
      { text: label, style: "destructive", onPress: run },
    ]);

  const request = (intent: Parameters<NonNullable<typeof remote.request>>[0]) => {
    if (isCurrent()) void remote.request?.(intent);
  };

  // Only what's missing: sign in, then add this computer to the Account, then turn on.
  const startTurnOn = () => {
    const run = ++turnOnRun.current;
    const stale = () => run !== turnOnRun.current || !isCurrent();
    const signedInFirst = account.account.identity === null;
    void (async () => {
      let step: RemoteAccessTurnOn["step"] = "sign-in";
      try {
        if (signedInFirst) {
          setTurnOn({ step, signedInFirst, failed: null });
          await client.signInAccount();
          if (stale()) return;
        }
        if (latestRemote.current.status?.access.accountLink?.state !== "active") {
          step = "link";
          setTurnOn({ step, signedInFirst, failed: null });
          await client.linkSelectedPersonalAccount();
          if (stale()) return;
        }
        step = "request";
        setTurnOn({ step, signedInFirst, failed: null });
        await latestRemote.current.request?.({
          action: "configure",
          mode: "connect",
          privateOrigin: null,
        });
      } catch (error) {
        if (stale()) return;
        setTurnOn({
          step,
          signedInFirst,
          failed:
            step === "sign-in"
              ? "Sign-in wasn’t finished. Nothing changed."
              : operationDetail(error, "Something went wrong. Try again."),
        });
      }
    })();
  };

  const act = (action: RemoteAccessActionId) => {
    const operation = status?.operation ?? null;
    switch (action) {
      case "turn-on":
        startTurnOn();
        return;
      case "try-again":
        if (turnOn !== null || operation?.state !== "failed") startTurnOn();
        else request({ action: "recover" });
        return;
      case "cancel":
        turnOnRun.current += 1;
        setTurnOn(null);
        // Off replaces work the Host already accepted; it never pretends it didn't happen.
        if (operation !== null && operation.state !== "succeeded")
          request({ action: "configure", mode: "off", privateOrigin: null });
        return;
      case "turn-off":
        confirm("Turn off use from anywhere?", remoteAccessDisconnectWarning, "Turn off", () => {
          turnOnRun.current += 1;
          setTurnOn(null);
          request({ action: "configure", mode: "off", privateOrigin: null });
        });
        return;
      case "remove-link":
        confirm(
          `Remove ${computer} from this Account?`,
          remoteAccessDisconnectWarning,
          "Remove",
          () => request({ action: "unlink" }),
        );
        return;
      case "rotate":
        confirm("Reset the connection key?", remoteAccessDisconnectWarning, "Reset", () =>
          request({ action: "rotate" }),
        );
        return;
      case "pair":
        if (isCurrent()) void remote.pair?.();
        return;
      case "private":
        setPrivateAddress(
          status?.access.mode === "private"
            ? (status.access.route?.document.route.origin ?? "")
            : "",
        );
        return;
      case "reload":
        props.onReload();
        return;
    }
  };

  const accountModel = accountSettingsModel(account.account, accountWorking);
  const sessionRow = (session: AuthSessionSummary): NativeSettingsRow => ({
    key: session.id,
    kind: "button",
    label: session.deviceLabel,
    detail: sessionActivityLine(session, new Date()),
    opens: true,
    disabled: removing,
    onPress: () => {
      if (selection.deploymentId)
        navigation.navigate("SettingsSessionDetail", {
          deploymentId: selection.deploymentId,
          sessionId: session.id,
        });
    },
    actions: [{ label: "Sign out", destructive: true, onPress: () => signOutSession(session) }],
  });

  const sections: NativeSettingsSection[] = [];
  if (props.sessionId !== undefined) {
    const session = sessions?.find((row) => row.id === props.sessionId);
    sections.push(
      session === undefined
        ? {
            key: "session",
            title: "",
            rows: [
              {
                key: "missing",
                kind: "text",
                label: sessions === null ? "Loading…" : "This device is no longer signed in.",
              },
            ],
          }
        : {
            key: "session",
            title: "",
            rows: [
              {
                key: "device",
                kind: "text",
                label: session.deviceLabel,
                detail: sessionActivityLine(session, new Date()),
              },
              {
                key: "sign-out",
                kind: "button",
                label: "Sign out",
                destructive: true,
                disabled: removing,
                onPress: () => signOutSession(session),
              },
            ],
            footer: sessionsError
              ? { text: sessionsError, tone: "danger" }
              : {
                  text: session.current
                    ? `Signing out here removes ${computer} from this phone.`
                    : `It will need to sign in again to open ${computer}.`,
                },
          },
    );
    return <NativeSettingsPage sections={sections} />;
  }

  if (accountModel !== null) {
    const signedIn = accountModel.action?.kind === "sign-out";
    sections.push({
      key: "account",
      title: "",
      rows: [
        {
          key: "identity",
          kind: "text",
          label: signedIn ? accountModel.title : "Not signed in",
          detail: signedIn ? "Opensteer Account" : "Sign in to reach your computers",
          ...(accountModel.initial === null ? {} : { initial: accountModel.initial }),
        },
        ...(!signedIn && accountModel.action
          ? [
              {
                key: "sign-in",
                kind: "button" as const,
                label: accountModel.action.label,
                disabled: accountModel.action.disabled,
                onPress: () =>
                  runAccount(
                    () => client.signInAccount(),
                    "Sign-in wasn’t finished. Try again and approve it in your browser.",
                  ),
              },
            ]
          : []),
      ],
      ...(accountError ? { footer: { text: accountError, tone: "danger" as const } } : {}),
    });
  }
  if (host && snapshot !== null)
    sections.push(
      ...remoteAccessSections(
        {
          status,
          error: remote.error,
          signedIn: account.account.identity !== null,
          account: account.account.identity,
          computer,
          turnOn,
          pairing: remote.pairing,
          now: Date.now(),
        },
        act,
      ),
    );
  if (host && (sessions === null || sessions.length > 0 || sessionsError))
    sections.push({
      key: "sessions",
      title: "Where you’re signed in",
      rows:
        sessions === null
          ? [{ key: "loading", kind: "text", label: sessionsError ? "Couldn’t load" : "Loading…" }]
          : sessions.map(sessionRow),
      ...(sessionsError ? { footer: { text: sessionsError, tone: "danger" as const } } : {}),
    });
  if (accountModel?.action?.kind === "sign-out")
    sections.push({
      key: "account-actions",
      title: "",
      rows: [
        {
          key: "account-sign-out",
          kind: "button",
          label: accountWorking ? "Signing out…" : "Sign out",
          destructive: true,
          disabled: accountModel.action.disabled,
          onPress: signOutAccount,
        },
        ...(client.portalOrigin
          ? [
              {
                key: "account-delete",
                kind: "button" as const,
                label: "Delete Account…",
                destructive: true,
                onPress: () => void Linking.openURL(`${client.portalOrigin}/account/delete`),
              },
            ]
          : []),
      ],
    });

  return (
    <>
      <NativeSettingsPage sections={sections} />
      {privateAddress === null ? null : (
        <NativeSettingsPage
          sheet={{ title: "Private network", onClose: () => setPrivateAddress(null) }}
          sections={[
            {
              key: "private",
              title: "",
              rows: [
                {
                  key: "address",
                  kind: "input",
                  label: "https://your-computer.example",
                  value: privateAddress,
                  onChange: setPrivateAddress,
                },
                {
                  key: "apply",
                  kind: "primary",
                  label: "Use this address",
                  disabled: !privateAddress.trim().startsWith("https://"),
                  onPress: () => {
                    const origin = privateAddress.trim();
                    setPrivateAddress(null);
                    request({ action: "configure", mode: "private", privateOrigin: origin });
                  },
                },
              ],
              footer: { text: remoteAccessDisconnectWarning },
            },
          ]}
        />
      )}
    </>
  );
}
