import {
  accessModeOptions,
  agentWords,
  connectionModeDescriptions,
  draftAppsSummary,
  draftBrowserSummary,
  draftHas,
  draftNewProfileHome,
  draftPluginAccess,
  draftPluginsSummary,
  draftSharedProfiles,
  setDraftPluginAccess,
  toggleDraftResource,
  type AgentGrantDraft,
  type AppOption,
  type BrowserOptions,
  type PluginChoice,
  type PluginOption,
  type PluginOptions,
} from "@opensteer/client/host";
import type { AgentOptionsRead } from "@opensteer/client/react";
import type { ThreadAccessMode } from "@opensteer/core";
import type {
  NativeSettingsFooter,
  NativeSettingsRow,
  NativeSettingsSection,
} from "./native-settings-page.types.js";

/**
 * What a connected agent can use, as native Settings sections. Consent and an agent's
 * page draw the same rows; each list opens as a sheet over them, and its apps and
 * plugins are read only when that sheet opens.
 */
export type AgentGrantSheet = "browser" | "apps" | "plugins";

export interface AgentGrantContext {
  readonly agent: string;
  readonly home: string;
  readonly browser: BrowserOptions;
  readonly apps: AgentOptionsRead<readonly AppOption[]>;
  readonly plugins: AgentOptionsRead<PluginOptions>;
  readonly disabled: boolean;
}

export function agentGrantSections(
  context: AgentGrantContext & {
    readonly draft: AgentGrantDraft;
    readonly mode: ThreadAccessMode;
    readonly onScope: (scope: AgentGrantDraft["scope"]) => void;
    readonly onOpen: (sheet: AgentGrantSheet) => void;
    readonly onTasks: (on: boolean) => void;
  },
): readonly NativeSettingsSection[] {
  const { agent, draft, disabled } = context;
  const scope: NativeSettingsSection = {
    key: "scope",
    title: agentWords("consent.scope.title"),
    rows: [
      {
        key: "selected",
        kind: "choice",
        label: agentWords("consent.scope.selected.label"),
        detail: agentWords("consent.scope.selected.detail"),
        selected: draft.scope === "selected",
        disabled,
        onPress: () => context.onScope("selected"),
      },
      {
        key: "everything",
        kind: "choice",
        label: agentWords("consent.scope.everything.label"),
        detail: agentWords("consent.scope.everything.detail"),
        selected: draft.scope === "everything",
        disabled,
        onPress: () => context.onScope("everything"),
      },
    ],
    ...(draft.scope === "everything" && context.mode !== "full-access"
      ? { footer: { text: agentWords("consent.scope.everything.settingsNote") } }
      : {}),
  };
  if (draft.scope === "everything") return [scope];
  const names = { profiles: context.browser.profiles.map(({ id, name }) => ({ id, name })) };
  const shared = draftSharedProfiles(draft, names);
  const offline = draftNewProfileHome(draft, context.browser);
  const resourcesFooter: NativeSettingsFooter | null =
    shared.length > 0
      ? { text: agentWords("consent.browser.shareWarning", { agent, profile: shared.join(", ") }) }
      : draft.newProfile && offline && !offline.online
        ? { text: agentWords("consent.edge.noDeviceOnline", { agent, device: offline.name }) }
        : draft.tasks || draft.resources.length > 0 || draft.newProfile
          ? null
          : { text: agentWords("consent.scope.nothingChosen", { agent }) };
  return [
    scope,
    {
      key: "resources",
      title: "",
      rows: [
        {
          key: "browser",
          kind: "button",
          label: agentWords("consent.browser.title"),
          detail: draftBrowserSummary(draft, context.browser),
          symbol: "globe",
          opens: true,
          disabled,
          onPress: () => context.onOpen("browser"),
        },
        {
          key: "apps",
          kind: "button",
          label: agentWords("consent.apps.title"),
          detail: draftAppsSummary(
            draft,
            context.apps.status === "ready" ? context.apps.data : null,
          ),
          symbol: "rectangle.on.rectangle",
          opens: true,
          disabled,
          onPress: () => context.onOpen("apps"),
        },
        {
          key: "plugins",
          kind: "button",
          label: agentWords("consent.plugins.title"),
          detail: draftPluginsSummary(
            draft,
            context.plugins.status === "ready" ? context.plugins.data.options : null,
          ),
          symbol: "puzzlepiece.extension",
          opens: true,
          disabled,
          onPress: () => context.onOpen("plugins"),
        },
      ],
      ...(resourcesFooter ? { footer: resourcesFooter } : {}),
    },
    {
      key: "tasks",
      title: "",
      rows: [
        {
          key: "tasks",
          kind: "toggle",
          label: agentWords("consent.tasks.title"),
          detail: agentWords("consent.tasks.detail", { agent, home: context.home }),
          value: draft.tasks,
          disabled,
          onChange: context.onTasks,
        },
      ],
      ...(draft.tasks
        ? {
            footer: {
              text: agentWords("consent.tasks.warning", { home: context.home }),
              tone: "danger" as const,
            },
          }
        : {}),
    },
  ];
}

