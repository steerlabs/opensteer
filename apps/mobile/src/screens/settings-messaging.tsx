import { useEffect, useMemo, useState } from "react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  agentWords,
  chatsOfAccount,
  connectedAgentRow,
  connectionsRead,
  messagingAccountView,
  messagingComputers,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import { chatScreenHost, type ChatScreenCommand } from "@opensteer/client/host";
import { Alert } from "react-native";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { useClientRead, useConnectedAgents } from "@opensteer/client/react";
import { createClientRead } from "@opensteer/client/reads";
import { notDone, readLine, settingsFooter, useScreenAction } from "../ui/client-feedback.js";
import type { SettingsRpcData } from "./settings-rpc.js";

type Dashboard = SettingsRpcData<"channels.get">;
export function SettingsMessagingScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string }>) {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <Messaging
      deploymentId={route.params.deploymentId}
      key={route.params.deploymentId}
      host={host}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}
/**
 * Messaging on the phone: each account, its state in words, who "me" is on it and the code that
 * links it, and its chats, each opening as the connected agent it is (Stop, Disconnect). A chat
 * is added from Opensteer on a computer, where its channel and who may speak are chosen.
 */
function Messaging({
  deploymentId,
  host,
}: {
  readonly deploymentId: string;
  readonly host: HostClient;
}) {
  const navigation = useNavigation();
  const agents = useConnectedAgents(host);
  // What this screen sends and reads is what the chat parity script covers.
  const chatHost = chatScreenHost(host);
  const [shownCode, setShownCode] = useState<{
    readonly accountId: string;
    readonly code: string;
    readonly expiresAt: string;
  } | null>(null);
  const resource = useMemo(
    () =>
      createClientRead(host, {
        key: "channels",
        label: "messaging",
        read: async () => unwrapRpcResult(await chatHost.rpc["channels.get"]({})),
      }),
    [chatHost, host],
  );
  const dashboard = useClientRead(resource);
  // While a code is shown, read again every ten seconds, as the web does, so the account shows
  // once it is linked; until the code expires.
  useEffect(() => {
    if (shownCode === null) return;
    const left = Date.parse(shownCode.expiresAt) - Date.now();
    if (!(left > 0)) return;
    const timer = setInterval(() => void resource.refresh(), 10_000);
    const expiry = setTimeout(() => clearInterval(timer), left);
    return () => {
      clearInterval(timer);
      clearTimeout(expiry);
    };
  }, [resource, shownCode]);
  const [actedOn, setActedOn] = useState<string | null>(null);
  const [note, setNote] = useState<{ readonly section: string; readonly text: string } | null>(
    null,
  );
  const [providerId, setProvider] = useState<string | null>(null);
  const [repair, setRepair] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [runnerId, setRunner] = useState("");
  const change = useScreenAction(host, "channel-change", {
    label: "save the change",
    done: "saved",
    happened: "the change was saved",
    execute: async (command: ChatScreenCommand) => {
      const result = (await chatHost.dispatch(command)) as {
        readonly type: string;
        readonly code?: string;
        readonly expiresAt?: string;
      };
      // The code that links "me" is shown with what to send, from where, and until when.
      if (command.type === "channel.me.link" && result.code && result.expiresAt)
        setShownCode({
          accountId: String(command.accountId),
          code: result.code,
          expiresAt: result.expiresAt,
        });
    },
    // Read the messaging settings again; where they show the change's effect, that settles it.
    reconcile: async (command) => {
      await resource.refresh();
      const data = resource.getSnapshot().data;
      if (data === null) return null;
      const settled = changeSettled(data, command);
      return settled === null
        ? null
        : settled
          ? { kind: "confirmed", value: undefined }
          : notDone("saved");
    },
  });
  const check = useScreenAction(host, "channel-check", {
    label: "check the connection",
    done: "checked",
    happened: "the connection was checked",
    execute: async (connectionId: string) =>
      unwrapRpcResult(await chatHost.rpc["channel.connection.check"]({ connectionId })).ready,
    reconcile: async (connectionId) => ({
      kind: "confirmed",
      value: unwrapRpcResult(await chatHost.rpc["channel.connection.check"]({ connectionId }))
        .ready,
    }),
  });
  const pending = change.running || check.running;
  const dispatch = (command: ChatScreenCommand, section: string) => {
    if (pending) return;
    setActedOn(section);
    setNote(null);
    check.dismiss();
    void change.run(command).then((outcome) => {
      if (outcome.kind !== "confirmed") return;
      setCredentials({});
      setProvider(null);
      setRepair(null);
      resource.invalidate();
      // Pausing, resuming or removing an account changes its chats: read them again.
      if (command.type === "channel.connection.status.set") void agents.refresh?.();
    });
  };
  const checkConnection = (connectionId: string, section: string) => {
    if (pending) return;
    setActedOn(section);
    setNote(null);
    change.dismiss();
    void check.run(connectionId).then((outcome) => {
      if (outcome.kind === "confirmed" && !outcome.value)
        setNote({ section, text: "Not ready yet. Finish its setup, then check again." });
      resource.invalidate();
    });
  };
  /** The answer to the last action, under the section it was asked in. */
  const footerFor = (section: string) =>
    actedOn !== section
      ? undefined
      : (settingsFooter(change.line ?? check.line) ??
        (note?.section === section ? { text: note.text } : undefined));
  const button = (
    key: string,
    label: string,
    onPress: () => void,
    destructive = false,
  ): Extract<NativeSettingsRow, { kind: "button" }> => ({
    key,
    kind: "button",
    label,
    onPress,
    disabled: pending,
    destructive,
  });
  const text = (key: string, label: string): NativeSettingsRow => ({ key, kind: "text", label });
  const input = (
    key: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    secure = false,
  ): NativeSettingsRow => ({ key, kind: "input", label, value, onChange, secure });
  const sections: NativeSettingsSection[] = [];
  const loaded = readLine(dashboard, dashboard.refresh);
  sections.push({
    key: "refresh",
    title: "Messaging",
    rows: [
      button("refresh", "Refresh", dashboard.refresh),
      // Only a read answer says there is no account.
      ...(dashboard.data?.accounts.length === 0
        ? [text("empty", agentWords("messaging.empty"))]
        : []),
      ...(dashboard.data === null && loaded === null
        ? [0, 1, 2].map((index) => ({
            key: `placeholder:${index}`,
            kind: "placeholder" as const,
            label: "Not loaded yet",
          }))
        : []),
    ],
    // A read that failed says so in the web's words; a refusal keeps the Home's own.
    ...(loaded
      ? {
          footer: settingsFooter(
            loaded.tone === "danger"
              ? loaded
              : { ...loaded, text: agentWords("messaging.readFailed") },
          )!,
        }
      : {}),
  });
  if (dashboard.data) {
    const data = dashboard.data;
    const provider = data.providers.find((p) => p.provider === providerId);
    sections.push({
      key: "providers",
      title: agentWords("messaging.add"),
      rows: data.providers
        .filter((p) => p.availability === "available")
        .map((p) =>
          button(p.provider, p.label, () => {
            setCredentials({});
            setRepair(null);
            setProvider(p.provider);
          }),
        ),
    });
    if (provider) {
      const rows: NativeSettingsRow[] = provider.credentialFields.map((field) =>
        input(
          field.key,
          field.label,
          credentials[field.key] ?? "",
          (value) => setCredentials((current) => ({ ...current, [field.key]: value })),
          field.secret,
        ),
      );
      const computer = provider.transportKinds.includes("computer");
      // The Mac a computer provider is set up on; empty when none can do it.
      let chosen = "";
      if (computer) {
        rows.push(
          text(
            "how",
            "Choose the Mac signed into Messages with the bot's Apple account. Once it is connected, link your own iMessage account with a code, then add a chat.",
          ),
        );
        // Which Mac can do it: the web's rule, shared. None says what to do.
        const eligible = messagingComputers(host.getSnapshot().machines, provider);
        chosen = eligible.some((m) => m.id === runnerId) ? runnerId : (eligible[0]?.id ?? "");
        rows.push(
          ...(eligible.length === 0
            ? [text("no-mac", agentWords("messaging.computer.none"))]
            : eligible.map((m) =>
                button(m.id, `${m.id === chosen ? "✓ " : ""}${m.name}`, () => setRunner(m.id)),
              )),
        );
      }
      const connect = button("save", repair ? "Replace credentials" : "Connect", () => {
        const idempotencyKey = mutationIdempotencyKey("channel-connect");
        const section = `setup:${provider.provider}:${repair ?? "new"}`;
        if (repair)
          dispatch(
            {
              type: "channel.connection.credentials.replace",
              connectionId: repair,
              credentials,
              idempotencyKey,
            },
            section,
          );
        else if (computer)
          dispatch(
            {
              type: "channel.connection.computer.create",
              provider: provider.provider,
              runnerId: chosen,
              idempotencyKey,
            },
            section,
          );
        else
          dispatch(
            {
              type: "channel.connection.create",
              provider: provider.provider,
              credentials,
              routingMode: "dedicated",
              idempotencyKey,
            },
            section,
          );
      });
      // Nothing is sent without a Mac that can do it.
      rows.push(computer && !repair && chosen === "" ? { ...connect, disabled: true } : connect);
      rows.push(
        button("cancel", "Cancel", () => {
          setCredentials({});
          setProvider(null);
          setRepair(null);
        }),
      );
      const section = `setup:${provider.provider}:${repair ?? "new"}`;
      const footer = footerFor(section);
      sections.push({ key: section, title: provider.label, rows, ...(footer ? { footer } : {}) });
    }
    for (const account of data.accounts) {
      const manifest = data.providers.find((p) => p.provider === account.provider);
      const providerLabel = manifest?.label ?? account.provider;
      const me = data.me?.find((row) => row.accountId === account.id) ?? null;
      const code = shownCode?.accountId === account.id ? shownCode : null;
      // The account's connection, as the web reads it: its status, what it reports, and what the
      // Home accepts for it.
      const connection = data.connections.find((row) => row.id === account.connectionId);
      const view = connection ? messagingAccountView(connection, manifest) : null;
      const rows: NativeSettingsRow[] = [
        {
          key: "status",
          kind: "status",
          tone: view?.tone ?? "attention",
          label: view?.label ?? agentWords("messaging.status.unknown"),
        },
        ...(view?.detail ? [text("detail", view.detail)] : []),
        ...(view?.pausedNote ? [text("paused", view.pausedNote)] : []),
        button("check", agentWords("messaging.check"), () =>
          checkConnection(account.connectionId, account.id),
        ),
        ...(view?.canFix
          ? [
              button("repair", agentWords("messaging.fix"), () => {
                setCredentials({});
                setProvider(account.provider);
                setRepair(account.connectionId);
              }),
            ]
          : []),
        ...(view?.canPause || view?.canResume
          ? [
              button(
                "pause",
                view.canResume ? agentWords("messaging.resume") : agentWords("messaging.pause"),
                () =>
                  dispatch(
                    {
                      type: "channel.connection.status.set",
                      connectionId: account.connectionId,
                      status: view.canResume ? "connected" : "paused",
                      idempotencyKey: mutationIdempotencyKey("channel-status"),
                    },
                    account.id,
                  ),
              ),
            ]
          : []),
        {
          key: "me",
          kind: "text",
          label: agentWords("messaging.me.title", { provider: providerLabel }),
          detail: me
            ? `${agentWords("messaging.me.linked", { identity: me.displayName })} ${agentWords("messaging.me.replaces", { identity: me.displayName })}`
            : agentWords("messaging.me.none", { provider: providerLabel }),
        },
        ...(code
          ? [
              text(
                "code",
                agentWords("messaging.me.code", {
                  code: code.code,
                  account: account.handle ?? account.displayName,
                  provider: providerLabel,
                  time: new Date(code.expiresAt).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                }),
              ),
              ...(view?.canResume
                ? [text("whenResumed", agentWords("messaging.me.whenResumed"))]
                : []),
              ...(connection?.status === "needs-attention"
                ? [text("whenFixed", agentWords("messaging.me.whenFixed"))]
                : []),
            ]
          : []),
        button(
          "link",
          me ? agentWords("messaging.me.relink") : agentWords("messaging.me.link"),
          () =>
            dispatch(
              {
                type: "channel.me.link",
                accountId: account.id,
                idempotencyKey: mutationIdempotencyKey("channel-me-link"),
              },
              account.id,
            ),
        ),
        button(
          "remove",
          agentWords("messaging.remove"),
          () =>
            Alert.alert(
              agentWords("messaging.remove.title", { account: account.displayName }),
              agentWords("messaging.remove.body"),
              [
                { text: agentWords("common.cancel"), style: "cancel" },
                {
                  text: agentWords("messaging.remove"),
                  style: "destructive",
                  onPress: () =>
                    dispatch(
                      {
                        type: "channel.connection.status.set",
                        connectionId: account.connectionId,
                        status: "revoked",
                        idempotencyKey: mutationIdempotencyKey("channel-remove"),
                      },
                      account.id,
                    ),
                },
              ],
            ),
          true,
        ),
      ];
      const footer = footerFor(account.id);
      sections.push({
        key: account.id,
        title: account.displayName,
        rows,
        ...(footer ? { footer } : {}),
      });
      // Only a read answer says an account has no chat.
      const read = connectionsRead(agents);
      const chats = chatsOfAccount(agents.connections, account.id);
      sections.push({
        key: `${account.id}:chats`,
        title: agentWords("messaging.chats.title"),
        rows:
          read === "loading"
            ? [
                {
                  key: "loading",
                  kind: "placeholder",
                  label: agentWords("messaging.chats.loading"),
                },
              ]
            : read === "failed"
              ? [
                  text("unreadable", agentWords("messaging.chats.readFailed")),
                  button("retry", agentWords("common.tryAgain"), () => void agents.refresh?.()),
                ]
              : chats.length === 0
                ? [text("none", agentWords("messaging.chats.empty"))]
                : chats.map((chat): NativeSettingsRow => ({
                    key: chat.id,
                    kind: "button",
                    label: chat.label,
                    detail: connectedAgentRow(chat, {
                      profiles: host.getSnapshot().browserProfiles,
                    }).line,
                    opens: true,
                    onPress: () =>
                      navigation.navigate("ConnectedAgent", {
                        deploymentId,
                        connectionId: chat.id,
                      }),
                  })),
        footer: { text: agentWords("messaging.phone") },
      });
    }
  }
  // The last read failed: what is shown is the answer before it, never as current, and nothing
  // on it changes anything; only Refresh, Try again and moving around stay. One rule for every
  // section, as the web holds it for every control.
  if (loaded !== null && dashboard.data !== null)
    for (const [index, section] of sections.entries())
      if (section.key !== "refresh")
        sections[index] = {
          ...section,
          rows: section.rows.flatMap((row): NativeSettingsRow[] =>
            row.kind === "status"
              ? [{ ...row, tone: "neutral", label: agentWords("messaging.status.stale") }]
              : (row.kind === "button" &&
                    !row.opens &&
                    row.label !== agentWords("common.tryAgain")) ||
                  row.kind === "toggle" ||
                  row.kind === "input" ||
                  row.kind === "chips"
                ? []
                : [row],
          ),
        };
  // A section the rule emptied says nothing, so it is not drawn.
  const drawn = sections.filter(
    (section) => section.key === "refresh" || section.rows.length > 0 || section.footer,
  );
  const setup = drawn.filter((section) => section.key.startsWith("setup:"));
  return (
    <>
      <NativeSettingsPage sections={drawn.filter((section) => !section.key.startsWith("setup:"))} />
      <Sheet
        open={providerId !== null}
        title={
          dashboard.data?.providers.find((provider) => provider.provider === providerId)?.label ??
          "Messaging"
        }
        onClose={() => {
          setCredentials({});
          setProvider(null);
          setRepair(null);
        }}
      >
        {providerId ? <NativeSettingsPage sections={setup} /> : null}
      </Sheet>
    </>
  );
}

/** Whether the messaging settings show a change took: null where they can't tell. */
function changeSettled(data: Dashboard, command: ChatScreenCommand): boolean | null {
  switch (command.type) {
    case "channel.connection.status.set": {
      const account = data.accounts.find((row) => row.connectionId === command.connectionId);
      if (account === undefined) return command.status === "revoked" ? true : null;
      return account.status === command.status;
    }
    default:
      return null;
  }
}
