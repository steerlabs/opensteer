import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { notDone } from "../ui/client-feedback.js";
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
  pluginGroups,
  pluginState,
  pluginTargetKey,
  pluginAccountRows,
  pluginsPageRows,
  fixDeviceDraftText,
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
import { readLine, settingsFooter, useScreenAction, useScreenRead } from "../ui/client-feedback.js";
import type { SettingsRpcData } from "./settings-rpc.js";
import { useLeaveSheets } from "./leave-sheets.js";
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
  const navigation = useNavigation();
  const leave = useLeaveSheets(deploymentId, host);
  const pluginsChanged = (listener: () => void) => host.subscribePluginsChanged(listener);
  const overview = useScreenRead(host, {
    key: "plugins-overview",
    label: "plugins",
    read: async () => unwrapRpcResult(await host.rpc["plugins.overview.get"]({})),
    subscribeInvalidation: pluginsChanged,
  });
  const secrets = useScreenRead(host, {
    key: "plugin-secrets",
    label: "secrets",
    read: () => localMcpSecretServers(host),
    subscribeInvalidation: pluginsChanged,
  });
  const [changingSecrets, setChangingSecrets] = useState<LocalMcpSecretServer | null>(null);
  const [secretValues, setSecretValues] = useState<Readonly<Record<string, string>>>({});
  const [secretsSaved, setSecretsSaved] = useState(false);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [detailTarget, setDetailTarget] = useState(target);
  useEffect(() => {
    setDetailTarget(target);
  }, [target]);
  const detailRead = useScreenRead(host, {
    key: `plugin-detail:${JSON.stringify(detailTarget)}`,
    label: "this plugin",
    read: detailTarget
      ? async () =>
          unwrapRpcResult(
            await host.rpc["plugins.detail.get"]({
              target: PluginTargetSchema.parse(detailTarget),
            }),
          )
      : null,
    subscribeInvalidation: pluginsChanged,
  });
  const detail = detailRead.data;
  const installationIds = detail?.installationIds.join(" ") ?? null;
  const servers = useScreenRead(host, {
    key: `plugin-servers:${installationIds}`,
    label: "MCP servers",
    read:
      installationIds === null
        ? null
        : async () => {
            const ids = new Set(installationIds.split(" "));
            const platform = unwrapRpcResult(await host.rpc["integration.platform.get"]({}));
            return platform.installations.filter((entry) => ids.has(entry.installation.id));
          },
  });
  const serverEntries: SettingsRpcData<"integration.platform.get">["installations"] =
    servers.data ?? [];
  const directory = useScreenRead(host, {
    key: target ? "plugins-directory:detail" : "plugins-directory",
    label: "the catalog",
    read: target ? null : async () => unwrapRpcResult(await host.rpc["plugins.directory.get"]({})),
    subscribeInvalidation: pluginsChanged,
  });
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
  const [addingOwn, setAddingOwn] = useState(false);
  const [ownKind, setOwnKind] = useState<"folder" | "mcp">("folder");
  const openAdd = (
    product: PluginCatalogProduct,
    definitionId = product.variants[0].definitionId,
  ) =>
    run({
      run: async () => {
        const platform = unwrapRpcResult(await host.rpc["integration.platform.get"]({}));
        const entry = platform.catalog.find((entry) => entry.definition.id === definitionId);
        if (!entry) return catalogChanged;
        setAddEntry(entry);
        addConsent.current = null;
        setAddInstalled(false);
        setAdd({ product, definitionId });
        return null;
      },
    });
  const [accountDefinition, setAccountDefinition] = useState<string | null>(null);
  const [mcpTitle, setMcpTitle] = useState("");
  const attempts = useRef(new Map<string, HostApiCommandInput>());
  /** Something the screen found out in passing, said where the outcome would be. */
  const [note, setNote] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const change = useScreenAction(host, "plugins-change", {
    label: "save the change",
    done: "saved",
    happened: "the change was saved",
    execute: (work: PluginWork) => work.run(),
    // Where the change shows in what the Host reports, reading it again settles it.
    reconcile: async (work) => {
      const settled = (await work.check?.()) ?? null;
      return settled === null
        ? null
        : settled
          ? { kind: "confirmed", value: null }
          : notDone({ label: "save", done: "saved" });
    },
  });
  const pending = change.running;
  const line = settingsFooter(change.line) ?? (note === null ? undefined : { text: note });
  const run = (work: PluginWork) => {
    if (change.running) return;
    setNote(null);
    void change.run(work).then((outcome) => {
      if (outcome.kind === "confirmed" && outcome.value !== null) setNote(outcome.value);
      overview.refresh();
      if (detailTarget) detailRead.refresh();
    });
  };
  const command = (value: HostApiCommandInput, check?: () => Promise<boolean | null>) =>
    run({
      run: async () => {
        const intent = JSON.stringify(
          value.type === "settings.plugin.enabled.set"
            ? { type: value.type, target: value.target }
            : { ...value, idempotencyKey: "" },
        );
        // A change whose answer was lost goes again under its first key, so the Host does it once.
        const submitted = attempts.current.get(intent) ?? value;
        attempts.current.set(intent, submitted);
        try {
          await host.dispatch(submitted);
        } catch (reason) {
          if (settingsMutationRejected(reason)) attempts.current.delete(intent);
          throw reason;
        }
        attempts.current.delete(intent);
        return null;
      },
      ...(check ? { check } : {}),
    });
  /** Whether a plugin's placement now reads as asked. */
  const placedAs = (target: PluginTarget, enabled: boolean) => async () => {
    const rows = unwrapRpcResult(await host.rpc["plugins.overview.get"]({})).rows;
    const row = rows.find(
      (row) =>
        row.target.kind === target.kind && pluginTargetKey(row.target) === pluginTargetKey(target),
    );
    return row === undefined ? null : row.placement.enabled === enabled;
  };
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
    disabled: pending,
  });
  const text = (key: string, label: string): NativeSettingsRow => ({ key, kind: "text", label });
  const toggle = (row: PluginRow): NativeSettingsRow => ({
    key: `${`${row.target.kind}:${pluginTargetKey(row.target)}`}:enabled`,
    kind: "toggle",
    label: row.title,
    value: row.placement.enabled,
    disabled: pending || !row.permissions.canEnable,
    onChange: (enabled) =>
      command(
        {
          type: "settings.plugin.enabled.set",
          target: row.target,
          expectedRevision: row.placement.revision,
          enabled,
          idempotencyKey: mutationIdempotencyKey("settings-plugin-enabled"),
        },
        placedAs(row.target, enabled),
      ),
  });
  const remove = (current: PluginDetailView) =>
    Alert.alert(
      `Remove ${current.row.device?.name ?? current.row.title}?`,
      current.row.device
        ? "Agents can no longer control it. What it saved on its computer, such as a pairing, is deleted."
        : "This removes its access. Saved credentials may be removed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            run({
              run: async () => {
                if (current.row.target.kind === "plugin")
                  await host.dispatch({
                    type: "plugin.remove",
                    pluginId: current.row.target.pluginId,
                    idempotencyKey: mutationIdempotencyKey("plugin-remove"),
                  });
                else
                  for (const installationId of current.installationIds) {
                    await host.dispatch({
                      type: "integration.uninstall",
                      installationId,
                      idempotencyKey: mutationIdempotencyKey("plugin-remove"),
                    });
                  }
                // A device's page was opened from Devices, where it is now gone.
                if (current.row.device && target) navigation.goBack();
                else setDetailTarget(undefined);
                return null;
              },
              check: async () => {
                const rows = unwrapRpcResult(await host.rpc["plugins.overview.get"]({})).rows;
                return !rows.some(
                  (row) =>
                    row.target.kind === current.row.target.kind &&
                    pluginTargetKey(row.target) === pluginTargetKey(current.row.target),
                );
              },
            }),
        },
      ],
    );
  const productRow = (product: PluginCatalogProduct): NativeSettingsRow => ({
    ...button(`product:${product.id}`, product.title, () => openAdd(product)),
    mark: { definitionId: product.id, name: product.title },
  });
  const catalogRows = (): NativeSettingsRow[] => {
    if (!toAdd)
      return directory.status === "failed" || overview.status === "failed"
        ? []
        : placeholders("catalog");
    const own =
      host.getSnapshot().user !== null
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
  if (line) sections.push({ key: "outcome", title: "", rows: [], footer: line });
  const missing = settingsFooter(
    readLine(
      detailTarget ? detailRead : overview,
      detailTarget ? detailRead.refresh : overview.refresh,
    ),
  );
  if (detailTarget && !detail)
    sections.push({
      key: "hero",
      title: "",
      rows: missing ? [] : placeholders("hero"),
      ...(missing ? { footer: missing } : {}),
    });
  if (detail) {
    const row = detail.row;
    const device = row.device ?? null;
    sections.push({
      key: "hero",
      title: device?.name ?? row.title,
      rows: [
        ...(device
          ? []
          : [
              text(
                "source",
                `${row.source.kind}${row.source.version ? ` · ${row.source.version}` : ""}`,
              ),
            ]),
        toggle(row),
      ],
    });
    if (device && row.target.kind === "plugin") {
      const pluginId = row.target.pluginId;
      const setupThreadId = detail.setupThreadId ?? null;
      const setupTitle =
        setupThreadId === null
          ? null
          : (host.getSnapshot().threads.find(({ id }) => id === setupThreadId)?.title ?? "");
      sections.push({
        key: "device",
        title: "Device",
        rows: [
          ...(setupThreadId === null
            ? []
            : [
                button("setup", setupTitle ? `Set up in ${setupTitle}` : "Set up in a task", () =>
                  leave.openThread(setupThreadId),
                ),
              ]),
          button(
            "fix",
            "Fix",
            () => void leave.openNewTask(fixDeviceDraftText({ name: device.name, pluginId })),
          ),
        ],
      });
    }
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
    const secretsMissing = settingsFooter(readLine(secrets, secrets.refresh));
    if (secretsMissing)
      sections.push({ key: "secrets-error", title: "Secrets", rows: [], footer: secretsMissing });
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
      title: "On for your agent",
      rows: [
        {
          key: "enabled",
          kind: "toggle",
          label: "On",
          value: row.placement.enabled,
          disabled: pending || !row.permissions.canPlace,
          onChange: (enabled: boolean) =>
            command(
              {
                type: "settings.plugin.enabled.set",
                target: row.target,
                expectedRevision: row.placement.revision,
                enabled,
                idempotencyKey: mutationIdempotencyKey("settings-plugin-enabled"),
              },
              placedAs(row.target, enabled),
            ),
        } as NativeSettingsRow,
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
  } else if (!detailTarget) {
    if (overview.data === null)
      sections.push({
        key: "plugins-waiting",
        title: "",
        rows: missing ? [] : placeholders("plugins"),
        ...(missing ? { footer: missing } : {}),
      });
    const groups = pluginGroups(pluginsPageRows(overview.data?.rows ?? []), search);
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
                      command(
                        {
                          type: "settings.plugin.enabled.set",
                          target: row.target,
                          expectedRevision: row.placement.revision,
                          enabled: false,
                          idempotencyKey: mutationIdempotencyKey("settings-plugin-off"),
                        },
                        placedAs(row.target, false),
                      ),
                  },
                ]
              : []),
            ...(row.permissions.canRemove
              ? [
                  {
                    label: "Remove",
                    destructive: true,
                    onPress: () =>
                      run({
                        run: async () => {
                          remove(
                            unwrapRpcResult(
                              await host.rpc["plugins.detail.get"]({ target: row.target }),
                            ),
                          );
                          return null;
                        },
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
              : row.placement.enabled
                ? "On"
                : "Off",
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
                run({
                  run: async () => {
                    const pending = unwrapRpcResult(
                      await host.rpc["requests.list"]({}),
                    ).requests.find((item) => item.request.id === request.requestId)?.request;
                    if (
                      !pending ||
                      pending.presentation.kind !== "choice" ||
                      !pending.presentation.options.some((option) => option.id === optionId)
                    )
                      return "Your agent's request changed. Look at it again.";
                    if (optionId !== "declined" && !(await authorizeAiSharing(aiSharing, host)))
                      return null;
                    await host.dispatch({
                      type: "request.respond",
                      requestId: request.requestId,
                      response: { kind: "choice", optionId },
                      idempotencyKey: mutationIdempotencyKey("plugin-request"),
                    });
                    directory.refresh();
                    return null;
                  },
                  check: async () =>
                    !unwrapRpcResult(await host.rpc["requests.list"]({})).requests.some(
                      (item) => item.request.id === request.requestId,
                    ),
                }),
            ),
          ),
        ]),
      });
    const catalogMissing = settingsFooter(readLine(directory, directory.refresh));
    sections.push({
      key: "add-more",
      title: "Add more",
      rows: catalogRows(),
      ...(catalogMissing ? { footer: catalogMissing } : {}),
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
                    change.dismiss();
                    setNote(entered.ok ? "Enter a new value to change." : entered.message);
                    return;
                  }
                  run({
                    run: async () => {
                      await setLocalMcpServerSecrets(host, changingSecrets.id, entered.secrets);
                      setChangingSecrets(null);
                      setSecretValues({});
                      setSecretsSaved(true);
                      return null;
                    },
                  });
                }),
              ],
              ...(line ? { footer: line } : {}),
            },
          ]}
        />
      ) : null}
      <Sheet
        open={accountDefinition !== null}
        title="Accounts and permissions"
        onClose={() => {
          setAccountDefinition(null);
          overview.refresh();
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
              overview.refresh();
              directory.refresh();
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
                            if (!addInstalled && !pending) openAdd(add.product, definitionId);
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
              ...(line ? [{ key: "outcome", title: "", rows: [], footer: line }] : []),
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
                              run({
                                run: async () => {
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
                                  const target: PluginTarget = {
                                    kind: addEntry.definition.computerApp
                                      ? "device-app"
                                      : "service",
                                    definitionId: entry.definitionId,
                                  };
                                  await addPluginService(host, target);
                                  addConsent.current = {
                                    target,
                                    access: "read",
                                    idempotencyKey: mutationIdempotencyKey(
                                      "plugin-add-account-placement",
                                    ),
                                    command: null,
                                  };
                                  setAddInstalled(true);
                                  return null;
                                },
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
                  if (!consent) throw new Error("Review placement again.");
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
                      ...button("install", pending ? "Adding…" : "Add plugin", () =>
                        run({
                          run: async () => {
                            const result = await host.dispatch({
                              type: "plugin.install",
                              input: { directory: folder.trim() },
                              idempotencyKey: mutationIdempotencyKey("plugin-install"),
                            });
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
                            return null;
                          },
                        }),
                      ),
                      disabled: pending || folder.trim() === "",
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
                      ...button("mcp", pending ? "Adding…" : "Add MCP server", () =>
                        run({
                          run: async () => {
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
                            setAddingOwn(false);
                            return null;
                          },
                        }),
                      ),
                      disabled: pending || !mcpTitle.trim() || !mcpUrl.trim(),
                    },
                  ],
                },
            ...(line ? [{ key: "own-outcome", title: "", rows: [], footer: line }] : []),
          ]}
        />
      ) : null}
    </>
  );
}

/**
 * One change on this screen: its work, which may say something it found out
 * on the way (a changed catalog), and how to read whether a lost answer took.
 */
interface PluginWork {
  readonly run: () => Promise<string | null>;
  readonly check?: () => Promise<boolean | null>;
}

const catalogChanged = "The catalog changed. Look at it again.";

function placeholders(section: string): NativeSettingsRow[] {
  return [0, 1, 2].map((index) => ({
    key: `${section}:placeholder:${index}`,
    kind: "placeholder" as const,
    label: "Not loaded yet",
  }));
}