/** The four safety modes, in the words a connection's mode is chosen by. */
export function agentModeSection(props: {
  readonly mode: ThreadAccessMode;
  readonly disabled: boolean;
  readonly onMode: (mode: ThreadAccessMode) => void;
}): NativeSettingsSection {
  return {
    key: "mode",
    title: agentWords("consent.safety.title"),
    rows: accessModeOptions.map((option): NativeSettingsRow => ({
      key: option.mode,
      kind: "choice",
      label: option.label,
      detail: connectionModeDescriptions[option.mode],
      selected: props.mode === option.mode,
      disabled: props.disabled,
      onPress: () => props.onMode(option.mode),
    })),
  };
}

export const agentGrantSheetTitle: Readonly<Record<AgentGrantSheet, string>> = {
  browser: agentWords("consent.browser.title"),
  apps: agentWords("consent.apps.title"),
  plugins: agentWords("consent.plugins.title"),
};

/** One sheet's lists, from the draft it edits. */
export function agentGrantSheetSections(
  sheet: AgentGrantSheet,
  context: AgentGrantContext & {
    readonly draft: AgentGrantDraft;
    readonly onChange: (draft: AgentGrantDraft) => void;
    readonly onOpenDevices: () => void;
  },
): readonly NativeSettingsSection[] {
  if (sheet === "browser") return browserSections(context);
  if (sheet === "apps")
    return readSections(context.apps, "apps", (options) =>
      options.length === 0
        ? emptySections(
            "apps",
            agentWords("consent.edge.noApps.title"),
            agentWords("consent.edge.noApps.detail"),
            context.onOpenDevices,
          )
        : [
            {
              key: "apps",
              title: "",
              rows: options.map((option): NativeSettingsRow => ({
                key: option.key,
                kind: "toggle",
                label: option.name,
                ...(option.detail ? { detail: option.detail } : {}),
                value: draftHas(context.draft, option.resource),
                disabled: context.disabled,
                onChange: (on) =>
                  context.onChange(toggleDraftResource(context.draft, option.resource, on)),
              })),
              footer: { text: agentWords("consent.apps.footer", { agent: context.agent }) },
            },
          ],
    );
  return readSections(context.plugins, "plugins", ({ options, more }) =>
    options.length === 0
      ? emptySections("plugins", agentWords("consent.edge.noPlugins"), null, null)
      : [
          {
            key: "plugins",
            title: "",
            rows: options.map((option) => pluginRow(option, context)),
            footer: {
              text: `${agentWords("consent.plugins.footer", { agent: context.agent })}${
                more ? ` ${agentWords("consent.plugins.more")}` : ""
              }`,
            },
          },
        ],
  );
}

