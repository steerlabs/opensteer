import {
  activatePluginVersion,
  answerPluginScheduledRun,
  configurePluginSchedule,
  pluginAccessChoices,
  pluginAuthorText,
  pluginInputContent,
  pluginInputForm,
  pluginRequirementIssue,
  pluginScheduleText,
  pluginScheduledRunLabel,
  pluginStatusView,
  pluginWebhookSetupCompletion,
  pluginWebhookSetupForm,
  pluginWebhookStatusText,
  pluginWorkflowRunLabel,
  pluginWorkflowRunLive,
  readPlugin,
  readPluginScheduleRuns,
  readPluginWebhookSetup,
  removePlugin,
  removePluginWebhook,
  completePluginWebhookSetup,
  confirmPluginWebhookRemoval,
  setPluginAccess,
  startPluginWorkflow,
  stopPluginWorkflow,
  unlinkPluginAccount,
  type InstalledPluginView,
  type PluginAccess,
} from "@opensteer/client/plugins";
import { usePluginEngine, usePluginWorkflowRuns } from "@opensteer/client/react";
import type { HostClient } from "@opensteer/client/host";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { AppFrame } from "../thread/app-frame.js";
import { Sheet } from "../ui/sheet.js";
import { confirmDestructive } from "./confirm.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { pluginFormRows, type PluginFormAnswers } from "./plugin-form-rows.js";
import { engineSection, pluginTone, usePluginAction } from "./plugins.js";
import { useSettingsRead } from "./use-settings-read.js";

