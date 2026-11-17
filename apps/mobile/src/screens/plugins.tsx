import {
  installPlugin,
  pluginAccessChoices,
  pluginCatalogInstalled,
  pluginCatalogReader,
  pluginEngineNotice,
  pluginInstalledGroups,
  pluginLocalToolAddress,
  pluginLocalToolManage,
  pluginLocalToolStatus,
  pluginLocalToolSummary,
  pluginStatusView,
  readInstalledPlugins,
  setPluginAccess,
  type PluginCatalogEntryView,
  type PluginLocalToolView,
  type PluginTone,
} from "@opensteer/client/plugins";
import { usePagedList, usePluginEngine } from "@opensteer/client/react";
import type { HostClient } from "@opensteer/client/host";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useDeferredValue, useRef, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type {
  NativeSettingsRow,
  NativeSettingsSection,
  NativeSettingsTone,
} from "./native-settings-page.types.js";
import { useSettingsLease, useSettingsRead } from "./use-settings-read.js";

type Params = StaticScreenProps<{ readonly deploymentId: string }>;

export const pluginTone: Record<PluginTone, NativeSettingsTone> = {
  ok: "good",
  attention: "attention",
  muted: "neutral",
  error: "bad",
};

/** One action at a time, its failure kept for the page to say. */
export function usePluginAction(host: HostClient) {
  const isCurrent = useSettingsLease(host);
  const busy = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (key: string, operation: () => Promise<unknown>) => {
    if (busy.current || !isCurrent()) return;
    busy.current = true;
    setPending(key);
    setError(null);
    void operation()
      .catch((reason: unknown) => {
        if (isCurrent()) setError(operationDetail(reason, "That didn't go through. Try again."));
      })
      .finally(() => {
        busy.current = false;
        setPending(null);
      });
  };
  return { pending, error, run, setError };
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
          },
        ],
      }
    : null;
}

