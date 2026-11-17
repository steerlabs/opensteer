import { useMemo, useState } from "react";
import type { StaticScreenProps } from "@react-navigation/native";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import type { HostApiCommandInput } from "@opensteer/protocol";
import { Alert } from "react-native";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { useClientRead } from "@opensteer/client/react";
import { createClientRead } from "@opensteer/client/reads";
import { notDone, readLine, settingsFooter, useScreenAction } from "../ui/client-feedback.js";
import type { SettingsRpcData } from "./settings-rpc.js";

type Dashboard = SettingsRpcData<"channels.get">;
type Policy = Dashboard["bindings"][number]["accessPolicy"];
const policy = (): Policy => ({
  channels: {
    scope: "selected",
    conversationIds: [],
    sender: { mode: "approved", allowedExternalUserIds: [] },
  },
  directMessages: { mode: "owner", allowedExternalUserIds: [] },
});
export function SettingsMessagingScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string }>) {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <Messaging key={route.params.deploymentId} host={host} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}
function Messaging({ host }: { readonly host: HostClient }) {
  const resource = useMemo(
    () =>
      createClientRead(host, {
        key: "channels",
        label: "messaging",
        read: async () => unwrapRpcResult(await host.rpc["channels.get"]({})),
      }),
    [host],
  );
  const dashboard = useClientRead(resource);
  const [actedOn, setActedOn] = useState<string | null>(null);
  const [note, setNote] = useState<{ readonly section: string; readonly text: string } | null>(
    null,
  );
  const [providerId, setProvider] = useState<string | null>(null);
  const [repair, setRepair] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [runnerId, setRunner] = useState("");
  const [handles, setHandles] = useState("");
  const [conversation, setConversation] = useState("");
  const [code, setCode] = useState("");
  const [shared, setShared] = useState(false);
  const change = useScreenAction(host, "channel-change", {
    label: "save the change",
    done: "saved",
    happened: "the change was saved",
    execute: async (command: HostApiCommandInput) => {
      await host.dispatch(command);
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
          : notDone({ label: "save", done: "saved" });
    },
  });
  const check = useScreenAction(host, "channel-check", {
    label: "check the connection",
    done: "checked",
    happened: "the connection was checked",
    execute: async (connectionId: string) =>
      unwrapRpcResult(await host.rpc["channel.connection.check"]({ connectionId })).ready,
    reconcile: async (connectionId) => ({
      kind: "confirmed",
      value: unwrapRpcResult(await host.rpc["channel.connection.check"]({ connectionId })).ready,
    }),
  });
  const pending = change.running || check.running;
  const dispatch = (command: HostApiCommandInput, section: string) => {
    if (pending) return;
    setActedOn(section);
    setNote(null);
    check.dismiss();
    void change.run(command).then((outcome) => {
      if (outcome.kind !== "confirmed") return;
      setCredentials({});
      setCode("");
      setProvider(null);
      setRepair(null);
      resource.invalidate();
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
  ): NativeSettingsRow => ({
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
      ...(dashboard.data === null && loaded === null
        ? [0, 1, 2].map((index) => ({
            key: `placeholder:${index}`,
            kind: "placeholder" as const,
            label: "Not loaded yet",
          }))
        : []),
    ],
    ...(loaded ? { footer: settingsFooter(loaded)! } : {}),
  });
  if (dashboard.data) {
    const data = dashboard.data;
    const provider = data.providers.find((p) => p.provider === providerId);
    sections.push({
      key: "providers",
      title: "Add messaging",
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
      if (computer) {
        rows.push(
          input("handles", "Your iMessage addresses, separated by commas", handles, setHandles),
        );
        rows.push(
          ...host
            .getSnapshot()
            .machines.filter((m) => m.allowedModules.includes("messaging"))
            .map((m) =>
              button(m.id, `${m.id === runnerId ? "✓ " : ""}${m.name}`, () => setRunner(m.id)),
            ),
        );
      } else
        rows.push({
          key: "shared",
          kind: "toggle",
          label: "Shared bot",
          value: shared,
          onChange: setShared,
        });
      rows.push(
        button("save", repair ? "Replace credentials" : "Connect", () => {
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
                runnerId,
                ownerHandles: handles
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
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
                routingMode: shared ? "shared" : "dedicated",
                accessPolicy: policy(),
                idempotencyKey,
              },
              section,
            );
        }),
      );
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
      const rows: NativeSettingsRow[] = [
        text("status", account.status),
        button("check", "Check connection", () =>
          checkConnection(account.connectionId, account.id),
        ),
        button("repair", "Repair", () => {
          setCredentials({});
          setProvider(account.provider);
          setRepair(account.connectionId);
        }),
        button("pause", account.status === "paused" ? "Resume" : "Pause", () =>
          dispatch(
            {
              type: "channel.connection.status.set",
              connectionId: account.connectionId,
              status: account.status === "paused" ? "connected" : "paused",
              idempotencyKey: mutationIdempotencyKey("channel-status"),
            },
            account.id,
          ),
        ),
      ];
      rows.push(input("conversation", "Conversation ID", conversation, setConversation));
      rows.push(
        button("bind", "Add route", () =>
          dispatch(
            {
              type: "channel.binding.create",
              accountId: account.id,
              selector: {
                conversationId: conversation.trim(),
                conversationType: null,
                scopeId: null,
                threadId: null,
              },
              accessPolicy: policy(),
              executionPolicy: { harness: "default", harnessInstanceId: null },
              idempotencyKey: mutationIdempotencyKey("channel-route"),
            },
            account.id,
          ),
        ),
      );
      rows.push(
        button(
          "remove",
          "Remove",
          () =>
            Alert.alert(
              `Remove ${account.displayName}?`,
              "This stops messaging through this account.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove",
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
      );
      const footer = footerFor(account.id);
      sections.push({
        key: account.id,
        title: account.displayName,
        rows,
        ...(footer ? { footer } : {}),
      });
    }
    for (const binding of data.bindings) {
      const rows: NativeSettingsRow[] = [
        text(
          "status",
          `${binding.selector.conversationId ?? "All conversations"} · ${binding.status}`,
        ),
      ];
      for (const mode of ["off", "owner", "approved", "anyone"] as const)
        rows.push(
          button(
            mode,
            `${binding.accessPolicy.directMessages.mode === mode ? "✓ " : ""}Direct messages: ${mode}`,
            () =>
              dispatch(
                {
                  type: "channel.binding.update",
                  bindingId: binding.id,
                  expectedRevision: binding.revision,
                  accessPolicy: {
                    ...binding.accessPolicy,
                    directMessages: { ...binding.accessPolicy.directMessages, mode },
                  },
                  idempotencyKey: mutationIdempotencyKey("channel-policy"),
                },
                binding.id,
              ),
          ),
        );
      for (const mode of ["off", "owner", "approved", "anyone"] as const)
        rows.push(
          button(
            `channels:${mode}`,
            `${binding.accessPolicy.channels.sender.mode === mode ? "✓ " : ""}Channel senders: ${mode}`,
            () =>
              dispatch(
                {
                  type: "channel.binding.update",
                  bindingId: binding.id,
                  expectedRevision: binding.revision,
                  accessPolicy: {
                    ...binding.accessPolicy,
                    channels: {
                      ...binding.accessPolicy.channels,
                      sender: { ...binding.accessPolicy.channels.sender, mode },
                    },
                  },
                  idempotencyKey: mutationIdempotencyKey("channel-policy"),
                },
                binding.id,
              ),
          ),
        );
      for (const scope of ["off", "selected", "all"] as const)
        rows.push(
          button(
            `scope:${scope}`,
            `${binding.accessPolicy.channels.scope === scope ? "✓ " : ""}Channels: ${scope}`,
            () =>
              dispatch(
                {
                  type: "channel.binding.update",
                  bindingId: binding.id,
                  expectedRevision: binding.revision,
                  accessPolicy: {
                    ...binding.accessPolicy,
                    channels: {
                      ...binding.accessPolicy.channels,
                      scope,
                      conversationIds:
                        scope === "selected"
                          ? conversation
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean)
                          : binding.accessPolicy.channels.conversationIds,
                    },
                  },
                  idempotencyKey: mutationIdempotencyKey("channel-policy"),
                },
                binding.id,
              ),
          ),
        );
      rows.push(
        input(
          `channels:${binding.id}`,
          "Selected conversation IDs, separated by commas",
          conversation,
          setConversation,
        ),
      );
      rows.push(
        button(
          "revoke",
          "Remove route",
          () =>
            dispatch(
              {
                type: "channel.binding.revoke",
                bindingId: binding.id,
                idempotencyKey: mutationIdempotencyKey("channel-route-revoke"),
              },
              binding.id,
            ),
          true,
        ),
      );
      const footer = footerFor(binding.id);
      sections.push({ key: binding.id, title: "Route", rows, ...(footer ? { footer } : {}) });
    }
    for (const grant of data.accessGrants) {
      const key = `${grant.bindingId}:${grant.externalUserId}`;
      const footer = footerFor(key);
      sections.push({
        key,
        title: grant.displayName,
        ...(footer ? { footer } : {}),
        rows: [
          text("status", grant.status === "pending" ? "Waiting for approval" : grant.status),
          ...(["approved", "declined", "revoked"] as const).map((decision) =>
            button(
              decision,
              decision === "approved" ? "Approve" : decision === "declined" ? "Decline" : "Revoke",
              () =>
                dispatch(
                  {
                    type: "channel.access.review",
                    bindingId: grant.bindingId,
                    externalUserId: grant.externalUserId,
                    expectedRevision: grant.revision,
                    decision,
                    idempotencyKey: mutationIdempotencyKey("channel-sender"),
                  },
                  key,
                ),
            ),
          ),
        ],
      });
    }
  }
  const linkFooter = footerFor("link");
  sections.push({
    key: "link",
    title: "Link your messaging account",
    ...(linkFooter ? { footer: linkFooter } : {}),
    rows: [
      input("code", "Link code", code, setCode, true),
      button("link", "Link account", () =>
        dispatch(
          {
            type: "channel.identity.link",
            code,
            idempotencyKey: mutationIdempotencyKey("channel-link"),
          },
          "link",
        ),
      ),
    ],
  });
  const setup = sections.filter((section) => section.key.startsWith("setup:"));
  return (
    <>
      <NativeSettingsPage
        sections={sections.filter((section) => !section.key.startsWith("setup:"))}
      />
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
function changeSettled(data: Dashboard, command: HostApiCommandInput): boolean | null {
  switch (command.type) {
    case "channel.connection.status.set": {
      const account = data.accounts.find((row) => row.connectionId === command.connectionId);
      if (account === undefined) return command.status === "revoked" ? true : null;
      return account.status === command.status;
    }
    case "channel.binding.revoke":
      return !data.bindings.some((binding) => binding.id === command.bindingId);
    case "channel.binding.update": {
      const binding = data.bindings.find((row) => row.id === command.bindingId);
      return binding === undefined ? null : binding.revision > command.expectedRevision;
    }
    case "channel.access.review": {
      const grant = data.accessGrants.find(
        (row) =>
          row.bindingId === command.bindingId && row.externalUserId === command.externalUserId,
      );
      return grant === undefined ? null : grant.revision > command.expectedRevision;
    }
    default:
      return null;
  }
}
