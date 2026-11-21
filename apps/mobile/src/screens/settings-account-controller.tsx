import { remoteAccessDisconnectWarning, unwrapRpcResult } from "@opensteer/client/host";
import { useClientRead, usePersonalRemoteAccess, useRemoteAccess } from "@opensteer/client/react";
import { createClientRead } from "@opensteer/client/reads";
import { sessionActivityLine, settingsSessionRows } from "@opensteer/client/settings";
import type { AuthSessionSummary } from "@opensteer/core";
import { cloudWords } from "@opensteer/client/computers";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Linking } from "react-native";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useIphoneApps, useIphoneAppsState } from "../iphone-apps/context.js";
import { mobileRemoteAccessPort } from "../client/remote-access-port.js";
import {
  notDone,
  readLine,
  settingsFooter,
  useScreenAction,
  failureWords,
} from "../ui/client-feedback.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { phoneLeaves } from "./device-page-model.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { accountSettingsModel, signOutAccountInOrder } from "./settings-model.js";
import { remoteAccessSections, type RemoteAccessRowAction } from "./settings-remote-access.js";
import { homeAccountLinkSections, useHomeAccountLink } from "./settings-home-account-link.js";
import { useSettingsHost } from "./use-settings-host.js";

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
  // A Home on its own server has no Remote access: its Account link has its own card.
  const networked = snapshot?.identityConfig?.exposure === "networked";
  const homeLink = useHomeAccountLink(snapshot !== null ? host : null, networked);
  const remote = usePersonalRemoteAccess(snapshot !== null && !networked ? host : null);
  const sessionsRead = useMemo(
    () =>
      host === null
        ? null
        : createClientRead(host, {
            key: "auth-sessions",
            label: "where you're signed in",
            read: async () =>
              settingsSessionRows(unwrapRpcResult(await host.rpc["sessions.list"]({})).sessions),
          }),
    [host],
  );
  const sessionsState = useClientRead(sessionsRead);
  const sessions = sessionsState.data;
  const sessionsLine = settingsFooter(readLine(sessionsState, sessionsState.refresh));
  const signOutDevice = useScreenAction(host, "session-sign-out", {
    label: "sign out that device",
    done: "signed out",
    happened: "that device was signed out",
    execute: (session: AuthSessionSummary) => client.removeHostSession(session),
    reconcile: async (session) => {
      await sessionsRead?.refresh();
      const listed = sessionsRead?.getSnapshot().data;
      if (!listed) return null;
      return listed.some((row) => row.id === session.id)
        ? notDone("signed out")
        : { kind: "confirmed", value: undefined };
    },
  });
  const removing = signOutDevice.running;
  const sessionsFooter = settingsFooter(signOutDevice.line) ?? sessionsLine;
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

  const runAccount = useCallback((operation: () => Promise<void>, fallback: string) => {
    if (accountInFlight.current) return;
    accountInFlight.current = true;
    setAccountError(null);
    setAccountWorking(true);
    void operation()
      .catch((error: unknown) =>
        setAccountError(failureWords(error, { label: "finish that" }, fallback)),
      )
      .finally(() => {
        accountInFlight.current = false;
        setAccountWorking(false);
      });
  }, []);

  const signOutAccount = () =>
    Alert.alert(
      "Sign out of your Opensteer account?",
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
            if (removing) return;
            void signOutDevice.run(session).then((outcome) => {
              if (outcome.kind !== "confirmed") return;
              sessionsRead?.invalidate();
              if (props.sessionId !== undefined) navigation.goBack();
            });
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
              sessions === null
                ? { key: "missing", kind: "placeholder", label: "Not loaded yet" }
                : { key: "missing", kind: "text", label: "This device is no longer signed in." },
            ],
            ...(sessionsLine ? { footer: sessionsLine } : {}),
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
            footer: sessionsFooter ?? {
              text: session.current
                ? `Signing out here removes ${computer} from this phone.`
                : `It will need to sign in again to open ${computer}.`,
            },
          },
    );
    return <NativeSettingsPage sections={sections} />;
  }

  // The person's name first: what their agent calls them.
  const owner = host?.getSnapshot().ownerProfile ?? null;
  if (owner !== null)
    sections.push({
      key: "name",
      title: "",
      rows: [
        {
          key: "name",
          kind: "button",
          label: owner.name ?? "Add your name",
          detail: owner.accountBacked
            ? "Your name · kept with your Opensteer account"
            : "Your name · stays on your computer",
          opens: true,
          onPress: () => navigation.navigate("YourName", { target: "owner" }),
        },
      ],
    });
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
          detail: signedIn ? "Opensteer account" : "Sign in to reach your computers",
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
  if (homeLink)
    sections.push(
      ...homeAccountLinkSections(homeLink.state, {
        link: () => void homeLink.client.link(() => client.linkSelectedPersonalAccount()),
        unlink: () => void homeLink.client.unlink(),
        confirm: (question, proceed) =>
          Alert.alert(question, undefined, [
            { style: "cancel", text: "Cancel" },
            { style: "destructive", text: "Unlink", onPress: proceed },
          ]),
      }),
    );
  else if (host && snapshot !== null)
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
  sections.push({
    key: "cloud-computer",
    title: "",
    rows: [
      {
        key: "cloud-computer",
        kind: "button",
        label: cloudWords("cloud.entry.title"),
        detail: cloudWords("cloud.entry.detail"),
        symbol: "cloud",
        opens: true,
        onPress: () => navigation.navigate("CloudComputer"),
      },
    ],
  });
  if (host && (sessions === null || sessions.length > 0))
    sections.push({
      key: "sessions",
      title: "Where you’re signed in",
      rows:
        sessions === null
          ? sessionsLine
            ? []
            : [0, 1, 2].map((index) => ({
                key: `placeholder:${index}`,
                kind: "placeholder" as const,
                label: "Not loaded yet",
              }))
          : sessions.map(sessionRow),
      ...(sessionsFooter ? { footer: sessionsFooter } : {}),
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
                    remoteAccess.setPrivateNetwork(origin);
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
