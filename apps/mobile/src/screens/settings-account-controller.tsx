import { useSettingsLease } from "./use-settings-read.js";
import { settingsSessionRows } from "@opensteer/client/settings";
import { remoteAccessDisconnectWarning } from "@opensteer/client/host";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, TextInput, View } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import { AppText, SecondaryButton } from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { useNavigation } from "@react-navigation/native";
import { remoteAdministrationActions, remoteAdministrationActionLabels } from "./settings-model.js";
import { accountSettingsModel, signOutAccountInOrder } from "./settings-model.js";

import { useSettingsHost } from "./use-settings-host.js";
export function AccountSettingsController({ detail, sessionId }: { readonly detail?: "remote" | "session" | undefined; readonly sessionId?: string | undefined } = {}): ReactNode {
  const navigation = useNavigation();
  const page = "account";
  const client = useMobileClient();
  const notifications = useMobileNotifications();
  const { account, selection } = useMobileState();
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountWorking, setAccountWorking] = useState(false);
  const accountInFlight = useRef(false);
  const snapshot = useSettingsHost(selection.hostClient);
  const isCurrent = useSettingsLease(selection.hostClient);
  const remote = usePersonalRemoteAccess(
    page === "account" &&
      snapshot?.deploymentShape?.kind === "personal" &&
      selection.hostClient?.getSnapshot().user?.instanceRole === "administrator"
      ? selection.hostClient
      : null,
  );
  const [sessions, setSessions] = useState<readonly import("@opensteer/core").AuthSessionSummary[]>(
    [],
  );
  const [administrationError, setAdministrationError] = useState<string | null>(null);
  const [administrationBusy, setAdministrationBusy] = useState(false);
  const [modeShown, setModeShown] = useState(false);
  const [privateShown, setPrivateShown] = useState(false);
  const [privateAddress, setPrivateAddress] = useState("");
  const refreshSessions = useCallback(() => {
    const host = selection.hostClient;
    if (!host) return;
    void host.rpc["sessions.list"]({})
      .then((result) => {
        if (!isCurrent() || client.getSnapshot().selection.hostClient !== host) return;
        if (result.ok) setSessions(settingsSessionRows(result.data.sessions));
        else setAdministrationError(result.error.message);
      })
      .catch(() => {
        if (isCurrent()) setAdministrationError("Sessions could not be loaded.");
      });
  }, [client, selection.hostClient, isCurrent]);
  useEffect(() => {
    setSessions([]);
    if (page === "account") refreshSessions();
  }, [refreshSessions, page]);
  const administration = selection.hostClient
    ? {
        access: remote.status,
        pairing: remote.pairing,
        sessions,
        error: administrationError ?? remote.error,
        busy: administrationBusy || remote.working,
        onRefresh: refreshSessions,
        onRemove: (session: import("@opensteer/core").AuthSessionSummary) => {
          if (administrationBusy || !isCurrent()) return;
          setAdministrationBusy(true);
          setAdministrationError(null);
          void client
            .removeHostSession(session)
            .then(() => {
              if (isCurrent())
                setSessions((current) => current.filter((row) => row.id !== session.id));
            })
            .catch((error: unknown) =>
              setAdministrationError(operationDetail(error, "Device removal failed.")),
            )
            .finally(() => setAdministrationBusy(false));
        },
        onAction: (
          action:
            | "off"
            | "connect"
            | "private"
            | "rotate"
            | "unlink"
            | "recover"
            | "pair"
            | "link"
            | "mode",
        ) => {
          if (action === "mode") {
            setModeShown(true);
            return;
          }
          if (action === "private") {
            setPrivateShown(true);
            return;
          }
          if (action === "pair") {
            void remote.pair?.();
            return;
          }
          if (action === "link") {
            setAdministrationBusy(true);
            setAdministrationError(null);
            void client
              .linkSelectedPersonalAccount()
              .catch((error: unknown) =>
                setAdministrationError(operationDetail(error, "Account linking failed.")),
              )
              .finally(() => setAdministrationBusy(false));
            return;
          }
          const apply = () =>
            void remote.request?.(
              action === "off" || action === "connect"
                ? { action: "configure", mode: action, privateOrigin: null }
                : { action },
            );
          if (action === "unlink" || action === "off" || action === "connect")
            Alert.alert("Change remote access?", remoteAccessDisconnectWarning, [
              { text: "Cancel", style: "cancel" },
              { text: "Continue", style: "destructive", onPress: apply },
            ]);
          else apply();
        },
      }
    : undefined;
  const accountModel = accountSettingsModel(account.account, accountWorking);
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
  const signOut = useCallback(() => {
    if (accountInFlight.current) return;
    Alert.alert(
      "Sign out of your Opensteer Account?",
      "Deployments listed by your Account will leave this phone. Deployments you added yourself stay signed in.",
      [
        { style: "cancel", text: "Cancel" },
        {
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
              "Account sign-out did not finish. Try again while this phone is online.",
            ),
          style: "destructive",
          text: "Sign out of Account",
        },
      ],
    );
  }, [client, notifications, runAccount]);
  const onAccountAction = useCallback(() => {
    const action = accountModel?.action ?? null;
    if (action === null || action.disabled) return;
    if (action.kind === "sign-out") {
      signOut();
      return;
    }
    runAccount(
      () => client.signInAccount(),
      "Account sign-in did not finish. Try again and complete the browser sign-in.",
    );
  }, [accountModel?.action, client, runAccount, signOut]);
  const text = (key: string, label: string): NativeSettingsRow => ({ key, kind: "text", label });
  const button = (key: string, label: string, onPress: () => void, destructive = false): NativeSettingsRow => ({ key, kind: "button", label, onPress, destructive, disabled: administration?.busy ?? false });
  const sections: NativeSettingsSection[] = [];
  if (detail === "remote") {
    if (remote.status) {
      sections.push({ key: "remote", title: "Open Opensteer from anywhere", rows: [
        text("mode", `Mode: ${remote.status.access.mode}`),
        text("executor", remote.status.executorConnected ? "Computer connected" : "Waiting for your computer"),
        ...(remote.status.operation ? [text("operation", `${remote.status.operation.state}${remote.status.operation.detail ? ` · ${remote.status.operation.detail}` : ""}`)] : []),
        ...(!remote.status.access.accountLink ? [text("prerequisite", "Link your Opensteer Account to use Connect.")] : []),
        ...remoteAdministrationActions(remote.status).map(action => button(action, remoteAdministrationActionLabels[action], () => administration?.onAction(action), action === "unlink" || action === "rotate")),
        ...(remote.pairing ? [text("pairing", `Pairing code: ${remote.pairing.code}`)] : []),
      ] });
    }
  } else if (detail === "session") {
    const session = sessions.find(session => session.id === sessionId);
    sections.push({ key: "session", title: session?.deviceLabel ?? "Signed-in session", rows: session ? [
      ...(session.current ? [text("current", "This device")] : []),
      button("sign-out", "Sign out", () => Alert.alert("Sign out of this session?", "This ends this login. Device access and other signed-in sessions stay as they are.", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => administration?.onRemove(session) },
      ]), true),
    ] : [text("missing", "This session is no longer signed in.")] });
  } else {
    if (accountModel) sections.push({ key: "account", title: "Opensteer Account", rows: [
      text("identity", accountModel.title),
      ...(accountModel.subtitle ? [text("subtitle", accountModel.subtitle)] : []),
      ...(accountModel.action ? [button("account-action", accountModel.action.label, onAccountAction)] : []),
    ] });
    if (administration) {
      if (remote.status) sections.push({ key: "remote", title: "Remote access", rows: [
        { key: "enabled", kind: "toggle", label: "Open Opensteer from anywhere", value: remote.status.access.mode !== "off", disabled: administration.busy, onChange: enabled => administration.onAction(enabled ? "mode" : "off") },
        button("remote-detail", "Connection details", () => { if (selection.deploymentId) navigation.navigate("SettingsRemoteAccess", { deploymentId: selection.deploymentId }); }),
      ] });
      sections.push({ key: "sessions", title: "Where you’re signed in", rows: sessions.map(session => button(session.id, `${session.deviceLabel}${session.current ? " · This device" : ""}`, () => { if (selection.deploymentId) navigation.navigate("SettingsSessionDetail", { deploymentId: selection.deploymentId, sessionId: session.id }); })) });
    }
  }
  if (accountError || administration?.error) sections.push({ key: "error", title: "Needs you", rows: [text("error", accountError ?? administration?.error ?? "")] });
  return (
    <>
      <NativeSettingsPage sections={sections} />
      <Sheet
        open={modeShown}
        onClose={() => setModeShown(false)}
        title="Open Opensteer from anywhere"
      >
        <View style={{ padding: 20, gap: 16 }}>
          <SecondaryButton
            label="Connect"
            onPress={() => {
              setModeShown(false);
              administration?.onAction("connect");
            }}
          />
          <SecondaryButton
            label="Private network"
            onPress={() => {
              setModeShown(false);
              administration?.onAction("private");
            }}
          />
        </View>
      </Sheet>
      <Sheet open={privateShown} onClose={() => setPrivateShown(false)} title="Private network">
        <View style={{ padding: 20, gap: 16 }}>
          <AppText>{remoteAccessDisconnectWarning}</AppText>
          <TextInput
            accessibilityLabel="Private HTTPS address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="https://your-computer.example"
            value={privateAddress}
            onChangeText={setPrivateAddress}
          />
          <SecondaryButton
            label="Apply private address"
            onPress={() => {
              setPrivateShown(false);
              void remote.request?.({
                action: "configure",
                mode: "private",
                privateOrigin: privateAddress.trim(),
              });
            }}
          />
        </View>
      </Sheet>
    </>
  );
}