/**
 * Settings → Plugins on a phone. Opening it is one read of the installed list,
 * which also carries the local tools; the catalog loads only when opened.
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
  const installed = useSettingsRead(host, () => readInstalledPlugins(host));
  const engine = usePluginEngine(host, installed.data?.engine ?? null);
  const [adding, setAdding] = useState(false);
  const sections: NativeSettingsSection[] = [];
  const notice = engineSection(engine);
  if (notice) sections.push(notice);
  if (installed.error && !installed.data)
    sections.push({
      key: "error",
      title: "Plugins",
      rows: [{ key: "error", kind: "status", tone: "bad", label: installed.error }],
    });
  const plugins = installed.data?.plugins;
  if (!installed.data && !installed.error)
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
          mark: { definitionId: plugin.slug, name: plugin.name },
          onPress: () => navigation.navigate("PluginDetail", { deploymentId, pluginId: plugin.id }),
        } satisfies NativeSettingsRow;
      }),
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
        detail: `${pluginLocalToolStatus(tool).label} · ${pluginLocalToolAddress(tool)}`,
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
      {
        key: "local",
        kind: "button",
        label: "Device apps, local servers and skills",
        detail: "Approvals, launch review and secrets",
        opens: true,
        symbol: "puzzlepiece.extension",
        onPress: () => navigation.navigate("SettingsLocalPlugins", { deploymentId }),
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
  const action = usePluginAction(props.host);
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
          footer: action.error
            ? { text: action.error, tone: "danger" }
            : {
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
  const search = useDeferredValue(query.trim());
  const installed = useSettingsRead(host, () => readInstalledPlugins(host));
  const engine = usePluginEngine(host, installed.data?.engine ?? null);
  const list = usePagedList(pluginCatalogReader(host, search), `catalog:${search}`);
  const action = usePluginAction(host);
  const install = (entry: PluginCatalogEntryView) =>
    Alert.alert(
      `Install ${entry.name}?`,
      `It runs sandboxed with no access to your accounts until you connect one.${
        entry.auth.length
          ? ` It connects with ${entry.auth.map(({ label }) => label.toLocaleLowerCase()).join(" or ")}.`
          : ""
      }`,
      [
        { style: "cancel", text: "Cancel" },
        {
          text: "Install",
          onPress: () =>
            action.run(`install:${entry.id}`, async () => {
              const result = await installPlugin(host, { kind: "catalog", catalogId: entry.id });
              if (result.status === "installed")
                navigation.navigate("PluginDetail", { deploymentId, pluginId: result.pluginId });
              else action.setError(result.message);
            }),
        },
      ],
    );
  const sections: NativeSettingsSection[] = [];
  const notice = list.loading ? engineSection(engine) : null;
  if (notice) sections.push(notice);
  if (action.error || list.error)
    sections.push({
      key: "error",
      title: "Catalog",
      rows: [
        {
          key: "error",
          kind: "status",
          tone: "bad",
          label: action.error ?? operationDetail(list.error, "Couldn't load the catalog."),
        },
      ],
    });
  sections.push({
    key: "catalog",
    title: search ? `Matching “${search}”` : "Catalog",
    rows: list.loading
      ? [{ key: "loading", kind: "text", label: "Loading the catalog…" }]
      : list.items.length === 0
        ? [
            {
              key: "empty",
              kind: "text",
              label: search ? `Nothing matches “${search}”.` : "The catalog is empty.",
            },
          ]
        : [
            ...list.items.map((entry): NativeSettingsRow => {
              const already = pluginCatalogInstalled(entry, installed.data?.plugins ?? []);
              return {
                key: entry.id,
                kind: "button",
                label: entry.name,
                detail: already ? `Installed · ${entry.description}` : entry.description,
                mark: { definitionId: entry.id, name: entry.name },
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
    footer: {
      text: "Plugins reviewed for the catalog. Each runs sandboxed until you connect an account.",
    },
  });
  return (
    <NativeSettingsPage
      search={{ value: query, onChange: setQuery, prompt: "Search the catalog", title: "Catalog" }}
      sections={sections}
    />
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
  const navigation = useNavigation();
  const installed = useSettingsRead(host, () => readInstalledPlugins(host));
  const action = usePluginAction(host);
  const [chosen, setChosen] = useState<PluginLocalToolView["access"] | null>(null);
  const tool = installed.data?.local.find((entry) => entry.id === id) ?? null;
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
                label: installed.data
                  ? "This isn't available to agents anymore."
                  : (installed.error ?? "Loading…"),
              },
            ],
          },
        ]}
      />
    );
  const access = action.pending ? (chosen ?? tool.access) : tool.access;
  const manage = pluginLocalToolManage(tool);
  return (
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
              detail: tool.computer ? `On ${tool.computer.name}` : "No computer chosen",
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
                setChosen(next);
                action.run("access", () => setPluginAccess(host, tool.id, next));
              },
            },
          ],
          footer: action.error
            ? { text: action.error, tone: "danger" }
            : {
                text: `${pluginAccessChoices.find(({ value }) => value === access)!.detail} Agents call it as ${pluginLocalToolAddress(tool)}.`,
              },
        },
        {
          key: "tools",
          title: "Tools",
          rows: tool.tools.length
            ? tool.tools.map((entry) => ({
                key: entry.name,
                kind: "text" as const,
                label: entry.name,
                detail: entry.readOnly ? "Reads" : "Writes",
              }))
            : [{ key: "none", kind: "text", label: pluginLocalToolSummary(tool) }],
        },
        {
          key: "manage",
          title: "",
          rows: [
            {
              key: "manage",
              kind: "button",
              label: manage.label,
              opens: true,
              onPress: () =>
                manage.kind === "device"
                  ? navigation.navigate("SettingsDeviceDetail", {
                      deploymentId,
                      machineId: manage.runnerId,
                    })
                  : navigation.navigate("SettingsLocalPlugins", { deploymentId }),
            },
          ],
        },
      ]}
    />
  );
}
