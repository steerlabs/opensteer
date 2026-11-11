import { useRef, useState } from "react";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  canRespondToRequests,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  taskFolderKey,
  type HostSnapshot,
} from "@opensteer/client/host";
import type { TaskFolder } from "@opensteer/core";
import { folderLabel } from "../home/folder-label.js";
import type { HostApiCommandInput } from "@opensteer/protocol";
import { Alert } from "react-native";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { useSettingsRead, useSettingsLease, type SettingsRpcData } from "./use-settings-read.js";

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
  const isCurrent = useSettingsLease(host);
  const dashboard = useSettingsRead(host, async () =>
    unwrapRpcResult(await host.rpc["channels.get"]({})),
  );
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [providerId, setProvider] = useState<string | null>(null);
  const [repair, setRepair] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  // A bridge starts or continues tasks for your agent in one folder (Agent home by default).
  const agentHome = host.getSnapshot().personalSettings?.agentHome ?? null;
  const [folder, setFolder] = useState<TaskFolder | null>(agentHome);
  const folders = bridgeFolders(host.getSnapshot());
  const [runnerId, setRunner] = useState("");
  const [handles, setHandles] = useState("");
  const [conversation, setConversation] = useState("");
  const [code, setCode] = useState("");
  const [shared, setShared] = useState(false);
  const run = (operation: () => Promise<unknown>) => {
    if (busy.current || !isCurrent()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    void operation()
      .then(() => {
        if (!isCurrent()) return;
        setCredentials({});
        setCode("");
        setProvider(null);
        setRepair(null);
      })
      .catch(() => {
        if (isCurrent())
          setError("That change could not be confirmed. Refresh before trying again.");
      })
      .finally(() => {
        void dashboard.reload();
        busy.current = false;
        setPending(false);
      });
  };
  const dispatch = (command: HostApiCommandInput) => run(() => host.dispatch(command));
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
    disabled: pending || !canRespondToRequests(host.getSnapshot()),
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
  if (error || dashboard.error)
    sections.push({
      key: "error",
      title: "Needs you",
      rows: [text("error", error ?? dashboard.error ?? "")],
    });
  sections.push({
    key: "refresh",
    title: "Messaging",
    rows: [
      button("refresh", "Refresh", () => {
        void dashboard.reload();
      }),
    ],
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
      rows.push(
        ...folders.map((candidate) =>
          button(
            taskFolderKey(candidate),
            `${sameFolder(candidate, folder) ? "✓ " : ""}${folderLabel(candidate, agentHome)}`,
            () => setFolder(candidate),
          ),
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
          if (repair)
            dispatch({
              type: "channel.connection.credentials.replace",
              connectionId: repair,
              credentials,
              idempotencyKey,
            });
          else if (computer)
            dispatch({
              type: "channel.connection.computer.create",
              provider: provider.provider,
              runnerId,
              folder: folder ?? agentHome!,
              ownerHandles: handles
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
              idempotencyKey,
            });
          else
            dispatch({
              type: "channel.connection.create",
              provider: provider.provider,
              credentials,
              folder: folder ?? agentHome!,
              routingMode: shared ? "shared" : "dedicated",
              accessPolicy: policy(),
              idempotencyKey,
            });
        }),
      );
      rows.push(
        button("cancel", "Cancel", () => {
          setCredentials({});
          setProvider(null);
          setRepair(null);
        }),
      );
      sections.push({
        key: `setup:${provider.provider}:${repair ?? "new"}`,
        title: provider.label,
        rows,
      });
    }
    for (const account of data.accounts) {
      const rows: NativeSettingsRow[] = [
        text("status", account.status),
        button("check", "Check connection", () =>
          run(async () => {
            const result = unwrapRpcResult(
              await host.rpc["channel.connection.check"]({ connectionId: account.connectionId }),
            );
            if (!result.ready) throw new Error("Setup incomplete");
          }),
        ),
        button("repair", "Repair", () => {
          setCredentials({});
          setProvider(account.provider);
          setRepair(account.connectionId);
        }),
        button("pause", account.status === "paused" ? "Resume" : "Pause", () =>
          dispatch({
            type: "channel.connection.status.set",
            connectionId: account.connectionId,
            status: account.status === "paused" ? "connected" : "paused",
            idempotencyKey: mutationIdempotencyKey("channel-status"),
          }),
        ),
      ];
      rows.push(input("conversation", "Conversation ID", conversation, setConversation));
      rows.push(
        ...folders.map((candidate) =>
          button(
            `place:${taskFolderKey(candidate)}`,
            `${sameFolder(candidate, folder) ? "✓ " : ""}${folderLabel(candidate, agentHome)}`,
            () => setFolder(candidate),
          ),
        ),
      );
      rows.push(
        button("bind", "Add route", () =>
          dispatch({
            type: "channel.binding.create",
            accountId: account.id,
            folder: folder ?? agentHome!,
            selector: {
              conversationId: conversation.trim(),
              conversationType: null,
              scopeId: null,
              threadId: null,
            },
            accessPolicy: policy(),
            executionPolicy: { harness: "default", harnessInstanceId: null },
            idempotencyKey: mutationIdempotencyKey("channel-route"),
          }),
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
                    dispatch({
                      type: "channel.connection.status.set",
                      connectionId: account.connectionId,
                      status: "revoked",
                      idempotencyKey: mutationIdempotencyKey("channel-remove"),
                    }),
                },
              ],
            ),
          true,
        ),
      );
      sections.push({ key: account.id, title: account.displayName, rows });
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
              dispatch({
                type: "channel.binding.update",
                bindingId: binding.id,
                expectedRevision: binding.revision,
                accessPolicy: {
                  ...binding.accessPolicy,
                  directMessages: { ...binding.accessPolicy.directMessages, mode },
                },
                idempotencyKey: mutationIdempotencyKey("channel-policy"),
              }),
          ),
        );
      for (const mode of ["off", "owner", "approved", "anyone"] as const)
        rows.push(
          button(
            `channels:${mode}`,
            `${binding.accessPolicy.channels.sender.mode === mode ? "✓ " : ""}Channel senders: ${mode}`,
            () =>
              dispatch({
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
              }),
          ),
        );
      for (const scope of ["off", "selected", "all"] as const)
        rows.push(
          button(
            `scope:${scope}`,
            `${binding.accessPolicy.channels.scope === scope ? "✓ " : ""}Channels: ${scope}`,
            () =>
              dispatch({
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
              }),
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
            dispatch({
              type: "channel.binding.revoke",
              bindingId: binding.id,
              idempotencyKey: mutationIdempotencyKey("channel-route-revoke"),
            }),
          true,
        ),
      );
      sections.push({ key: binding.id, title: "Route", rows });
    }
    for (const grant of data.accessGrants)
      sections.push({
        key: `${grant.bindingId}:${grant.externalUserId}`,
        title: grant.displayName,
        rows: [
          text("status", grant.status === "pending" ? "Waiting for approval" : grant.status),
          ...(["approved", "declined", "revoked"] as const).map((decision) =>
            button(
              decision,
              decision === "approved" ? "Approve" : decision === "declined" ? "Decline" : "Revoke",
              () =>
                dispatch({
                  type: "channel.access.review",
                  bindingId: grant.bindingId,
                  externalUserId: grant.externalUserId,
                  expectedRevision: grant.revision,
                  decision,
                  idempotencyKey: mutationIdempotencyKey("channel-sender"),
                }),
            ),
          ),
        ],
      });
  }
  sections.push({
    key: "link",
    title: "Link your messaging account",
    rows: [
      input("code", "Link code", code, setCode, true),
      button("link", "Link account", () =>
        dispatch({
          type: "channel.identity.link",
          code,
          idempotencyKey: mutationIdempotencyKey("channel-link"),
        }),
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

/** Agent home, then the folders of the reader's recent tasks: where a bridge may work. */
function bridgeFolders(snapshot: HostSnapshot): readonly TaskFolder[] {
  const folders = new Map<string, TaskFolder>();
  const home = snapshot.personalSettings?.agentHome;
  if (home !== undefined) folders.set(taskFolderKey(home), home);
  for (const { thread } of snapshot.tasks?.entries ?? [])
    if (folders.size < 8) folders.set(taskFolderKey(thread.folder), thread.folder);
  return [...folders.values()];
}

function sameFolder(left: TaskFolder, right: TaskFolder | null): boolean {
  return right !== null && taskFolderKey(left) === taskFolderKey(right);
}