type Workflow = NonNullable<InstalledPluginView["workflows"]>[number];
const when = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** One plugin, the same sections as on a computer, in the phone's settings rows. */
export function PluginDetailScreen({
  route,
}: StaticScreenProps<{ readonly deploymentId: string; readonly pluginId: string }>): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <PluginDetail
      deploymentId={route.params.deploymentId}
      host={host}
      key={route.params.pluginId}
      pluginId={route.params.pluginId}
    />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function PluginDetail(props: { deploymentId: string; host: HostClient; pluginId: string }) {
  const { deploymentId, host, pluginId } = props;
  const navigation = useNavigation();
  const detail = useSettingsRead(host, () => readPlugin(host, pluginId), pluginId);
  const engine = usePluginEngine(host, null);
  const action = usePluginAction(host);
  const [access, setAccess] = useState<PluginAccess | null>(null);
  const [starting, setStarting] = useState<Workflow | null>(null);
  const [pageOpen, setPageOpen] = useState(false);
  const [webhook, setWebhook] = useState<string | null>(null);
  const [all, setAll] = useState<ReadonlySet<string>>(new Set());
  const hasSchedules = (detail.data?.schedules.length ?? 0) > 0;
  // Scheduled runs load only for a plugin with schedules. Workflow runs load
  // beside the detail, since they outlive the declarations it reports.
  const runs = useSettingsRead(
    host,
    async () => (hasSchedules ? readPluginScheduleRuns(host, pluginId) : { runs: [] }),
    `${pluginId}:${hasSchedules}`,
  );
  const workflowRuns = usePluginWorkflowRuns(host, pluginId);
  const preview = <T,>(key: string, items: readonly T[], limit: number) =>
    all.has(key) ? items : items.slice(0, limit);
  const showAll = (key: string, items: readonly unknown[], limit: number, noun: string) =>
    items.length > limit
      ? [
          {
            key: `${key}:all`,
            kind: "button" as const,
            label: all.has(key) ? "Show fewer" : `Show all ${items.length} ${noun}`,
            onPress: () =>
              setAll((shown) => {
                const next = new Set(shown);
                if (!next.delete(key)) next.add(key);
                return next;
              }),
          },
        ]
      : [];
  const data = detail.data;
  if (!data) {
    const notice = engineSection(engine);
    return (
      <NativeSettingsPage
        sections={[
          ...(notice ? [notice] : []),
          {
            key: "loading",
            title: "",
            rows: [
              {
                key: "loading",
                kind: detail.error ? "status" : "text",
                ...(detail.error ? { tone: "bad" as const } : {}),
                label: detail.error ?? "Loading plugin…",
              } as NativeSettingsRow,
            ],
          },
        ]}
      />
    );
  }
  const { plugin } = data;
  const status = pluginStatusView(plugin);
  const active = data.versions.find((version) => version.active);
  const current = action.pending === "access" ? (access ?? plugin.access) : plugin.access;
  const sections: NativeSettingsSection[] = [
    {
      key: "about",
      title: plugin.name,
      rows: [
        {
          key: "status",
          kind: "status",
          tone:
            plugin.status === "not-built"
              ? "bad"
              : status.tone === "attention"
                ? "attention"
                : pluginTone[status.tone],
          label:
            plugin.status === "not-built"
              ? "This plugin has no working version. Ask your agent to fix it, or use an earlier version below."
              : status.tone === "attention"
                ? `Connect an account below before agents can use ${plugin.name}.`
                : status.label,
          detail: [
            pluginAuthorText(plugin.author),
            active?.createdAt ? `version from ${when(active.createdAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        },
        ...(data.page
          ? [
              {
                key: "page",
                kind: "button" as const,
                label: "Open page",
                ...(data.page.unavailable ? { detail: data.page.unavailable } : {}),
                disabled: Boolean(data.page.unavailable) || !data.page.reference,
                opens: true,
                onPress: () => setPageOpen(true),
              },
            ]
          : []),
      ],
      ...(action.error ? { footer: { text: action.error, tone: "danger" as const } } : {}),
    },
    {
      key: "access",
      title: "Agent access",
      rows: [
        {
          key: "access",
          kind: "chips",
          label: "Agents may use",
          value: current,
          choices: pluginAccessChoices,
          onChange: (value) => {
            const next = value as PluginAccess;
            setAccess(next);
            action.run("access", () => setPluginAccess(host, plugin.id, next));
          },
        },
      ],
      footer: { text: pluginAccessChoices.find(({ value }) => value === current)!.detail },
    },
  ];
  if (data.requirements.length)
    sections.push({
      key: "accounts",
      title: "Connected accounts",
      rows: data.requirements.flatMap((requirement): NativeSettingsRow[] => {
        const target = {
          pluginId: plugin.id,
          requirement: requirement.name,
          scope: requirement.scope,
        };
        const issue = pluginRequirementIssue(requirement);
        const connect = () => navigation.navigate("PluginConnect", { deploymentId, ...target });
        return [
          {
            key: `${requirement.scope}:${requirement.name}`,
            kind: "button",
            label: requirement.links.length
              ? issue
                ? `Review ${requirement.providerName}`
                : requirement.cardinality === "many"
                  ? `Add a ${requirement.providerName} account`
                  : `Change ${requirement.providerName} account`
              : `Connect ${requirement.providerName}`,
            detail:
              issue ??
              (requirement.cardinality === "many" ? "Any number of accounts" : "One account"),
            opens: true,
            disabled: !requirement.consent,
            onPress: connect,
          },
          ...requirement.links.map((link) => ({
            key: `${requirement.name}:${link.account.id}`,
            kind: "button" as const,
            label: link.account.label,
            detail: link.current ? "Linked" : "Needs review: the plugin changed what it asks for",
            disabled: action.pending !== null,
            onPress: connect,
            actions: [
              {
                label: "Unlink",
                destructive: true,
                onPress: () =>
                  action.run(`unlink:${link.account.id}`, () =>
                    unlinkPluginAccount(host, target, link.account.id),
                  ),
              },
            ],
          })),
        ];
      }),
    });
  sections.push({
    key: "tools",
    title: data.toolCount ? `Tools · ${data.toolCount}` : "Tools",
    rows:
      data.tools === null
        ? [
            {
              key: "none",
              kind: "text",
              label:
                plugin.status === "not-built"
                  ? "Tools appear once a version builds."
                  : "Tools appear once its accounts are connected.",
            },
          ]
        : data.tools.length === 0
          ? [{ key: "none", kind: "text", label: "This plugin has no tools." }]
          : [
              ...preview("tools", data.tools, 8).map((tool) => ({
                key: tool.name,
                kind: "text" as const,
                label: `${tool.name} · ${tool.readOnly ? "Reads" : "Writes"}`,
                ...(tool.description ? { detail: tool.description } : {}),
              })),
              ...showAll("tools", data.tools, 8, "tools"),
            ],
  });
  if (data.skills?.length)
    sections.push({
      key: "skills",
      title: "Skills",
      rows: [
        ...preview("skills", data.skills, 5).map((skill) => ({
          key: skill.name,
          kind: "text" as const,
          label: skill.name,
          ...(skill.description ? { detail: skill.description } : {}),
        })),
        ...showAll("skills", data.skills, 5, "skills"),
      ],
    });
  if (hasSchedules) {
    const waiting = runs.data?.runs.filter((run) => run.status === "awaiting-approval") ?? [];
    const recent =
      runs.data?.runs.filter((run) => run.status !== "awaiting-approval").slice(0, 5) ?? [];
    sections.push({
      key: "schedules",
      title: "Schedules",
      rows: [
        ...data.schedules.flatMap((schedule): NativeSettingsRow[] => {
          const settings = schedule.settings;
          const enabled = settings?.enabled ?? false;
          return [
            {
              key: schedule.name,
              kind: "toggle",
              label: schedule.name,
              detail: [
                pluginScheduleText(schedule.timing),
                enabled && settings?.nextAt ? `next ${when(settings.nextAt)}` : null,
                settings?.running ? "running now" : null,
              ]
                .filter(Boolean)
                .join(" · "),
              value: enabled,
              disabled: action.pending !== null,
              onChange: (on) =>
                action.run(`schedule:${schedule.name}`, () =>
                  configurePluginSchedule(host, {
                    pluginId: plugin.id,
                    schedule: schedule.name,
                    enabled: on,
                    ...(settings ? { approvalMode: settings.approvalMode } : {}),
                  }),
                ),
            },
            ...(enabled
              ? [
                  {
                    key: `${schedule.name}:mode`,
                    kind: "chips" as const,
                    label: "When it runs",
                    value: settings?.approvalMode ?? "automatic",
                    choices: [
                      { value: "automatic", label: "On its own" },
                      { value: "browser", label: "Ask me" },
                    ],
                    onChange: (value: string) =>
                      action.run(`mode:${schedule.name}`, () =>
                        configurePluginSchedule(host, {
                          pluginId: plugin.id,
                          schedule: schedule.name,
                          enabled: true,
                          approvalMode: value as "automatic" | "browser",
                        }),
                      ),
                  },
                ]
              : []),
          ];
        }),
        ...waiting.flatMap((run): NativeSettingsRow[] => [
          {
            key: `${run.id}:what`,
            kind: "status",
            tone: "attention",
            label: `${run.schedule} is waiting for you${run.expiresAt ? ` until ${when(run.expiresAt)}` : ""}`,
            ...(run.approval
              ? {
                  detail: `It wants to run ${run.approval.tool} with exactly:\n${JSON.stringify(run.approval.arguments, null, 2)}`,
                }
              : {}),
          },
          {
            key: `${run.id}:approve`,
            kind: "button",
            label: "Approve",
            disabled: action.pending !== null,
            onPress: () =>
              action.run(`accept:${run.id}`, () =>
                answerPluginScheduledRun(host, plugin.id, run.id, "accept").then(runs.reload),
              ),
          },
          {
            key: `${run.id}:decline`,
            kind: "button",
            label: "Decline",
            destructive: true,
            disabled: action.pending !== null,
            onPress: () =>
              action.run(`decline:${run.id}`, () =>
                answerPluginScheduledRun(host, plugin.id, run.id, "decline").then(runs.reload),
              ),
          },
        ]),
        ...recent.map((run) => ({
          key: run.id,
          kind: "text" as const,
          label: run.schedule,
          detail: `${pluginScheduledRunLabel(run)}${run.scheduledAt ? ` · ${when(run.scheduledAt)}` : ""}`,
        })),
        ...runReadRows("schedule-runs", runs.error, runs.data !== null, () => void runs.reload()),
      ],
    });
  }
  if (data.workflows?.length || workflowRuns.visible.length || workflowRuns.error)
    sections.push({
      key: "workflows",
      title: "Workflows",
      rows: [
        ...(data.workflows ?? []).map((workflow) => ({
          key: workflow.name,
          kind: "button" as const,
          label: `Start ${workflow.name}`,
          ...(workflow.description ? { detail: workflow.description } : {}),
          opens: true,
          onPress: () => setStarting(workflow),
        })),
        ...workflowRuns.visible.map((run): NativeSettingsRow => {
          const live = pluginWorkflowRunLive(run);
          const stop = () =>
            action.run(`stop:${run.id}`, () =>
              stopPluginWorkflow(host, plugin.id, run.id).then(workflowRuns.retry),
            );
          return {
            key: run.id,
            kind: "button",
            label: run.workflow,
            detail: `${action.pending === `stop:${run.id}` ? "Stopping…" : pluginWorkflowRunLabel(run)} · ${when(run.createdAt)}`,
            disabled: !live || action.pending !== null,
            // A tap on a live run stops it after asking; the swipe action stops it at once.
            onPress: () =>
              confirmDestructive({
                title: `Stop ${run.workflow}?`,
                message: "It stops where it is. Steps it already finished stay done.",
                confirm: "Stop",
                onConfirm: stop,
              }),
            ...(live ? { actions: [{ label: "Stop", destructive: true, onPress: stop }] } : {}),
          };
        }),
        ...(workflowRuns.loaded && workflowRuns.more
          ? [
              {
                key: "runs:more",
                kind: "button" as const,
                label: workflowRuns.loadingMore ? "Loading…" : "Show more runs",
                disabled: workflowRuns.loadingMore,
                onPress: workflowRuns.showMore,
              },
            ]
          : []),
        ...runReadRows(
          "workflow-runs",
          workflowRuns.error,
          workflowRuns.loaded,
          workflowRuns.retry,
        ),
      ],
      ...(data.workflows === null
        ? {
            footer: {
              text:
                plugin.status === "ready"
                  ? "This version's workflows couldn't be read, so none can be started. Runs already under way are listed."
                  : "Workflows can be started once its accounts are connected and a version builds. Runs already under way are listed.",
            },
          }
        : {}),
    });
  if (data.webhooks.length)
    sections.push({
      key: "webhooks",
      title: "Webhooks",
      rows: data.webhooks.map((entry) => ({
        key: entry.id,
        kind: "button",
        label: entry.status === "setup-required" ? `Finish setting up ${entry.name}` : entry.name,
        detail: pluginWebhookStatusText(entry),
        opens: true,
        onPress: () => setWebhook(entry.id),
      })),
      ...(data.webhookUnavailable ? { footer: { text: data.webhookUnavailable } } : {}),
    });
  if (data.versions.length)
    sections.push({
      key: "versions",
      title: "Versions",
      rows: [
        ...preview("versions", data.versions, 5).map((version): NativeSettingsRow => ({
          key: version.id,
          kind: "button" as const,
          label: version.createdAt ? when(version.createdAt) : version.id,
          detail: version.active
            ? `In use · ${pluginAuthorText(version.author)}`
            : pluginAuthorText(version.author),
          disabled: version.active || action.pending !== null,
          onPress: () =>
            Alert.alert(
              "Use this version?",
              `${plugin.name} will run this version's code from now on. Anything it has stored stays as it is: switching back changes code, not data.`,
              [
                { style: "cancel", text: "Cancel" },
                {
                  text: "Use this version",
                  onPress: () =>
                    action.run("activate", () =>
                      activatePluginVersion(host, plugin.id, version.id),
                    ),
                },
              ],
            ),
        })),
        ...showAll("versions", data.versions, 5, "versions"),
      ],
      footer: { text: "Switching versions changes the plugin's code, not the data it has stored." },
    });
  sections.push({
    key: "remove",
    title: "",
    rows: [
      {
        key: "remove",
        kind: "button",
        label: `Remove ${plugin.name}`,
        destructive: true,
        disabled: action.pending !== null,
        onPress: () =>
          confirmDestructive({
            title: `Remove ${plugin.name}?`,
            message: "Its code, versions, schedules and stored data go with it.",
            confirm: "Remove",
            onConfirm: () =>
              action.run("remove", async () => {
                await removePlugin(host, plugin.id);
                navigation.goBack();
              }),
          }),
      },
    ],
    footer: {
      text: "Agents lose its tools. Connected accounts stay saved; remove them in Plugins → Connected accounts.",
    },
  });
  return (
    <>
      <NativeSettingsPage sections={sections} />
      {starting ? (
        <StartWorkflow
          host={host}
          onClose={() => setStarting(null)}
          onStarted={() => {
            setStarting(null);
            workflowRuns.retry();
          }}
          pluginId={plugin.id}
          workflow={starting}
        />
      ) : null}
      {pageOpen && data.page?.reference && !data.page.unavailable ? (
        <Sheet open title={plugin.name} onClose={() => setPageOpen(false)}>
          <AppFrame client={host} appId={data.page.reference.pluginId} kind="plugin" />
        </Sheet>
      ) : null}
      {webhook ? (
        <WebhookSetup
          host={host}
          onClose={() => {
            setWebhook(null);
            void detail.reload();
          }}
          pluginId={plugin.id}
          webhookId={webhook}
        />
      ) : null}
    </>
  );
}

