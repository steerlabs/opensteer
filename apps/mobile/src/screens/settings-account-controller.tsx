import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { usePersonalRemoteAccess, useRemoteAccess } from "@opensteer/client/react";
import { sessionActivityLine, settingsSessionRows } from "@opensteer/client/settings";
import type { AuthSessionSummary } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Linking } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { mobileRemoteAccessPort } from "../client/remote-access-port.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { phoneLeaves } from "./device-page-model.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { accountSettingsModel, signOutAccountInOrder } from "./settings-model.js";
import { remoteAccessSections, type RemoteAccessRowAction } from "./settings-remote-access.js";
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
  const { account, rows, selection } = useMobileState();
  const enrolledIn = useIphoneAppsState(useIphoneApps()).snapshot.enrollment?.deploymentId;
  // Only an Account-listed Opensteer leaves with the Account.
  const enrolledVia =
    rows.find((row) => row.deploymentId === enrolledIn && row.accountManaged) ?? null;
  const host = selection.hostClient;
  const snapshot = useSettingsHost(host);
  const isCurrent = useSettingsLease(host);
  const remote = usePersonalRemoteAccess(snapshot !== null ? host : null);
  const [sessions, setSessions] = useState<readonly AuthSessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountWorking, setAccountWorking] = useState(false);
  const accountInFlight = useRef(false);
  const [privateAddress, setPrivateAddress] = useState<string | null>(null);
  const computerName = snapshot?.identityConfig?.deployment.name ?? null;
  const computer = computerName ?? "This computer";
  const port = useMemo(() => mobileRemoteAccessPort(client), [client]);
  const remoteAccess = useRemoteAccess({
    computerName,
    hostClient: snapshot !== null ? host : null,
    link: null,
    port,
    remote,
    signedIn: account.account.identity !== null,
  });

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
      [
        enrolledVia === null ? null : phoneLeaves(thisPhoneNoun, enrolledVia.name),
        `Opensteers your Account lists leave this ${thisPhoneNoun}. Ones you added yourself stay.`,
      ]
        .filter((part): part is string => part !== null)
        .join(" "),
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

  const act = (row: RemoteAccessRowAction) => {
    if (row.kind === "reload") {
      props.onReload();
      return;
    }
    if (row.kind === "private") {
      const { view } = remoteAccess;
      setPrivateAddress(view.state === "on-private" ? (view.address ?? "") : "");
      return;
    }
    const { action } = row;
    if (action.confirm === null) remoteAccess.act(action.id);
    else
      confirm(`${action.label}?`, action.confirm, action.label, () => remoteAccess.act(action.id));
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
          view: remoteAccess.view,
          computer,
          pairing: remoteAccess.pairing,
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
                    if (isCurrent()) remoteAccess.setPrivateNetwork(origin);
                  },
                },
              ],
              ...(remoteAccess.view.on ? { footer: { text: remoteAccessDisconnectWarning } } : {}),
            },
          ]}
        />
      )}
    </>
  );
}
