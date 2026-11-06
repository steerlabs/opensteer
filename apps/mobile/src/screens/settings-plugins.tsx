import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import {
  localMcpSecretServers,
  localMcpSecretsToSend,
  setLocalMcpServerSecrets,
  type LocalMcpSecretServer,
} from "@opensteer/client/integrations";
import { PluginAccounts } from "./settings-plugin-accounts.js";
import {
  completePluginConsent,
  addPluginService,
  pluginCatalogCategories,
  pluginCatalogMatches,
  pluginCatalogProducts,
  pluginCatalogToAdd,
  remoteMcpSlug,
  type PluginAddConsent,
  type PluginCatalogProduct,
  settingsMutationRejected,
  pluginPlacementAccounts,
  pluginGroups,
  pluginState,
  pluginTargetKey,
  pluginPlacementLabel,
  pluginAccountRows,
} from "@opensteer/client/settings";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
  const aiSharing = useAiSharing();
  const isCurrent = useSettingsLease(host);
  const navigation = useNavigation();
  const overview = useSettingsRead(host, async () =>
    unwrapRpcResult(await host.rpc["plugins.overview.get"]({})),
  );
  const secrets = useSettingsRead(host, () => localMcpSecretServers(host));
  const [changingSecrets, setChangingSecrets] = useState<LocalMcpSecretServer | null>(null);
  const [secretValues, setSecretValues] = useState<Readonly<Record<string, string>>>({});
  const [secretsSaved, setSecretsSaved] = useState(false);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [serverEntries, setServerEntries] = useState<
    SettingsRpcData<"integration.platform.get">["installations"]
  >([]);
  const [placementAccounts, setPlacementAccounts] = useState<
    PluginDetailView["places"][number]["accounts"]
  >([]);
  const [detailTarget, setDetailTarget] = useState(target);
  useEffect(() => {
    setDetailTarget(target);
    setPlacementAccounts([]);
  }, [target]);
  const detailRead = useSettingsRead(
    host,
    async () => {
      if (!detailTarget) return null;
      return unwrapRpcResult(
        await host.rpc["plugins.detail.get"]({
          target: PluginTargetSchema.parse(detailTarget),
        }),
      );
    },
    JSON.stringify(detailTarget),
  );
  const detail = detailRead.data;
  useEffect(() => {
    if (!detail) {
      setServerEntries([]);
      return;
    }
    let active = true;
    void host.rpc["integration.platform.get"]({})
      .then(unwrapRpcResult)
      .then((platform) => {
        if (active && isCurrent())
          setServerEntries(
            platform.installations.filter((entry) =>
              detail.installationIds.includes(entry.installation.id),
            ),
          );
      })
      .catch(() => {
        if (active && isCurrent()) setError("Couldn’t load MCP servers.");
      });
    return () => {
      active = false;
    };
  }, [host, detail, isCurrent]);
  const directory = useSettingsRead(
    host,
    async () => (target ? null : unwrapRpcResult(await host.rpc["plugins.directory.get"]({}))),
    target ? "detail" : "overview",
  );
  const [shelf, setShelf] = useState("popular");
  const [add, setAdd] = useState<{
    readonly product: PluginCatalogProduct;
    readonly definitionId: string;
  } | null>(null);
  const [addEntry, setAddEntry] = useState<
    SettingsRpcData<"integration.platform.get">["catalog"][number] | null
  >(null);
  const [addInstalled, setAddInstalled] = useState(false);
  const addConsent = useRef<PluginAddConsent | null>(null);
  const [addPlaces, setAddPlaces] = useState<string[]>([]);
  const [addEverywhere, setAddEverywhere] = useState(false);
  const [addingOwn, setAddingOwn] = useState(false);
  const [ownKind, setOwnKind] = useState<"folder" | "mcp">("folder");
  const openAdd = (
    product: PluginCatalogProduct,
    definitionId = product.variants[0].definitionId,
  ) =>
    run("review", async () => {
      const platform = unwrapRpcResult(await host.rpc["integration.platform.get"]({}));
      const entry = platform.catalog.find((entry) => entry.definition.id === definitionId);
      if (!entry || !isCurrent()) throw new Error("Catalog changed");
      setAddEntry(entry);
      if (add?.product.id !== product.id) {
        setAddPlaces([]);
        setAddEverywhere(host.getSnapshot().deploymentShape?.kind === "personal");
      }
      addConsent.current = null;
      setAddInstalled(false);
      setAdd({ product, definitionId });
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
        await Promise.all([overview.reload(), detailRead.reload()]);
        busy.current = false;
        setPending(null);
      });
  };
  const command = (key: string, value: HostApiCommandInput) =>
    run(key, async () => {
      const intent = JSON.stringify(
        value.type === "settings.plugin.enabled.set" ||
          value.type === "settings.plugin.placement.set"
          ? { type: value.type, target: value.target }
          : { ...value, idempotencyKey: "" },
      );
      const prior = attempts.current.get(intent);
      if (prior) {
        await host.rpc["plugins.overview.get"]({}).then(unwrapRpcResult);
        if (!isCurrent()) return;
      }
      const submitted = prior ?? value;
      attempts.current.set(intent, submitted);
      try {
        await host.dispatch(submitted);
      } catch (reason) {
        if (settingsMutationRejected(reason)) attempts.current.delete(intent);
        throw reason;
      }
      attempts.current.delete(intent);
      await detailRead.reload();
    });
  const toAdd = useMemo(
    () =>
      directory.data && overview.data
        ? pluginCatalogToAdd(pluginCatalogProducts(directory.data.catalog), overview.data.rows)
        : null,
    [directory.data, overview.data],
  );
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
              if (isCurrent()) setDetailTarget(undefined);
            }),
        },
      ],
    );
  const productRow = (product: PluginCatalogProduct): NativeSettingsRow => ({
    ...button(`product:${product.id}`, product.title, () => openAdd(product)),
    mark: { definitionId: product.id, name: product.title },
  });
  const catalogRows = (): NativeSettingsRow[] => {
    if (directory.error) return [text("catalog-error", directory.error)];
    if (!toAdd) return [text("catalog-loading", "Loading…")];
    const own =
      host.getSnapshot().user?.instanceRole === "administrator"
        ? [
            button("add-your-own", "Add your own…", () => {
              setFolder("");
              setMcpTitle("");
              setMcpUrl("");
              setOwnKind("folder");
              setAddingOwn(true);
            }),
          ]
        : [];
    if (search.trim()) {
      const matching = toAdd.filter((product) => pluginCatalogMatches(product, search));
      return [
        ...(matching.length
          ? matching.map(productRow)
          : [text("catalog-none", `Nothing to add matches “${search.trim()}”.`)]),
        ...own,
      ];
    }
    const categories = pluginCatalogCategories(toAdd);
    const popular = toAdd.filter((product) => product.popular).slice(0, 6);
    const shelves = [
      ...(popular.length ? [{ id: "popular", label: "Popular" }] : []),
      ...categories,
      { id: "all", label: "All" },
    ];
    const active = shelves.some(({ id }) => id === shelf) ? shelf : shelves[0]!.id;
    const shown =
      active === "popular"
        ? popular
        : active === "all"
          ? toAdd
          : toAdd.filter((product) => product.category === active);
    return [
      {
        key: "shelf",
        kind: "chips",
        label: "Browse",
        value: active,
        choices: shelves.map(({ id, label }) => ({ value: id, label })),
        onChange: setShelf,
      },
      ...(shown.length
        ? shown.map(productRow)
        : [text("catalog-done", "You’ve added everything in the catalog.")]),
      ...own,
    ];
  };
  const sections: NativeSettingsSection[] = [];
  if (error || overview.error || detailRead.error)
    sections.push({
      key: "error",
      title: "Needs you",
      rows: [text("error", error ?? detailRead.error ?? overview.error ?? "")],
    });
  if (detail) {
    const row = detail.row;
    sections.push({
      key: "hero",
      title: row.title,
      rows: [
        text("source", `${row.source.kind}${row.source.version ? ` · ${row.source.version}` : ""}`),
        toggle(row),
      ],
    });
    const servers =
      secrets.data?.filter((server) => detail.installationIds.includes(server.installationId)) ??
      [];
    if (servers.length)
      sections.push({
        key: "secrets",
        title: "Secrets on your computers",
        rows: servers.flatMap((server) => [
          text(
            `${server.id}:computer`,
            [server.name, server.computer, ...server.secrets.map((secret) => secret.title)]
              .filter(Boolean)
              .join(" · "),
          ),
          button(server.id, "Change secrets", () => {
            setSecretValues({});
            setSecretsSaved(false);
            setChangingSecrets(server);
          }),
        ]),
      });
    if (secrets.error)
      sections.push({
        key: "secrets-error",
        title: "Secrets",
        rows: [text("secrets-error", secrets.error)],
      });
    if (secretsSaved)
      sections.push({
        key: "secrets-saved",
        title: "Secrets",
        rows: [text("secrets-saved", "Secrets changed")],
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
    if (serverEntries.some((entry) => entry.servers.length))
      sections.push({
        key: "servers",
        title: "MCP servers",
        rows: serverEntries.flatMap((entry) =>
          entry.servers.map((server) => text(server.id, `${server.name} · ${server.status}`)),
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
        ...detail.accounts.map((account): NativeSettingsRow => ({
          key: `access:${account.connectionId}`,
          kind: "chips",
          label: `Access for ${account.displayName}`,
          value:
            placementAccounts.find((a) => a.connectionId === account.connectionId)?.access ?? "",
          choices: [
            { value: "", label: "Choose access" },
            { value: "read", label: "Read" },
            { value: "read-write", label: "Read and update" },
          ],
          onChange: (access) =>
            setPlacementAccounts((previous) => [
              ...previous.filter((a) => a.connectionId !== account.connectionId),
              ...(access === "read" || access === "read-write"
                ? [
                    {
                      connectionId: account.connectionId,
                      access: access === "read" ? ("read" as const) : ("read-write" as const),
                    },
                  ]
                : []),
            ]),
        })),

        ...(host.getSnapshot().deploymentShape?.kind === "personal"
          ? [
              {
                key: "everywhere",
                kind: "toggle" as const,
                label: "Everywhere, including new Projects",
                value: row.placement.personalEverywhere,
                disabled:
                  pending !== null ||
                  !row.permissions.canPlace ||
                  ((row.target.kind === "service" || row.target.kind === "device-app") &&
                    !placementAccounts.length &&
                    !row.placement.personalEverywhere),
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
                        accounts: pluginPlacementAccounts(
                          enabled ? [] : place.accounts,
                          placementAccounts,
                          row.target.kind === "service" || row.target.kind === "device-app",
                        ),
                      })),
                    personalEverywhere: enabled
                      ? {
                          accounts: pluginPlacementAccounts(
                            [],
                            placementAccounts,
                            row.target.kind === "service" || row.target.kind === "device-app",
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
              disabled:
                pending !== null ||
                !place.canSelect ||
                !row.permissions.canPlace ||
                ((row.target.kind === "service" || row.target.kind === "device-app") &&
                  place.kind === "project" &&
                  !place.selected &&
                  !placementAccounts.length),
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
                    .map((p) => ({
                      workspaceId: p.workspaceId,
                      accounts: pluginPlacementAccounts(
                        p.accounts,
                        placementAccounts,
                        row.target.kind === "service" || row.target.kind === "device-app",
                      ),
                    })),
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
      ],
    });
  } else {
    const groups = pluginGroups(overview.data?.rows ?? [], search);
    for (const group of ["Needs you", "On", "Turned off"] as const) {
      const items: NativeSettingsRow[] = [];
      for (const row of groups[group]) {
        const key = `${row.target.kind}:${pluginTargetKey(row.target)}`;
        items.push({
          ...button(key, row.title, () =>
            navigation.navigate("SettingsPluginDetail", { deploymentId, target: row.target }),
          ),
          ...(row.target.kind === "service" || row.target.kind === "device-app"
            ? { mark: { definitionId: row.target.definitionId, name: row.title } }
            : {}),
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
    if (directory.data?.requests.length)
      sections.push({
        key: "requests",
        title: "Asked for by your agents",
        rows: directory.data.requests.flatMap((request) => [
          text(`${request.requestId}:title`, request.title),
          ...(["installed", "declined"] as const).map((optionId) =>
            button(
              `${request.requestId}:${optionId}`,
              optionId === "installed" ? "Add" : "Dismiss",
              () =>
                run(request.requestId, async () => {
                  const pending = unwrapRpcResult(
                    await host.rpc["requests.list"]({}),
                  ).requests.find((item) => item.request.id === request.requestId)?.request;
                  if (
                    !isCurrent() ||
                    !pending ||
                    pending.presentation.kind !== "choice" ||
                    !pending.presentation.options.some((option) => option.id === optionId)
                  )
                    throw new Error("Request changed");
                  if (optionId !== "declined" && !(await authorizeAiSharing(aiSharing, host)))
                    return;
                  if (!isCurrent()) return;
                  await host.dispatch({
                    type: "request.respond",
                    requestId: request.requestId,
                    response: { kind: "choice", optionId },
                    idempotencyKey: mutationIdempotencyKey("plugin-request"),
                  });
                  await directory.reload();
                }),
            ),
          ),
        ]),
      });
    sections.push({
      key: "add-more",
      title: "Add more",
      rows: catalogRows(),
    });
  }
  if (!detail && secrets.data?.length)
    sections.push({
      key: "secrets",
      title: "Secrets on your computers",
      rows: secrets.data.flatMap((server) => [
        text(
          `${server.id}:computer`,
          [
            server.plugin,
            server.name,
            server.computer,
            ...server.secrets.map((secret) => secret.title),
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        button(server.id, "Change secrets", () => {
          setSecretValues({});
          setSecretsSaved(false);
          setChangingSecrets(server);
        }),
      ]),
    });
  if (!detail && secretsSaved)
    sections.push({
      key: "secrets-saved",
      title: "Secrets",
      rows: [text("secrets-saved", "Secrets changed")],
    });
  return (
    <>
      <NativeSettingsPage
        sections={sections}
        {...(target ? {} : { search: { value: query, onChange: setQuery } })}
      />
      {changingSecrets ? (
        <NativeSettingsPage
          sheet={{
            title: `${changingSecrets.plugin}’s secrets`,
            onClose: () => {
              if (!pending) {
                setChangingSecrets(null);
                setSecretValues({});
              }
            },
          }}
          sections={[
            {
              key: "secret-fields",
              title: "Enter only what changed",
              rows: [
                ...changingSecrets.secrets.map((secret) => ({
                  key: secret.name,
                  kind: "input" as const,
                  label: secret.title,
                  secure: true,
                  value: secretValues[secret.name] ?? "",
                  onChange: (value: string) => {
                    if (!pending)
                      setSecretValues((current) => ({ ...current, [secret.name]: value }));
                  },
                })),
                button("save-secrets", pending ? "Saving…" : "Save", () => {
                  const entered = localMcpSecretsToSend(
                    changingSecrets.secrets.map((secret) => ({ ...secret, saved: true })),
                    secretValues,
                  );
                  if (!entered.ok || !Object.keys(entered.secrets).length) {
                    setError(entered.ok ? "Enter a new value to change." : entered.message);
                    return;
                  }
                  run("secrets", async () => {
                    await setLocalMcpServerSecrets(host, changingSecrets.id, entered.secrets);
                    if (isCurrent()) {
                      setChangingSecrets(null);
                      setSecretValues({});
                      setSecretsSaved(true);
                    }
                  });
                }),
                ...(error ? [text("secret-error", error)] : []),
              ],
            },
          ]}
        />
      ) : null}
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
      {add && addEntry
        ? (() => {
            const entry =
              add.product.variants.find((variant) => variant.definitionId === add.definitionId) ??
              add.product.variants[0];
            const close = () => {
              setAdd(null);
              setAddEntry(null);
              setDetailTarget(undefined);
              void overview.reload();
              void directory.reload();
            };
            const review: NativeSettingsSection[] = [
              {
                key: "description",
                title: "What it does",
                rows: [text("description", entry.description)],
              },
              {
                key: "contents",
                title: "Comes with",
                rows: (entry.contents ?? []).map((item) =>
                  text(`${item.kind}:${item.name}`, `${item.name} · ${item.kind}`),
                ),
              },
              ...(add.product.variants.length > 1
                ? [
                    {
                      key: "variant",
                      title: "How it connects",
                      rows: [
                        {
                          key: "variant",
                          kind: "chips" as const,
                          label: "How it connects",
                          value: add.definitionId,
                          choices: add.product.variants.map((variant) => ({
                            value: variant.definitionId,
                            label: variant.variant ?? variant.title,
                          })),
                          onChange: (definitionId: string) => {
                            // Adding is for the way chosen when it began.
                            if (!addInstalled && pending === null)
                              openAdd(add.product, definitionId);
                          },
                        },
                      ],
                    },
                  ]
                : []),
              {
                key: "access",
                title: "What it can reach",
                rows: addEntry.definition.authMethods.flatMap((method) =>
                  method.kind === "oauth"
                    ? method.oauth.scopes.map((scope) => text(`${method.id}:${scope}`, scope))
                    : [text(method.id, method.label)],
                ),
              },
              {
                key: "places",
                title: "Where it’s on",
                rows: [
                  ...(host.getSnapshot().deploymentShape?.kind === "personal"
                    ? [
                        {
                          key: "everywhere",
                          kind: "toggle" as const,
                          label: "Everywhere, including new Projects",
                          value: addEverywhere,
                          disabled: addInstalled || pending !== null,
                          onChange: setAddEverywhere,
                        },
                      ]
                    : []),
                  ...(!addEverywhere
                    ? host.getSnapshot().workspaces.map((place) => ({
                        key: place.id,
                        kind: "toggle" as const,
                        label: place.name,
                        value: addPlaces.includes(place.id),
                        disabled: addInstalled || pending !== null,
                        onChange: (selected: boolean) =>
                          setAddPlaces((places) =>
                            selected
                              ? [...places, place.id]
                              : places.filter((id) => id !== place.id),
                          ),
                      }))
                    : []),
                ],
              },
              ...(error
                ? [{ key: "error", title: "Needs you", rows: [text("error", error)] }]
                : []),
            ];
            const render = (accounts: NativeSettingsSection[]) => (
              <NativeSettingsPage
                sheet={{ title: add.product.title, onClose: close }}
                sections={[
                  ...review,
                  ...accounts,
                  {
                    key: "install",
                    title: addInstalled ? "Finish" : add.product.title,
                    rows: addInstalled
                      ? [button("done", "Done", close)]
                      : [
                          button(
                            "add",
                            addEntry.definition.computerApp
                              ? `Add ${add.product.title}`
                              : `Connect ${add.product.title}`,
                            () =>
                              run("catalog", async () => {
                                if (!entry.added)
                                  await host.dispatch({
                                    type: "integration.catalog.install",
                                    input: {
                                      definitionId: entry.definitionId,
                                      digest: addEntry.digest,
                                    },
                                    idempotencyKey:
                                      mutationIdempotencyKey("plugin-catalog-install"),
                                  });
                                if (!isCurrent()) return;
                                const target: PluginTarget = {
                                  kind: addEntry.definition.computerApp ? "device-app" : "service",
                                  definitionId: entry.definitionId,
                                };
                                await addPluginService(host, target);
                                if (isCurrent()) {
                                  addConsent.current = {
                                    target,
                                    everywhere: addEverywhere,
                                    places: addPlaces,
                                    access: "read",
                                    idempotencyKey: mutationIdempotencyKey(
                                      "plugin-add-account-placement",
                                    ),
                                    command: null,
                                  };
                                  setAddInstalled(true);
                                }
                              }),
                          ),
                        ],
                  },
                ]}
              />
            );
            return addInstalled ? (
              <PluginAccounts
                hostClient={host}
                hostName={host.getSnapshot().identityConfig?.deployment.name ?? "Opensteer"}
                definitionId={entry.definitionId}
                render={render}
                onConnected={async (connectionId) => {
                  const consent = addConsent.current;
                  if (!consent || !isCurrent()) throw new Error("Review placement again.");
                  await completePluginConsent(host, consent, connectionId, (next) => {
                    addConsent.current = next;
                  });
                }}
              />
            ) : (
              render([])
            );
          })()
        : null}
      {addingOwn ? (
        <NativeSettingsPage
          sheet={{
            title: "Add your own",
            onClose: () => {
              if (!pending) setAddingOwn(false);
            },
          }}
          sections={[
            {
              key: "kind",
              title: "What to add",
              rows: [
                {
                  key: "kind",
                  kind: "chips",
                  label: "What to add",
                  value: ownKind,
                  choices: [
                    { value: "folder", label: "Plugin folder" },
                    { value: "mcp", label: "MCP server" },
                  ],
                  onChange: (value) => setOwnKind(value === "mcp" ? "mcp" : "folder"),
                },
              ],
            },
            ownKind === "folder"
              ? {
                  key: "folder",
                  title: `Folder on ${host.getSnapshot().identityConfig?.deployment.name ?? "the computer Opensteer runs on"}`,
                  rows: [
                    {
                      key: "folder",
                      kind: "input",
                      label: "Folder path",
                      value: folder,
                      onChange: setFolder,
                    },
                    text(
                      "folder-hint",
                      "A folder with a plugin.json (Agent Plugins 1.0). Programs it starts run only after that computer’s owner approves them.",
                    ),
                    {
                      ...button("install", pending === "install" ? "Adding…" : "Add plugin", () =>
                        run("install", async () => {
                          const result = await host.dispatch({
                            type: "plugin.install",
                            input: { directory: folder.trim() },
                            idempotencyKey: mutationIdempotencyKey("plugin-install"),
                          });
                          if (!isCurrent()) return;
                          setAddingOwn(false);
                          if (result.type === "plugin.install" && result.issues.length)
                            Alert.alert(
                              `Added without ${result.issues.length === 1 ? "one part" : `${result.issues.length} parts`}`,
                              result.issues
                                .slice(0, 5)
                                .map(
                                  ({ component, entry, message }) =>
                                    `${entry ?? component}: ${message}`,
                                )
                                .join("\n"),
                            );
                        }),
                      ),
                      disabled: pending !== null || folder.trim() === "",
                    },
                  ],
                }
              : {
                  key: "mcp",
                  title: "MCP server",
                  rows: [
                    {
                      key: "mcp-title",
                      kind: "input",
                      label: "Name",
                      value: mcpTitle,
                      onChange: setMcpTitle,
                    },
                    {
                      key: "url",
                      kind: "input",
                      label: "Address (https://…)",
                      value: mcpUrl,
                      onChange: setMcpUrl,
                    },
                    text(
                      "mcp-hint",
                      "A remote MCP server over HTTPS. You sign in to it after adding it; keys never go in its address.",
                    ),
                    {
                      ...button("mcp", pending === "mcp" ? "Adding…" : "Add MCP server", () =>
                        run("mcp", async () => {
                          await host.dispatch({
                            type: "integration.remoteMcp.install",
                            input: {
                              description: "",
                              name: remoteMcpSlug(mcpTitle),
                              title: mcpTitle.trim(),
                              url: mcpUrl.trim(),
                            },
                            idempotencyKey: mutationIdempotencyKey("remote-mcp-install"),
                          });
                          if (isCurrent()) setAddingOwn(false);
                        }),
                      ),
                      disabled: pending !== null || !mcpTitle.trim() || !mcpUrl.trim(),
                    },
                  ],
                },
            ...(error
              ? [{ key: "own-error", title: "Needs you", rows: [text("own-error", error)] }]
              : []),
          ]}
        />
      ) : null}
    </>
  );
}
