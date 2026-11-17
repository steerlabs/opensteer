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
  pluginWorkflowRunLabel,
  pluginWorkflowRunLive,
  readPlugin,
  readPluginScheduleRuns,
  readPluginWebhookSetup,
  readPluginWorkflowRuns,
  removePlugin,
  removePluginWebhook,
  confirmPluginWebhookRemoval,
  setPluginAccess,
  startPluginWorkflow,
  stopPluginWorkflow,
  unlinkPluginAccount,
  type InstalledPluginView,
  type PluginAccess,
} from "@opensteer/client/plugins";
import { usePluginEngine } from "@opensteer/client/react";
import type { HostClient } from "@opensteer/client/host";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
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
  const hasSchedules = (detail.data?.schedules.length ?? 0) > 0;
  const hasWorkflows = (detail.data?.workflows?.length ?? 0) > 0;
  // Runs load only for a plugin that has them, so opening most plugins is one read.
  const runs = useSettingsRead(
    host,
    async () => (hasSchedules ? readPluginScheduleRuns(host, pluginId) : { runs: [] }),
    `${pluginId}:${hasSchedules}`,
  );
  const workflowRuns = useSettingsRead(
    host,
    async () =>
      hasWorkflows ? readPluginWorkflowRuns(host, pluginId) : { runs: [], cursor: null },
    `${pluginId}:${hasWorkflows}`,
  );
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
          : data.tools.map((tool) => ({
              key: tool.name,
              kind: "text" as const,
              label: `${tool.name} · ${tool.readOnly ? "Reads" : "Writes"}`,
              ...(tool.description ? { detail: tool.description } : {}),
            })),
    collapsed: (data.tools?.length ?? 0) > 8,
  });
  if (data.skills?.length)
    sections.push({
      key: "skills",
      title: "Skills",
      rows: data.skills.map((skill) => ({
        key: skill.name,
        kind: "text",
        label: skill.name,
        ...(skill.description ? { detail: skill.description } : {}),
      })),
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
      ],
    });
  }
  if (hasWorkflows)
    sections.push({
      key: "workflows",
      title: "Workflows",
      rows: [
        ...data.workflows!.map((workflow) => ({
          key: workflow.name,
          kind: "button" as const,
          label: `Start ${workflow.name}`,
          ...(workflow.description ? { detail: workflow.description } : {}),
          opens: true,
          onPress: () => setStarting(workflow),
        })),
        ...(workflowRuns.data?.runs.slice(0, 6) ?? []).map((run): NativeSettingsRow => ({
          key: run.id,
          kind: "button",
          label: run.workflow,
          detail: `${pluginWorkflowRunLabel(run)} · ${when(run.createdAt)}`,
          disabled: !pluginWorkflowRunLive(run) || action.pending !== null,
          onPress: () => undefined,
          ...(pluginWorkflowRunLive(run)
            ? {
                actions: [
                  {
                    label: "Stop",
                    destructive: true,
                    onPress: () =>
                      action.run(`stop:${run.id}`, () =>
                        stopPluginWorkflow(host, plugin.id, run.id).then(workflowRuns.reload),
                      ),
                  },
                ],
              }
            : {}),
        })),
      ],
    });
  if (data.webhooks.length)
    sections.push({
      key: "webhooks",
      title: "Webhooks",
      rows: data.webhooks.map((entry) => ({
        key: entry.id,
        kind: "button",
        label: entry.name,
        detail: entry.failure
          ? `Couldn't ${entry.failure === "register" ? "register with" : "unregister from"} the service`
          : entry.status === "active"
            ? "Receiving events"
            : entry.status === "setup-required"
              ? "Needs setup at the service"
              : entry.status === "pending"
                ? "Setting up"
                : entry.status === "stopping"
                  ? "Stopping"
                  : "Stopped",
        opens: true,
        onPress: () => setWebhook(entry.id),
      })),
      ...(data.webhookUnavailable ? { footer: { text: data.webhookUnavailable } } : {}),
    });
  if (data.versions.length)
    sections.push({
      key: "versions",
      title: "Versions",
      rows: data.versions.map((version) => ({
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
                  action.run("activate", () => activatePluginVersion(host, plugin.id, version.id)),
              },
            ],
          ),
      })),
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
    footer: { text: "Agents lose its tools. Connected accounts stay saved for other plugins." },
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
            void workflowRuns.reload();
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

function WebhookSetup(props: {
  host: HostClient;
  onClose: () => void;
  pluginId: string;
  webhookId: string;
}) {
  const setup = useSettingsRead(
    props.host,
    () => readPluginWebhookSetup(props.host, props.pluginId, props.webhookId),
    props.webhookId,
  );
  const action = usePluginAction(props.host);
  return (
    <NativeSettingsPage
      sheet={{
        title: setup.data?.step === "remove" ? "Remove the webhook" : "Webhook",
        onClose: props.onClose,
      }}
      sections={[
        {
          key: "setup",
          title: "",
          rows: setup.data
            ? [
                ...(setup.data.unavailable
                  ? [{ key: "unavailable", kind: "text" as const, label: setup.data.unavailable }]
                  : []),
                ...(setup.data.instructions
                  ? [{ key: "how", kind: "text" as const, label: setup.data.instructions }]
                  : []),
                {
                  key: "url",
                  kind: "status",
                  tone: "neutral",
                  label: "Address to give the service",
                  detail: setup.data.callbackUrl,
                },
                ...(setup.data.signingSecret
                  ? [
                      {
                        key: "secret",
                        kind: "status" as const,
                        tone: "neutral" as const,
                        label: "Signing secret",
                        detail: setup.data.signingSecret,
                      },
                    ]
                  : []),
                {
                  key: "remove",
                  kind: "button",
                  label:
                    setup.data.step === "remove"
                      ? "I've removed it at the service"
                      : "Remove webhook",
                  destructive: true,
                  disabled: action.pending !== null,
                  onPress: () => {
                    if (setup.data?.step === "remove")
                      action.run("confirm", () =>
                        confirmPluginWebhookRemoval(
                          props.host,
                          props.pluginId,
                          props.webhookId,
                        ).then(props.onClose),
                      );
                    else
                      action.run("remove", () =>
                        removePluginWebhook(props.host, props.pluginId, props.webhookId).then(
                          async () => {
                            const next = await readPluginWebhookSetup(
                              props.host,
                              props.pluginId,
                              props.webhookId,
                            );
                            if (next.step === "done") props.onClose();
                            else await setup.reload();
                          },
                        ),
                      );
                  },
                },
              ]
            : [{ key: "loading", kind: "text", label: setup.error ?? "Loading setup…" }],
          ...(action.error ? { footer: { text: action.error, tone: "danger" as const } } : {}),
        },
      ]}
    />
  );
}
