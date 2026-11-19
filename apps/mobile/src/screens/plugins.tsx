import {
  installPlugin,
  pluginAccessChoices,
  pluginCatalogInstalled,
  pluginCatalogListView,
  pluginCatalogReader,
  pluginEngineNotice,
  pluginInstalledGroups,
  pluginInstalledReader,
  agentHomeSkills,
  pluginLocalToolAddress,
  pluginLocalToolDetail,
  pluginLocalToolSource,
  pluginLocalToolSummary,
  pluginStatusView,
  readInstalledPlugins,
  readPluginLocalTool,
  setPluginAccess,
  type PluginCatalogEntryView,
  type PluginLocalToolView,
  type PluginTone,
} from "@opensteer/client/plugins";
import { useDebouncedValue, usePagedList, usePluginEngine } from "@opensteer/client/react";
import {
  isHostRefusal,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import {
  computerAppCatalogMatches,
  computerAppPlatformRequirementLabel,
  type IntegrationDefinitionSummaryView,
} from "@opensteer/client/integrations";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useRef, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { DeviceAppSetupSheet } from "./device-app-setup-sheet.js";
import { clientIssueActions, presentClientIssue } from "@opensteer/client/feedback";
import { settingsFooter, useScreenAction } from "../ui/client-feedback.js";
import type { ActionLineValue } from "../ui/action-line.js";
import { confirm } from "./confirm.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type {
  NativeSettingsRow,
  NativeSettingsSection,
  NativeSettingsTone,
} from "./native-settings-page.types.js";
import { useLocalServerSections } from "./local-server-sections.js";
import { usePluginRead } from "./use-plugin-read.js";

type Params = StaticScreenProps<{ readonly deploymentId: string }>;

export const pluginTone: Record<PluginTone, NativeSettingsTone> = {
  ok: "good",
  attention: "attention",
  muted: "neutral",
  error: "bad",
};

/** Keeps one pending control for a settings section; the shared action owns its outcome. */
export function usePluginAction(
  host: HostClient,
  scope: string,
  label = "change this",
  done = "changed",
) {
  const busy = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useScreenAction(host, `plugin:${scope}`, {
    label,
    done,
    execute: (operation: () => Promise<unknown>) => operation(),
  });
  const run = (key: string, operation: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(key);
    setError(null);
    action.dismiss();
    void action.run(operation).finally(() => {
      busy.current = false;
      setPending(null);
    });
  };
  const line: ActionLineValue | null = error
    ? { key: `plugin:${scope}:validation`, text: error, tone: "danger" }
    : action.line;
  return {
    pending,
    error: line?.text ?? null,
    line,
    footer: settingsFooter(line),
    outcome: action.state.outcome,
    run,
    setError,
  };
}

export function engineSection(
  engine: ReturnType<typeof usePluginEngine>,
): NativeSettingsSection | null {
  const notice = pluginEngineNotice(engine);
  return notice
    ? {
        key: "engine",
        title: "Plugins",
        rows: [
          {
            key: "engine",
            kind: "status",
            tone: notice.tone === "error" ? "bad" : "attention",
            label: notice.text,
            ...(notice.detail ? { detail: notice.detail } : {}),
          },
        ],
      }
    : null;
}

/**
 * Settings → Plugins on a phone. Opening it is one read of the installed list's
 * first page, which also carries the local tools and never waits for the engine;
 * the catalog loads only when opened.
 */