function StartWorkflow(props: {
  host: HostClient;
  onClose: () => void;
  onStarted: () => void;
  pluginId: string;
  workflow: Workflow;
}) {
  const form = pluginInputForm(props.workflow.inputSchema);
  const [answers, setAnswers] = useState<PluginFormAnswers>({});
  const action = usePluginAction(props.host);
  const content = pluginInputContent(form, answers);
  return (
    <NativeSettingsPage
      sheet={{ title: `Start ${props.workflow.name}`, onClose: props.onClose }}
      sections={[
        {
          key: "input",
          title: props.workflow.description ?? "",
          rows: pluginFormRows(form, answers, setAnswers),
          ...(action.error
            ? { footer: { text: action.error, tone: "danger" as const } }
            : "problem" in content && form.unsupported.length
              ? { footer: { text: content.problem } }
              : {}),
        },
        {
          key: "start",
          title: "",
          rows: [
            {
              key: "start",
              kind: "primary",
              label: action.pending ? "Starting…" : "Start",
              disabled: "problem" in content || action.pending !== null,
              onPress: () =>
                "content" in content &&
                action.run("start", () =>
                  startPluginWorkflow(
                    props.host,
                    props.pluginId,
                    props.workflow.name,
                    content.content,
                  ).then(props.onStarted),
                ),
            },
          ],
        },
      ]}
    />
  );
}

