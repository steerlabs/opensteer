import { useDeferredValue, useRef, useState } from "react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import type { HostApiCommandInput, PluginDetailView, PluginRow } from "@opensteer/protocol";
import { Alert } from "react-native";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import {
  filterPlugins,
  pluginGroup,
  pluginKey,
  useSettingsRead,
  useSettingsLease,
  type SettingsRpcData,
} from "./settings-adapter.js";
export function SettingsPluginsScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string }>) {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <Plugins key={route.params.deploymentId} host={host} deploymentId={route.params.deploymentId} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}
function Plugins({
  host,
  deploymentId,
}: {
  readonly host: HostClient;
  readonly deploymentId: string;
}) {
  const isCurrent = useSettingsLease(host);
  const navigation = useNavigation();
  const overview = useSettingsRead(host, async () =>
    unwrapRpcResult(await host.rpc["plugins.overview.get"]({})),
  );
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [tag, setTag] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginDetailView | null>(null);
  const [directory, setDirectory] = useState<SettingsRpcData<"plugins.directory.get"> | null>(null);
  const [add, setAdd] = useState<
    SettingsRpcData<"plugins.directory.get">["catalog"][number] | null
  >(null);
  const [mcpTitle, setMcpTitle] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const attempts = useRef(new Map<string, HostApiCommandInput>());
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const run = (key: string, operation: () => Promise<unknown>) => {
    if (busy.current || !isCurrent()) return;
    busy.current = true;
    setPending(key);
    setError(null);
    void operation()
      .catch(() => {
        if (isCurrent()) setError("The change could not be confirmed. Refresh before retrying.");
      })
      .then(async () => {
        await overview.reload();
        busy.current = false;
        setPending(null);
      });
  };
  const command = (key: string, value: HostApiCommandInput) =>
    run(key, async () => {
      const intent = JSON.stringify({ ...value, idempotencyKey: "" });
      const prior = attempts.current.get(intent);
      if (prior) {
        await host.rpc["plugins.overview.get"]({}).then(unwrapRpcResult);
        if (!isCurrent()) return;
      }
      const submitted = prior ?? value;
      attempts.current.set(intent, submitted);
      await host.dispatch(submitted);
      attempts.current.delete(intent);
      if (detail) {
        const result = unwrapRpcResult(
          await host.rpc["plugins.detail.get"]({ target: detail.row.target }),
        );
        if (isCurrent()) setDetail(result);
      }
    });
  const button = (key: string, label: string, onPress: () => void): NativeSettingsRow => ({
    key,
    kind: "button",
    label,
    onPress,
    disabled: pending !== null,
  });
  const text = (key: string, label: string): NativeSettingsRow => ({ key, kind: "text", label });
  const toggle = (row: PluginRow): NativeSettingsRow => ({
    key: `${pluginKey(row)}:enabled`,
    kind: "toggle",
    label: `${row.title}${pending === pluginKey(row) ? " · Saving…" : ""}`,
    value: row.placement.enabled,
    disabled: pending !== null || !row.permissions.canEnable,
    onChange: (enabled) =>
      command(pluginKey(row), {
        type: "settings.plugin.enabled.set",
        target: row.target,
        expectedRevision: row.placement.revision,
        enabled,
        idempotencyKey: mutationIdempotencyKey("settings-plugin-enabled"),
      }),
  });
  const remove = (current: PluginDetailView) =>
    Alert.alert(
      `Remove ${current.row.title}?`,
      "This removes its access. Saved credentials may be removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            run("remove", async () => {
              if (current.row.target.kind === "plugin")
                await host.dispatch({
                  type: "plugin.remove",
                  pluginId: current.row.target.pluginId,
                  idempotencyKey: mutationIdempotencyKey("plugin-remove"),
                });
              else
                for (const installationId of current.installationIds) {
                  if (!isCurrent()) return;
                  await host.dispatch({
                    type: "integration.uninstall",
                    installationId,
                    idempotencyKey: mutationIdempotencyKey("plugin-remove"),
                  });
                }
              if (isCurrent()) setDetail(null);
            }),
        },
      ],
    );
  const sections: NativeSettingsSection[] = [];
  if (error || overview.error)
    sections.push({
      key: "error",
      title: "Needs you",
      rows: [text("error", error ?? overview.error ?? "")],
    });
  if (detail) {
    const row = detail.row;
    sections.push({
      key: "hero",
      title: row.title === "Apple Messages" ? "iMessage" : row.title,
      rows: [
        button("back", "Back to plugins", () => setDetail(null)),
        text("source", `${row.source.kind}${row.source.version ? ` · ${row.source.version}` : ""}`),
        toggle(row),
      ],
    });
    sections.push({
      key: "accounts",
      title: "Accounts",
      rows: [
        ...detail.accounts.map((account) =>
          text(account.connectionId, `${account.displayName} · ${account.status}`),
        ),
        button("add", "Add another account", () =>
          navigation.navigate("ConnectedApps", { deploymentId }),
        ),
      ],
    });
    sections.push({
      key: "permissions",
      title: "What agents may do",
      rows: detail.permissions.map((permission) =>
        text(
          `${permission.layer}:${permission.label}`,
          `${permission.label} · ${permission.layer} · ${permission.state === "ask" ? "Ask first" : permission.state}`,
        ),
      ),
    });
    sections.push({
      key: "contents",
      title: "Comes with",
      rows: detail.contents.map((item) =>
        text(`${item.kind}:${item.name}`, `${item.name} · ${item.kind}`),
      ),
    });
    sections.push({
      key: "places",
      title: "Where it’s on",
      rows: detail.places.map((place) => ({
        key: place.workspaceId,
        kind: "toggle",
        label: place.name,
        value: place.selected,
        disabled: pending !== null || !place.canSelect || !row.permissions.canPlace,
        onChange: (selected) =>
          command(pluginKey(row), {
            type: "settings.plugin.placement.set",
            target: row.target,
            expectedRevision: row.placement.revision,
            mainIncluded: place.kind === "main" ? selected : row.placement.mainIncluded,
            projects: detail.places
              .filter(
                (p) =>
                  p.kind === "project" &&
                  (p.workspaceId === place.workspaceId ? selected : p.selected),
              )
              .map((p) => ({ workspaceId: p.workspaceId, accounts: p.accounts })),
            personalEverywhere: null,
            idempotencyKey: mutationIdempotencyKey("settings-plugin-placement"),
          }),
      })),
    });
    sections.push({
      key: "manage",
      title: "Manage",
      rows: [
        button("repair", "Manage sign-in and permissions", () =>
          navigation.navigate("ConnectedApps", { deploymentId }),
        ),
        ...(row.permissions.canRemove
          ? [button("remove", "Remove plugin", () => remove(detail))]
          : []),
        button("installed", "Manage installed plugin", () =>
          navigation.navigate("Plugins", { deploymentId }),
        ),
      ],
    });
  } else if (directory) {
    sections.push({
      key: "directory",
      title: "Add plugins",
      rows: [
        button("back", "Back to plugins", () => setDirectory(null)),
        ...directory.catalog
          .filter((item) =>
            `${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase()),
          )
          .map((item) =>
            button(item.definitionId, `${item.title}${item.added ? " · Added" : " · Add"}`, () => {
              if (!item.added) setAdd(item);
            }),
          ),
      ],
    });
    sections.push({
      key: "requests",
      title: "Suggested by your agents",
      rows: directory.requests.flatMap((request) => [
        text(`${request.requestId}:title`, request.title),
        ...(["installed", "declined"] as const).map((optionId) =>
          button(
            `${request.requestId}:${optionId}`,
            optionId === "installed" ? "Add" : "Dismiss",
            () =>
              run(request.requestId, async () => {
                const pending = unwrapRpcResult(await host.rpc["requests.list"]({})).requests.find(
                  (item) => item.request.id === request.requestId,
                )?.request;
                if (
                  !isCurrent() ||
                  !pending ||
                  pending.presentation.kind !== "choice" ||
                  !pending.presentation.options.some((option) => option.id === optionId)
                )
                  throw new Error("Request changed");
                await host.dispatch({
                  type: "request.respond",
                  requestId: request.requestId,
                  response: { kind: "choice", optionId },
                  idempotencyKey: mutationIdempotencyKey("plugin-request"),
                });
                const result = unwrapRpcResult(await host.rpc["plugins.directory.get"]({}));
                if (isCurrent()) setDirectory(result);
              }),
          ),
        ),
      ]),
    });
    sections.push({
      key: "install",
      title: "Install from a folder or link",
      rows: [
        {
          key: "folder",
          kind: "input",
          label: "Folder on your computer",
          value: folder,
          onChange: setFolder,
        },
        button("install", "Install plugin", () =>
          command("install", {
            type: "plugin.install",
            input: { directory: folder.trim() },
            idempotencyKey: mutationIdempotencyKey("plugin-install"),
          }),
        ),
        { key: "url", kind: "input", label: "Remote MCP URL", value: mcpUrl, onChange: setMcpUrl },
        {
          key: "mcp-title",
          kind: "input",
          label: "MCP name",
          value: mcpTitle,
          onChange: setMcpTitle,
        },
        button("mcp", "Add remote MCP", () =>
          command("mcp", {
            type: "integration.remoteMcp.install",
            input: {
              name: mcpTitle.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
              title: mcpTitle,
              url: mcpUrl,
            },
            idempotencyKey: mutationIdempotencyKey("remote-mcp-install"),
          }),
        ),
      ],
    });
  } else {
    sections.push({
      key: "actions",
      title: "Plugins",
      rows: [
        button("add", "Add plugins", () =>
          run("directory", async () => {
            const result = unwrapRpcResult(await host.rpc["plugins.directory.get"]({}));
            if (isCurrent()) setDirectory(result);
          }),
        ),
        button("refresh", "Refresh", () => {
          void overview.reload();
        }),
      ],
    });
    sections.push({
      key: "filters",
      title: "Show",
      rows: [
        {
          key: "filters",
          kind: "chips",
          label: "Filter plugins",
          value: tag ?? "",
          onChange: (value) => setTag(value || null),
          choices: [
            { value: "", label: "All" },
            { value: "accounts", label: "Accounts" },
            { value: "devices", label: "On your devices" },
            { value: "skills", label: "Skills" },
            { value: "specialists", label: "Specialists" },
          ],
        },
      ],
    });
    const rows = filterPlugins(overview.data?.rows ?? [], search, tag);
    for (const group of ["Needs you", "On", "Turned off"] as const) {
      const items: NativeSettingsRow[] = [];
      for (const row of rows.filter((row) => pluginGroup(row) === group)) {
        const key = pluginKey(row);
        items.push(
          button(key, row.title === "Apple Messages" ? "iMessage" : row.title, () =>
            run(key, async () => {
              const result = unwrapRpcResult(
                await host.rpc["plugins.detail.get"]({ target: row.target }),
              );
              if (isCurrent()) setDetail(result);
            }),
          ),
        );
        items.push(
          text(
            `${key}:status`,
            group === "Needs you"
              ? row.issues.join(" · ")
              : row.issues.some((issue) => issue.startsWith("waiting-"))
                ? "Waiting"
                : row.placement.personalEverywhere
                  ? "Everywhere"
                  : `${row.placement.mainIncluded ? "Main · " : ""}${row.placement.projectCount} Projects`,
          ),
        );
        items.push(toggle(row));
      }
      if (items.length)
        sections.push({ key: group, title: group, collapsed: group === "Turned off", rows: items });
    }
    if (overview.data?.rows.length === 0)
      sections.push({
        key: "empty",
        title: "No plugins yet",
        rows: [
          button("browse", "Browse all plugins", () =>
            run("directory", async () => {
              const result = unwrapRpcResult(await host.rpc["plugins.directory.get"]({}));
              if (isCurrent()) setDirectory(result);
            }),
          ),
        ],
      });
  }
  return (
    <>
      <NativeSettingsPage sections={sections} search={{ value: query, onChange: setQuery }} />
      <Sheet open={add !== null} title={add?.title ?? "Add plugin"} onClose={() => setAdd(null)}>
        {add ? (
          <NativeSettingsPage
            sections={[
              {
                key: add.definitionId,
                title: add.title,
                rows: [
                  text("description", add.description),
                  text(
                    "consent",
                    "Review accounts and permissions after adding. No Project access is granted by installing.",
                  ),
                  button("add", "Add plugin", () =>
                    run("catalog", async () => {
                      const platform = unwrapRpcResult(
                        await host.rpc["integration.platform.get"]({}),
                      );
                      const entry = platform.catalog.find(
                        (entry) => entry.definition.id === add.definitionId,
                      );
                      if (!entry || !isCurrent()) throw new Error("Catalog changed");
                      await host.dispatch({
                        type: "integration.catalog.install",
                        input: { definitionId: add.definitionId, digest: entry.digest },
                        idempotencyKey: mutationIdempotencyKey("plugin-catalog-install"),
                      });
                      if (!isCurrent()) return;
                      setAdd(null);
                      setDirectory(null);
                      navigation.navigate("ConnectedApps", { deploymentId });
                    }),
                  ),
                ],
              },
            ]}
          />
        ) : null}
      </Sheet>
    </>
  );
}