export function PluginsScreen({ route }: Params): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <Plugins deploymentId={route.params.deploymentId} host={host} key={route.params.deploymentId} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function Plugins({ deploymentId, host }: { deploymentId: string; host: HostClient }) {
  const navigation = useNavigation();
  const installed = usePluginRead(
    host,
    () => readInstalledPlugins(host),
    "plugins-installed",
    "plugins",
  );
  const engine = usePluginEngine(host, installed.data?.engine ?? null);
  const [adding, setAdding] = useState(false);
  const cursor = installed.data?.cursor ?? null;
  // Plugins past the first page load only when asked for, from where it ended.
  const [showingMore, setShowingMore] = useState<string | null>(null);
  const more = usePagedList(
    cursor && showingMore === cursor ? pluginInstalledReader(host, cursor) : null,
    `installed-more:${cursor}`,
    host,
  );
  const moreCursor = showingMore === cursor ? more.nextCursor : cursor;
  const sections: NativeSettingsSection[] = [];
  const notice = engineSection(engine);
  if (notice) sections.push(notice);
  if (installed.error && !installed.data)
    sections.push({
      key: "error",
      title: "Plugins",
      rows: [{ key: "error", kind: "status", tone: "bad", label: installed.error }],
    });
  const first = installed.data?.plugins;
  const plugins = first && showingMore === cursor ? [...first, ...more.items] : first;
  if ((!installed.data && !installed.error) || (first === null && engine?.status !== "unavailable"))
    sections.push({
      key: "loading",
      title: "Plugins",
      rows: [{ key: "loading", kind: "text", label: "Loading plugins…" }],
    });
  else if (plugins?.length === 0)
    sections.push({
      key: "empty",
      title: "Plugins",
      rows: [
        {
          key: "empty",
          kind: "text",
          label: "No plugins yet",
          detail: "Add one from the catalog, or ask your agent to build one for you.",
        },
      ],
    });
  for (const group of pluginInstalledGroups(plugins ?? []))
    sections.push({
      key: group.id,
      title: group.title,
      rows: group.plugins.map((plugin) => {
        const status = pluginStatusView(plugin);
        return {
          key: plugin.id,
          kind: "button",
          label: plugin.name,
          detail:
            plugin.author === "agent" ? `${status.label} · Written by an agent` : status.label,
          opens: true,
          mark: {
            definitionId: plugin.slug,
            name: plugin.name,
            plugin: { hostClient: host, iconRef: plugin.iconRef },
          },
          onPress: () => navigation.navigate("PluginDetail", { deploymentId, pluginId: plugin.id }),
        } satisfies NativeSettingsRow;
      }),
    });
  if (plugins?.length && (moreCursor || more.loading))
    sections.push({
      key: "more",
      title: "",
      rows: [
        {
          key: "more",
          kind: "button",
          label: more.loading || more.loadingMore ? "Loading…" : "Show more plugins",
          disabled: more.loading || more.loadingMore,
          onPress: () => (showingMore === cursor ? more.more() : setShowingMore(cursor)),
        },
      ],
      ...(more.error
        ? {
            footer: {
              text: presentClientIssue({ ...more.error, resource: "more plugins" }).title,
              tone: "danger" as const,
            },
          }
        : {}),
    });
  const local = installed.data?.local ?? [];
  if (local.length)
    sections.push({
      key: "local",
      title: "On your devices",
      rows: local.map((tool) => ({
        key: tool.id,
        kind: "button",
        label: tool.title,
        detail: pluginLocalToolDetail(tool),
        opens: true,
        symbol: tool.kind === "device-app" ? "laptopcomputer" : "server.rack",
        onPress: () => navigation.navigate("PluginLocalTool", { deploymentId, id: tool.id }),
      })),
    });
  sections.push({
    key: "add",
    title: "Add more",
    rows: [
      {
        key: "catalog",
        kind: "button",
        label: "Browse the catalog",
        detail: "Hundreds of services, ready to connect",
        opens: true,
        symbol: "magnifyingglass",
        onPress: () => navigation.navigate("PluginCatalog", { deploymentId }),
      },
      {
        key: "address",
        kind: "button",
        label: "Install from an address",
        detail: "An MCP server, OpenAPI document or GraphQL API",
        opens: true,
        symbol: "link",
        onPress: () => setAdding(true),
      },
    ],
  });
  sections.push({
    key: "agent",
    title: "Your agent",
    rows: [
      {
        key: "accounts",
        kind: "button",
        label: "Connected accounts",
        detail: "The sign-ins and keys your plugins use, and removing them",
        opens: true,
        symbol: "key",
        onPress: () => navigation.navigate("PluginAccounts", { deploymentId }),
      },
      {
        key: "skills",
        kind: "button",
        label: "Skills in Agent home",
        detail: "Turn the skills in your agent's folder on or off",
        opens: true,
        symbol: "doc.text",
        onPress: () => navigation.navigate("PluginSkills", { deploymentId }),
      },
    ],
  });
  return (
    <>
      <NativeSettingsPage sections={sections} />
      {adding ? (
        <InstallFromAddress
          host={host}
          onClose={() => setAdding(false)}
          onInstalled={(pluginId) => {
            setAdding(false);
            navigation.navigate("PluginDetail", { deploymentId, pluginId });
          }}
        />
      ) : null}
    </>
  );
}

