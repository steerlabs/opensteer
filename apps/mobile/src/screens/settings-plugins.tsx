import { PluginAccounts } from "./settings-plugin-accounts.js";
import {
  pluginGroups,
  pluginState,
  pluginTargetKey,
  pluginPlacementLabel,
  pluginAccountRows,
} from "@opensteer/client/settings";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { PluginTargetSchema } from "@opensteer/protocol";
import type {
  HostApiCommandInput,
  PluginDetailView,
  PluginRow,
  PluginTarget,
} from "@opensteer/protocol";
import { Alert } from "react-native";
import { Sheet } from "../ui/sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { useSettingsRead, useSettingsLease, type SettingsRpcData } from "./use-settings-read.js";
export function SettingsPluginsScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string; readonly target?: PluginTarget }>) {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <Plugins
      key={route.params.deploymentId}
      host={host}
      deploymentId={route.params.deploymentId}
      target={route.params.target}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}
function Plugins({
  host,
  deploymentId,
  target,
}: {
  readonly host: HostClient;
  readonly deploymentId: string;
  readonly target?: PluginTarget | undefined;
}) {
  const isCurrent = useSettingsLease(host);
  const navigation = useNavigation();
  const overview = useSettingsRead(host, async () =>
    unwrapRpcResult(await host.rpc["plugins.overview.get"]({})),
  );
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [tag, setTag] = useState<PluginRow["tags"][number] | "all">("all");
  const [detail, setDetail] = useState<PluginDetailView | null>(null);
  useEffect(() => {
    if (!target) return;
    const parsed = PluginTargetSchema.safeParse(target);
    if (!parsed.success) return;
    let active = true;
    void host.rpc["plugins.detail.get"]({ target: parsed.data })
      .then(unwrapRpcResult)
      .then((value) => {
        if (active && isCurrent()) setDetail(value);
      })
      .catch(() => {
        if (active && isCurrent()) setError("Couldn’t load plugin.");
      });
    return () => {
      active = false;
    };
  }, [host, target, isCurrent]);
  const [directory, setDirectory] = useState<SettingsRpcData<"plugins.directory.get"> | null>(null);
  const [add, setAdd] = useState<
    SettingsRpcData<"plugins.directory.get">["catalog"][number] | null
  >(null);
  const [addEntry, setAddEntry] = useState<
    SettingsRpcData<"integration.platform.get">["catalog"][number] | null
  >(null);
  const [placingAdd, setPlacingAdd] = useState(false);
  const [suggestions, setSuggestions] = useState<NonNullable<typeof directory>["catalog"]>([]);
  const [addInstalled, setAddInstalled] = useState(false);
  const [consented, setConsented] = useState(false);
  const openAdd = (item: NonNullable<typeof add>) =>
    run("review", async () => {
      const platform = unwrapRpcResult(await host.rpc["integration.platform.get"]({}));
      const entry = platform.catalog.find((entry) => entry.definition.id === item.definitionId);
      if (!entry || !isCurrent()) throw new Error("Catalog changed");
      setAddEntry(entry);
      setConsented(false);
      setAddInstalled(false);
      setPlacingAdd(false);
      setAdd(item);
    });
  const [accountDefinition, setAccountDefinition] = useState<string | null>(null);
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
  useEffect(() => {
    if (overview.data?.rows.length !== 0) return;
    let active = true;
    void host.rpc["plugins.directory.get"]({})
      .then(unwrapRpcResult)
      .then((result) => {
        if (active && isCurrent())
          setSuggestions(result.catalog.filter((item) => !item.added).slice(0, 3));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [host, overview.data?.rows.length, isCurrent]);
  const button = (
    key: string,
    label: string,
    onPress: () => void,
  ): Extract<NativeSettingsRow, { kind: "button" }> => ({
    key,
    kind: "button",
    label,
    onPress,
    disabled: pending !== null,
  });
  const text = (key: string, label: string): NativeSettingsRow => ({ key, kind: "text", label });
  const toggle = (row: PluginRow): NativeSettingsRow => ({
    key: `${`${row.target.kind}:${pluginTargetKey(row.target)}`}:enabled`,
    kind: "toggle",
    label: `${row.title}${pending === `${row.target.kind}:${pluginTargetKey(row.target)}` ? " · Saving…" : ""}`,
    value: row.placement.enabled,
    disabled: pending !== null || !row.permissions.canEnable,
    onChange: (enabled) =>
      command(`${row.target.kind}:${pluginTargetKey(row.target)}`, {
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
        text("source", `${row.source.kind}${row.source.version ? ` · ${row.source.version}` : ""}`),
        toggle(row),
      ],
    });
    sections.push({
      key: "accounts",
      title: "Accounts",
      rows: [
        ...pluginAccountRows(detail).map((account) =>
          text(account.connectionId, `${account.displayName} · ${account.status}`),
        ),
        button("add", "Add another account", () =>
          setAccountDefinition(
            row.target.kind === "service" || row.target.kind === "device-app"
              ? row.target.definitionId
              : null,
          ),
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
      rows: [
        ...(host.getSnapshot().deploymentShape?.kind === "personal"
          ? [
              {
                key: "everywhere",
                kind: "toggle" as const,
                label: "Everywhere, including new Projects",
                value: row.placement.personalEverywhere,
                disabled: pending !== null || !row.permissions.canPlace,
                onChange: (enabled: boolean) =>
                  command("everywhere", {
                    type: "settings.plugin.placement.set",
                    target: row.target,
                    expectedRevision: row.placement.revision,
                    mainIncluded: enabled || row.placement.mainIncluded,
                    projects: detail.places
                      .filter((place) => place.kind === "project" && (enabled || place.selected))
                      .map((place) => ({
                        workspaceId: place.workspaceId,
                        accounts: place.accounts,
                      })),
                    personalEverywhere: enabled
                      ? {
                          accounts: detail.accounts.flatMap((account) =>
                            account.access
                              ? [{ connectionId: account.connectionId, access: account.access }]
                              : [],
                          ),
                        }
                      : null,
                    idempotencyKey: mutationIdempotencyKey("settings-plugin-everywhere"),
                  }),
              },
            ]
          : []),
        ...detail.places.map(
          (place) =>
            ({
              key: place.workspaceId,
              kind: "toggle",
              label: place.name,
              value: place.selected,
              disabled: pending !== null || !place.canSelect || !row.permissions.canPlace,
              onChange: (selected) =>
                command(`${row.target.kind}:${pluginTargetKey(row.target)}`, {
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
            }) as NativeSettingsRow,
        ),
      ],
    });
    sections.push({
      key: "manage",
      title: "Manage",
      rows: [
        button("repair", "Manage sign-in and permissions", () =>
          setAccountDefinition(
            row.target.kind === "service" || row.target.kind === "device-app"
              ? row.target.definitionId
              : null,
          ),
        ),
        ...(row.permissions.canRemove
          ? [{ ...button("remove", "Remove plugin", () => remove(detail)), destructive: true }]
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
              if (!item.added) {
                openAdd(item);
              }
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
    if (host.getSnapshot().user?.instanceRole === "administrator")
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
          {
            key: "url",
            kind: "input",
            label: "Remote MCP URL",
            value: mcpUrl,
            onChange: setMcpUrl,
          },
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
          value: tag,
          onChange: (value) => {
            if (["all", "accounts", "devices", "skills", "specialists"].includes(value))
              setTag(value as typeof tag);
          },
          choices: [
            { value: "all", label: "All" },
            { value: "accounts", label: "Accounts" },
            { value: "devices", label: "On your devices" },
            { value: "skills", label: "Skills" },
            { value: "specialists", label: "Specialists" },
          ],
        },
      ],
    });
    const groups = pluginGroups(overview.data?.rows ?? [], search, tag);
    for (const group of ["Needs you", "On", "Turned off"] as const) {
      const items: NativeSettingsRow[] = [];
      for (const row of groups[group]) {
        const key = `${row.target.kind}:${pluginTargetKey(row.target)}`;
        items.push({
          ...button(key, row.title === "Apple Messages" ? "iMessage" : row.title, () =>
            navigation.navigate("SettingsPluginDetail", { deploymentId, target: row.target }),
          ),
          actions: [
            ...(row.placement.enabled && row.permissions.canEnable
              ? [
                  {
                    label: "Turn off",
                    onPress: () =>
                      command(key, {
                        type: "settings.plugin.enabled.set",
                        target: row.target,
                        expectedRevision: row.placement.revision,
                        enabled: false,
                        idempotencyKey: mutationIdempotencyKey("settings-plugin-off"),
                      }),
                  },
                ]
              : []),
            ...(row.permissions.canRemove
              ? [
                  {
                    label: "Remove",
                    destructive: true,
                    onPress: () =>
                      run(key, async () => {
                        const value = unwrapRpcResult(
                          await host.rpc["plugins.detail.get"]({ target: row.target }),
                        );
                        if (isCurrent()) remove(value);
                      }),
                  },
                ]
              : []),
          ],
        });
        items.push(
          text(
            `${key}:status`,
            pluginState(row).group === "Needs you" || pluginState(row).label === "Waiting"
              ? pluginState(row).label
              : pluginPlacementLabel(row, host.getSnapshot().deploymentShape?.kind === "personal"),
          ),
        );
        if (group !== "Needs you") items.push(toggle(row));
        else
          items.push(
            button(`${key}:repair`, pluginState(row).label, () =>
              navigation.navigate("SettingsPluginDetail", { deploymentId, target: row.target }),
            ),
          );
      }
      if (items.length)
        sections.push({ key: group, title: group, collapsed: group === "Turned off", rows: items });
    }
    if (overview.data?.rows.length === 0)
      sections.push({
        key: "empty",
        title: "No plugins yet",
        rows: [
          ...suggestions.map((item) => button(item.definitionId, item.title, () => openAdd(item))),
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
      <NativeSettingsPage
        sections={sections}
        {...(target ? {} : { search: { value: query, onChange: setQuery } })}
      />
      <Sheet
        open={accountDefinition !== null}
        title="Accounts and permissions"
        onClose={() => {
          setAccountDefinition(null);
          void overview.reload();
        }}
      >
        {accountDefinition ? (
          <PluginAccounts
            hostClient={host}
            hostName={host.getSnapshot().identityConfig?.deployment.name ?? "Opensteer"}
            definitionId={accountDefinition}
          />
        ) : null}
      </Sheet>
      <Sheet
        open={add !== null}
        title={add?.title ?? "Add plugin"}
        onClose={() => {
          setAdd(null);
          setAddEntry(null);
          if (placingAdd) setDetail(null);
          void overview.reload();
        }}
      >
        {add && addEntry ? (
          <>
            <NativeSettingsPage
              sections={
                placingAdd
                  ? [
                      ...sections.filter((section) =>
                        ["contents", "places", "error"].includes(section.key),
                      ),
                      {
                        key: "done",
                        title: "Finish",
                        rows: [
                          button("done", "Done", () => {
                            setAdd(null);
                            setDirectory(null);
                            setDetail(null);
                          }),
                        ],
                      },
                    ]
                  : [
                      {
                        key: "description",
                        title: "What it does",
                        rows: [text("description", add.description)],
                      },
                      {
                        key: "access",
                        title: "What it will access",
                        rows: [
                          ...addEntry.definition.authMethods.flatMap((method) =>
                            method.kind === "oauth"
                              ? method.oauth.scopes.map((scope) =>
                                  text(`${method.id}:${scope}`, scope),
                                )
                              : [text(method.id, method.label)],
                          ),
                          {
                            key: "consent",
                            kind: "toggle",
                            label: `Allow ${add.title} to request this access`,
                            value: consented,
                            disabled: pending !== null || addInstalled,
                            onChange: setConsented,
                          },
                        ],
                      },
                      {
                        key: "install",
                        title: "Add plugin",
                        rows: addInstalled
                          ? [
                              text(
                                "installed",
                                "Added. Connect your account below, then choose where it’s on.",
                              ),
                              button("placement", "Choose where it’s on", () =>
                                run("placement", async () => {
                                  const result = unwrapRpcResult(
                                    await host.rpc["plugins.detail.get"]({
                                      target: {
                                        kind: addEntry.definition.computerApp
                                          ? "device-app"
                                          : "service",
                                        definitionId: add.definitionId,
                                      },
                                    }),
                                  );
                                  if (!isCurrent()) return;
                                  setDetail(result);
                                  setPlacingAdd(true);
                                }),
                              ),
                            ]
                          : [
                              {
                                ...button("add", "Add and continue to sign-in", () =>
                                  run("catalog", async () => {
                                    await host.dispatch({
                                      type: "integration.catalog.install",
                                      input: {
                                        definitionId: add.definitionId,
                                        digest: addEntry.digest,
                                      },
                                      idempotencyKey:
                                        mutationIdempotencyKey("plugin-catalog-install"),
                                    });
                                    if (isCurrent()) setAddInstalled(true);
                                  }),
                                ),
                                disabled: !consented || pending !== null,
                              },
                            ],
                      },
                    ]
              }
            />
            {addInstalled && !placingAdd ? (
              <PluginAccounts
                hostClient={host}
                hostName={host.getSnapshot().identityConfig?.deployment.name ?? "Opensteer"}
                definitionId={add.definitionId}
              />
            ) : null}
          </>
        ) : null}
      </Sheet>
    </>
  );
}