function browserSections(
  context: AgentGrantContext & {
    readonly draft: AgentGrantDraft;
    readonly onChange: (draft: AgentGrantDraft) => void;
    readonly onOpenDevices: () => void;
  },
): readonly NativeSettingsSection[] {
  const { browser, draft, disabled, agent } = context;
  const homes = browser.homes;
  const canCreate = homes === null || homes.length > 0;
  const home = draft.newProfile?.homeRunnerId ?? browser.defaultHome;
  const newRows: NativeSettingsRow[] = canCreate
    ? [
        {
          key: "new",
          kind: "choice",
          multiple: true,
          label: `${agentWords("consent.browser.newProfile")} · ${agentWords("consent.browser.newProfile.badge")}`,
          detail: agentWords("consent.browser.newProfile.detail", { agent }),
          selected: draft.newProfile !== null,
          disabled,
          onPress: () =>
            context.onChange({
              ...draft,
              newProfile: draft.newProfile ? null : { homeRunnerId: browser.defaultHome },
            }),
        },
        ...(draft.newProfile !== null && homes && homes.length > 1 && home
          ? [
              {
                key: "keep-on",
                kind: "chips" as const,
                label: agentWords("consent.browser.keepOn"),
                value: home,
                menu: true,
                choices: homes.map((option) => ({ value: option.runnerId, label: option.name })),
                onChange: (homeRunnerId: string) =>
                  context.onChange({ ...draft, newProfile: { homeRunnerId } }),
              },
            ]
          : []),
      ]
    : [
        { key: "no-browser", kind: "text", label: agentWords("consent.edge.noBrowser.title") },
        {
          key: "devices",
          kind: "button",
          label: agentWords("consent.edge.openDevices"),
          onPress: context.onOpenDevices,
        },
      ];
  return [
    { key: "new", title: "", rows: newRows },
    ...(browser.profiles.length
      ? [
          {
            key: "profiles",
            title: "",
            rows: browser.profiles.map((profile): NativeSettingsRow => ({
              key: profile.id,
              kind: "choice",
              multiple: true,
              label: profile.name,
              detail: profile.detail,
              selected: draftHas(draft, profile.resource),
              disabled,
              onPress: () =>
                context.onChange(
                  toggleDraftResource(draft, profile.resource, !draftHas(draft, profile.resource)),
                ),
            })),
            footer: { text: agentWords("consent.browser.pickerFooter", { agent }) },
          },
        ]
      : []),
  ];
}

function pluginRow(
  option: PluginOption,
  context: {
    readonly draft: AgentGrantDraft;
    readonly disabled: boolean;
    readonly onChange: (draft: AgentGrantDraft) => void;
  },
): NativeSettingsRow {
  const value = draftPluginAccess(context.draft, option.target);
  return {
    key: option.key,
    kind: "chips",
    label: option.detail ? `${option.name} · ${option.detail}` : option.name,
    menu: true,
    value: option.writable || value !== "read-write" ? value : "read",
    choices: [
      { value: "off", label: agentWords("consent.plugins.off") },
      { value: "read", label: agentWords("consent.plugins.read") },
      ...(option.writable
        ? [{ value: "read-write", label: agentWords("consent.plugins.readWrite") }]
        : []),
    ],
    onChange: (access) =>
      context.onChange(setDraftPluginAccess(context.draft, option.target, access as PluginChoice)),
  };
}

function readSections<T>(
  read: AgentOptionsRead<T>,
  key: string,
  ready: (data: T) => readonly NativeSettingsSection[],
): readonly NativeSettingsSection[] {
  if (read.status === "ready") return ready(read.data);
  if (read.status === "failed")
    return [
      {
        key,
        title: "",
        rows: [],
        footer: {
          text: read.error,
          tone: "danger",
          link: { label: agentWords("common.tryAgain"), onPress: read.retry },
        },
      },
    ];
  return [
    {
      key,
      title: "",
      rows: [0, 1, 2].map((index) => ({
        key: `placeholder-${index}`,
        kind: "placeholder" as const,
        label: agentWords("common.loading"),
      })),
    },
  ];
}

function emptySections(
  key: string,
  title: string,
  detail: string | null,
  onOpenDevices: (() => void) | null,
): readonly NativeSettingsSection[] {
  return [
    {
      key,
      title: "",
      rows: [
        { key: "empty", kind: "text", label: title, ...(detail ? { detail } : {}) },
        ...(onOpenDevices
          ? [
              {
                key: "devices",
                kind: "button" as const,
                label: agentWords("consent.edge.openDevices"),
                onPress: onOpenDevices,
              },
            ]
          : []),
      ],
    },
  ];
}