const addressKinds = [
  { value: "mcp", label: "MCP" },
  { value: "openapi", label: "OpenAPI" },
  { value: "graphql", label: "GraphQL" },
] as const;

function InstallFromAddress(props: {
  host: HostClient;
  onClose: () => void;
  onInstalled: (pluginId: string) => void;
}) {
  const [kind, setKind] = useState<(typeof addressKinds)[number]["value"]>("mcp");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const action = usePluginAction(props.host, "install-folder", "install this plugin", "installed");
  const valid = /^https?:\/\/\S+$/u.test(url.trim()) && name.trim().length > 0;
  return (
    <NativeSettingsPage
      sheet={{ title: "Install from an address", onClose: props.onClose }}
      sections={[
        {
          key: "what",
          title: "What it is",
          rows: [
            {
              key: "kind",
              kind: "chips",
              label: "Kind",
              value: kind,
              choices: addressKinds,
              onChange: (value) => setKind(value as typeof kind),
            },
            { key: "url", kind: "input", label: "Address", value: url, onChange: setUrl },
            {
              key: "name",
              kind: "input",
              label: "What your agents will call it",
              value: name,
              onChange: setName,
            },
          ],
          footer: action.footer ?? {
            text: "Opensteer generates the plugin's code from the address. Nobody reviews that code, so it's listed as written by an agent.",
          },
        },
        {
          key: "install",
          title: "",
          rows: [
            {
              key: "install",
              kind: "primary",
              label: action.pending ? "Installing…" : "Install",
              disabled: !valid || action.pending !== null,
              onPress: () =>
                action.run("install", async () => {
                  const result = await installPlugin(props.host, {
                    kind,
                    url: url.trim(),
                    name: name.trim(),
                  });
                  if (result.status === "installed") props.onInstalled(result.pluginId);
                  else action.setError(`It didn't build: ${result.message}`);
                }),
            },
          ],
        },
      ]}
    />
  );
}