/** A run read's state as rows: loading, or a failure with a retry, never an empty list. */
function runReadRows(
  key: string,
  error: unknown,
  loaded: boolean,
  retry: () => void,
): NativeSettingsRow[] {
  if (error)
    return [
      {
        key: `${key}:failed`,
        kind: "status",
        tone: "bad",
        label: "Couldn't read these runs.",
        ...(typeof error === "string"
          ? { detail: error }
          : error instanceof Error
            ? { detail: error.message }
            : {}),
      },
      { key: `${key}:retry`, kind: "button", label: "Try again", onPress: retry },
    ];
  return loaded ? [] : [{ key: `${key}:loading`, kind: "text", label: "Loading runs…" }];
}

function WebhookSetup(props: {
  host: HostClient;
  onClose: () => void;
  pluginId: string;
  webhookId: string;
}) {
  // Re-read on every plugins change; what the person typed lives here, not in the read.
  const setup = useSettingsRead(
    props.host,
    () => readPluginWebhookSetup(props.host, props.pluginId, props.webhookId),
    props.webhookId,
  );
  const action = usePluginAction(props.host);
  const [answers, setAnswers] = useState<PluginFormAnswers>({});
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const data = setup.data;
  const copy = (key: string, value: string) =>
    void Clipboard.setStringAsync(value).then(
      () => setCopied(key),
      () => action.setError("Copy was blocked. Select the text to copy it."),
    );
  const remove = () =>
    confirmDestructive({
      title: "Remove this webhook?",
      message:
        "Events stop reaching this plugin. If the service already has this address, you'll be asked to remove it there too.",
      confirm: "Remove",
      onConfirm: () =>
        action.run("remove", () =>
          removePluginWebhook(props.host, props.pluginId, props.webhookId).then(async () => {
            const next = await readPluginWebhookSetup(
              props.host,
              props.pluginId,
              props.webhookId,
            ).catch(() => null);
            if (next?.step === "remove") await setup.reload();
            else props.onClose();
          }),
        ),
    });
  if (!data)
    return (
      <NativeSettingsPage
        sheet={{ title: "Webhook", onClose: props.onClose }}
        sections={[
          {
            key: "loading",
            title: "",
            rows: [{ key: "loading", kind: "text", label: setup.error ?? "Loading setup…" }],
          },
        ]}
      />
    );
  const form = pluginWebhookSetupForm(data);
  const completion = pluginWebhookSetupCompletion(props.pluginId, data, answers, secret);
  const sections: NativeSettingsSection[] = [
    {
      key: "setup",
      title: "",
      rows: [
        ...(data.unavailable
          ? [
              {
                key: "unavailable",
                kind: "status" as const,
                tone: "attention" as const,
                label: data.unavailable,
              },
            ]
          : []),
        ...(data.step === "done"
          ? [
              {
                key: "done",
                kind: "status" as const,
                tone: "good" as const,
                label: `This webhook is set up. ${pluginWebhookStatusText(data.webhook)}.`,
              },
            ]
          : []),
        ...(data.instructions
          ? [{ key: "how", kind: "text" as const, label: data.instructions }]
          : []),
        ...(data.step !== "done"
          ? [
              {
                key: "url",
                kind: "button" as const,
                label: copied === "url" ? "Address copied" : "Copy the address to give the service",
                detail: data.callbackUrl,
                onPress: () => copy("url", data.callbackUrl),
              },
            ]
          : []),
        ...(form.secret?.kind === "generated"
          ? [
              {
                key: "secret",
                kind: "button" as const,
                label:
                  copied === "secret"
                    ? "Secret copied"
                    : "Copy the signing secret to give the service",
                detail: form.secret.value,
                onPress: () => copy("secret", (form.secret as { value: string }).value),
              },
            ]
          : []),
      ],
      ...(form.secret?.kind === "generated" && data.step === "configure"
        ? { footer: { text: "The secret is shown only until setup is done." } }
        : {}),
    },
  ];
  if (data.step === "configure") {
    const rows: NativeSettingsRow[] = [
      ...(form.secret?.kind === "provider"
        ? [
            {
              key: "provider-secret",
              kind: "input" as const,
              label: "Signing secret from the service",
              secure: true,
              value: secret,
              onChange: setSecret,
            },
          ]
        : []),
      ...pluginFormRows(form.fields, answers, setAnswers),
    ];
    if (rows.length) sections.push({ key: "fields", title: "What the service gave you", rows });
  }
  sections.push({
    key: "actions",
    title: "",
    rows:
      data.step === "configure"
        ? [
            {
              key: "complete",
              kind: "primary",
              label: action.pending === "complete" ? "Finishing…" : "Done",
              disabled: "problem" in completion || action.pending !== null,
              onPress: () =>
                "command" in completion &&
                action.run("complete", () =>
                  completePluginWebhookSetup(props.host, completion.command).then(props.onClose),
                ),
            },
            {
              key: "remove",
              kind: "button",
              label: "Remove webhook",
              destructive: true,
              disabled: action.pending !== null,
              onPress: remove,
            },
          ]
        : data.step === "remove"
          ? [
              {
                key: "confirm",
                kind: "button",
                label: "I've removed it at the service",
                destructive: true,
                disabled: action.pending !== null,
                onPress: () =>
                  action.run("confirm", () =>
                    confirmPluginWebhookRemoval(props.host, props.pluginId, props.webhookId).then(
                      props.onClose,
                    ),
                  ),
              },
            ]
          : [
              {
                key: "remove",
                kind: "button",
                label: "Remove webhook",
                destructive: true,
                disabled: action.pending !== null,
                onPress: remove,
              },
            ],
    ...(action.error
      ? { footer: { text: action.error, tone: "danger" as const } }
      : data.step === "configure" && form.fields.unsupported.length && "problem" in completion
        ? { footer: { text: completion.problem } }
        : {}),
  });
  return (
    <NativeSettingsPage
      sheet={{
        title: data.step === "remove" ? "Remove the webhook" : `Set up ${data.webhook.name}`,
        onClose: props.onClose,
      }}
      sections={sections}
    />
  );
}