/** The catalog, paged by the Host for one search at a time. */
export function PluginCatalogScreen({ route }: Params): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <Catalog deploymentId={route.params.deploymentId} host={host} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function Catalog({ deploymentId, host }: { deploymentId: string; host: HostClient }) {
  const navigation = useNavigation();
  const [query, setQuery] = useState("");
  // Each pause in typing is one read of the Host, not each keystroke.
  const search = useDebouncedValue(query.trim());
  const installed = usePluginRead(
    host,
    () => readInstalledPlugins(host),
    "plugins-installed",
    "plugins",
  );
  const engine = usePluginEngine(host, installed.data?.engine ?? null);
  const list = usePagedList(pluginCatalogReader(host, search), `catalog:${search}`, host);
  const action = usePluginAction(host, "catalog", "install this plugin", "installed");
  const apps = usePluginRead(
    host,
    () =>
      Promise.all([
        host.rpc["integrations.get"]({}).then(unwrapRpcResult),
        host.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
      ]).then(([dashboard, platform]) => ({
        connections: dashboard.connections,
        definitions: platform.catalog.map(({ definition }) => definition),
      })),
    "device-apps",
    "apps on your devices",
  );
  const deviceApps = apps.data ? computerAppCatalogMatches(apps.data.definitions, search) : [];
  const [settingUp, setSettingUp] = useState<IntegrationDefinitionSummaryView | null>(null);
  const install = (entry: PluginCatalogEntryView) =>
    confirm({
      title: `Install ${entry.name}?`,
      message: `It runs sandboxed with no access to your accounts until you connect one.${
        entry.auth.length
          ? ` It connects with ${entry.auth.map(({ label }) => label.toLocaleLowerCase()).join(" or ")}.`
          : ""
      }`,
      confirm: "Install",
      onConfirm: () =>
        action.run(`install:${entry.id}`, async () => {
          const result = await installPlugin(host, { kind: "catalog", catalogId: entry.id });
          if (result.status === "installed")
            navigation.navigate("PluginDetail", { deploymentId, pluginId: result.pluginId });
          else action.setError(result.message);
        }),
    });
  const sections: NativeSettingsSection[] = [];
  const notice = list.loading ? engineSection(engine) : null;
  if (notice) sections.push(notice);
  if (action.error)
    sections.push({
      key: "error",
      title: "Catalog",
      rows: [{ key: "error", kind: "status", tone: "bad", label: action.error }],
    });
  const devicesFooter = apps.data ? undefined : settingsFooter(apps.line);
  if (deviceApps.length || devicesFooter)
    sections.push({
      key: "devices",
      title: "On your devices",
      rows: deviceApps.map((definition): NativeSettingsRow => ({
        key: definition.id,
        kind: "button",
        label: definition.name,
        detail: [computerAppPlatformRequirementLabel(definition), definition.description]
          .filter(Boolean)
          .join(" · "),
        mark: { definitionId: definition.id, name: definition.name },
        onPress: () => setSettingUp(definition),
      })),
      ...(devicesFooter ? { footer: devicesFooter } : {}),
    });
  const view = pluginCatalogListView(list, search, deviceApps.length);
  // A failed read is said under the list, with Try again; entries already shown stay.
  const issue = view.kind === "failed" ? view : view.kind === "entries" ? view.issue : null;
  sections.push({
    key: "catalog",
    title: search ? `Matching “${search}”` : "Catalog",
    rows:
      view.kind === "loading"
        ? [{ key: "loading", kind: "text", label: "Loading the catalog…" }]
        : view.kind === "failed"
          ? []
          : view.kind === "empty"
            ? view.text
              ? [{ key: "empty", kind: "text", label: view.text }]
              : []
            : [
                ...list.items.map((entry): NativeSettingsRow => {
                  const already = pluginCatalogInstalled(entry, installed.data?.plugins ?? []);
                  return {
                    key: entry.id,
                    kind: "button",
                    label: entry.name,
                    detail: already ? `Installed · ${entry.description}` : entry.description,
                    mark: {
                      definitionId: entry.id,
                      name: entry.name,
                      plugin: { hostClient: host, iconRef: entry.iconRef },
                    },
                    disabled: already || action.pending !== null,
                    onPress: () => install(entry),
                  };
                }),
                ...(list.nextCursor
                  ? [
                      {
                        key: "more",
                        kind: "button" as const,
                        label: list.loadingMore ? "Loading…" : "Show more",
                        disabled: list.loadingMore,
                        onPress: list.more,
                      },
                    ]
                  : []),
              ],
    footer: issue
      ? {
          text: issue.text,
          link: issue.retry ? { label: clientIssueActions.tryAgain, onPress: list.reload } : null,
        }
      : {
          text: "Plugins reviewed for the catalog. Each runs sandboxed until you connect an account.",
        },
  });
  return (
    <>
      <NativeSettingsPage
        search={{
          value: query,
          onChange: setQuery,
          prompt: "Search the catalog",
          title: "Catalog",
        }}
        sections={sections}
      />
      {settingUp && apps.data ? (
        <DeviceAppSetupSheet
          connections={apps.data.connections}
          definition={settingUp}
          deploymentId={deploymentId}
          host={host}
          onClose={() => {
            setSettingUp(null);
            apps.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** A device data app or local server beside plugins: its address, tools and agent access. */
export function PluginLocalToolScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string; readonly id: string }>): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <LocalTool deploymentId={route.params.deploymentId} host={host} id={route.params.id} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function LocalTool({
  deploymentId,
  host,
  id,
}: {
  deploymentId: string;
  host: HostClient;
  id: string;
}) {
  // Its own read: the installed list counts a local tool's tools, this page lists them.
  const read = usePluginRead(
    host,
    () => readPluginLocalTool(host, id),
    `local-tool:${id}`,
    "this tool",
  );
  const action = usePluginAction(host, `local-tool:${id}`, "change access", "changed");
  const [chosen, setChosen] = useState<PluginLocalToolView["access"] | null>(null);
  const tool = read.data;
  if (!tool)
    return (
      <NativeSettingsPage
        sections={[
          {
            key: "gone",
            title: "",
            rows: [
              {
                key: "gone",
                kind: "text",
                label:
                  read.issue?.reason === "not_found"
                    ? "This isn't available to agents anymore."
                    : (read.error ?? "Loading…"),
              },
            ],
          },
        ]}
      />
    );
  return (
    <LocalToolPage
      action={action}
      chosen={chosen}
      deploymentId={deploymentId}
      host={host}
      onChoose={setChosen}
      tool={tool}
    />
  );
}

function LocalToolPage({
  action,
  chosen,
  deploymentId,
  host,
  onChoose,
  tool,
}: {
  action: ReturnType<typeof usePluginAction>;
  chosen: PluginLocalToolView["access"] | null;
  deploymentId: string;
  host: HostClient;
  onChoose: (access: PluginLocalToolView["access"]) => void;
  tool: PluginLocalToolView;
}) {
  const navigation = useNavigation();
  const access = action.pending ? (chosen ?? tool.access) : tool.access;
  const source = pluginLocalToolSource(tool);
  const server = useLocalServerSections({
    host,
    deploymentId,
    by: source?.kind === "local-server" ? { serverId: source.serverId } : null,
    name: tool.title,
    onRemoved: () => navigation.goBack(),
  });
  const computer = tool.computer;
  return (
    <>
      <NativeSettingsPage
        sections={[
          {
            key: "about",
            title: tool.kind === "device-app" ? "Device data app" : "Local server",
            rows: [
              {
                key: "title",
                kind: "text",
                label: tool.title,
                detail: computer ? `On ${computer.name}` : "No computer chosen",
              },
              ...(tool.unavailable
                ? [
                    {
                      key: "unavailable",
                      kind: "status" as const,
                      tone: "attention" as const,
                      label: tool.unavailable,
                    },
                  ]
                : []),
            ],
          },
          {
            key: "access",
            title: "Agent access",
            rows: [
              {
                key: "access",
                kind: "chips",
                label: "Agents may use",
                value: access,
                choices: pluginAccessChoices,
                onChange: (value) => {
                  const next = value as PluginLocalToolView["access"];
                  onChoose(next);
                  action.run("access", () => setPluginAccess(host, tool.id, next));
                },
              },
            ],
            footer: action.footer ?? {
              text: pluginAccessChoices.find(({ value }) => value === access)!.detail,
            },
          },
          {
            key: "tools",
            title: "Tools",
            footer: {
              text: `In a program, agents reach these as ${pluginLocalToolAddress(tool)}.`,
            },
            rows: tool.tools.length
              ? tool.tools.map((entry) => ({
                  key: entry.name,
                  kind: "text" as const,
                  label: entry.name,
                  detail: entry.readOnly ? "Reads" : "Writes",
                }))
              : [{ key: "none", kind: "text", label: pluginLocalToolSummary(tool) }],
          },
          ...server.sections,
          {
            key: "device",
            title: "",
            rows: [
              ...(computer
                ? [
                    {
                      key: "computer",
                      kind: "button" as const,
                      label: tool.kind === "device-app" ? `Manage ${computer.name}` : computer.name,
                      detail:
                        tool.kind === "device-app"
                          ? "What this device lets agents read and change"
                          : "Where it runs, and its launch approvals",
                      opens: true,
                      onPress: () =>
                        navigation.navigate("SettingsDeviceDetail", {
                          deploymentId,
                          machineId: computer.id,
                        }),
                    },
                  ]
                : []),
              ...(source?.kind === "device-app"
                ? [
                    {
                      key: "turn-off",
                      kind: "button" as const,
                      label: computer ? `Turn off on ${computer.name}` : "Turn off",
                      destructive: true,
                      disabled: action.pending !== null,
                      onPress: () =>
                        Alert.alert(
                          `Turn off ${tool.title}?`,
                          "Agents stop using it. You can turn it on again on that device.",
                          [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Turn off",
                              style: "destructive",
                              onPress: () =>
                                action.run("turn-off", async () => {
                                  await host.dispatch({
                                    type: "integration.disconnect",
                                    connectionId: source.connectionId as never,
                                    idempotencyKey: mutationIdempotencyKey(
                                      `integration-disconnect:${source.connectionId}`,
                                    ),
                                  });
                                  navigation.goBack();
                                }),
                            },
                          ],
                        ),
                    },
                  ]
                : []),
            ],
          },
        ]}
      />
      {server.sheet}
    </>
  );
}

/** The skills in the agent home folder on a phone, each with its switch. */
export function PluginSkillsScreen({ route }: Params): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <Skills host={host} key={route.params.deploymentId} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function Skills({ host }: { host: HostClient }) {
  const overview = usePluginRead(
    host,
    () => host.rpc["plugins.overview.get"]({}).then(unwrapRpcResult),
    "agent-home-skills",
    "skills",
  );
  const action = usePluginAction(host, "agent-home-skills", "change this skill", "changed");
  // A lost response may have committed, so a retry repeats the same operation.
  const attempts = useRef(new Map<string, string>());
  const skills = overview.data ? agentHomeSkills(overview.data.rows) : null;
  return (
    <NativeSettingsPage
      sections={[
        {
          key: "skills",
          title: "Skills in Agent home",
          rows: !skills
            ? [
                {
                  key: "loading",
                  kind: "text",
                  label: overview.error ?? "Loading skills…",
                },
              ]
            : skills.length === 0
              ? [
                  {
                    key: "none",
                    kind: "text",
                    label: "No skills yet",
                    detail:
                      "Your agent adds them to its folder when you ask it to remember how to do something.",
                  },
                ]
              : skills.map((skill) => ({
                  key: skill.target.fullName,
                  kind: "toggle" as const,
                  label: skill.title,
                  ...(skill.description ? { detail: skill.description } : {}),
                  value: skill.placement.enabled,
                  disabled: action.pending !== null || !skill.permissions.canEnable,
                  onChange: (enabled: boolean) =>
                    action.run(skill.target.fullName, async () => {
                      const intent = `${skill.target.fullName}:${enabled}`;
                      const key = attempts.current.get(intent) ?? mutationIdempotencyKey("skill");
                      attempts.current.set(intent, key);
                      try {
                        await host.dispatch({
                          type: "settings.plugin.enabled.set",
                          idempotencyKey: key,
                          target: skill.target,
                          expectedRevision: skill.placement.revision,
                          enabled,
                        });
                        attempts.current.delete(intent);
                      } catch (reason) {
                        if (isHostRefusal(reason)) attempts.current.delete(intent);
                        throw reason;
                      } finally {
                        await overview.reload();
                      }
                    }),
                })),
          footer: action.footer ?? {
            text: "Instructions your agent reads from its folder. Off keeps one from your agent.",
          },
        },
      ]}
    />
  );
}
