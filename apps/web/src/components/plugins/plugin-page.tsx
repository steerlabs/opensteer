import { act, failureWords, readWords } from "../use-action.js";
import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  pluginEmptyToolsText,
  activatePluginVersion,
  answerPluginScheduledRun,
  configurePluginSchedule,
  pluginAccessChoices,
  pluginAuthorText,
  pluginBackgroundNotice,
  pluginEngineRefusal,
  pluginInputContent,
  pluginInputForm,
  pluginRequirementIssue,
  pluginScheduleSkipped,
  pluginScheduleText,
  pluginScheduledRunLabel,
  pluginStatusView,
  pluginWebhookSetupCompletion,
  pluginWebhookSetupForm,
  pluginWebhookStatusText,
  pluginWorkflowRunLabel,
  pluginWorkflowRunLive,
  pluginSkillsReader,
  pluginToolsReader,
  pluginVersionsReader,
  readPlugin,
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
  type PluginRequirementTarget,
} from "@opensteer/client/plugins";
import {
  useAppView,
  usePluginScheduleRuns,
  usePluginSection,
  usePluginWorkflowRuns,
} from "@opensteer/client/react";
import { AppFrame, AppLoading, AppLoadFailure, useAppTheme } from "../apps/app-frame.js";
import { useShell } from "../app-shell.js";
import { CopyBlock } from "../copy-block.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { IntegrationIcon } from "../integration-icon.js";
import { LoadingRows } from "../loading-rows.js";
import {
  SectionHeader,
  SettingsError,
  SettingsRow,
  SettingsSegmented,
  SettingsSwitch,
  formatWhen,
} from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { PluginConnectDialog } from "./plugin-connect.js";
import { PluginFormFields } from "./plugin-form-fields.js";
import { EngineNotice, pluginAccountsPath, pluginsPath, usePluginEngine } from "./plugins-area.js";

/** Runs a person's action once at a time, with its failure shown where they acted. */
function usePluginAction() {
  const { hostClient } = useShell();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (key: string, action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    void act(hostClient, { label: "change this", done: "changed" }, action)
      .catch((reason: unknown) => setError(failureWords(reason)))
      .finally(() => setPending(null));
  };
  return { pending, error, run };
}

export function PluginPage({ pluginId }: { readonly pluginId: string }) {
  const { hostClient } = useShell();
  const detail = useSettingsRead(
    () => readPlugin(hostClient, pluginId),
    `plugin:${pluginId}`,
    false,
    {
      pluginId,
      categories: ["schedules", "webhooks", "webhookSources"],
    },
  );
  const scheduled = usePluginScheduleRuns(hostClient, pluginId);
  const runs = usePluginWorkflowRuns(hostClient, pluginId);
  const data = detail.data;
  const schedules =
    data?.schedules.length ||
    scheduled.pending.length ||
    scheduled.recent.length ||
    scheduled.error ? (
      <SchedulesSection pluginId={pluginId} data={data} runs={scheduled} />
    ) : null;
  const refused = data ? null : pluginEngineRefusal(detail.issue);
  const engine = usePluginEngine(refused);
  return (
    <div className="plugins-area plugin-page">
      <Link className="plugins-back" to={pluginsPath}>
        <Icon name="arrow-left" />
        Plugins
      </Link>
      <EngineNotice engine={data ? null : engine} />
      <SettingsError message={!refused ? detail.error : null} />
      {data ? (
        <PluginContent data={data} reload={detail.reload} runs={runs} schedules={schedules} />
      ) : detail.error ? (
        <button className="btn" onClick={detail.reload} type="button">
          Try again
        </button>
      ) : (
        <LoadingRows label="Loading plugin" rows={4} />
      )}
      {!data && schedules}
    </div>
  );
}

type WorkflowRuns = ReturnType<typeof usePluginWorkflowRuns>;

function PluginContent({
  data,
  reload,
  runs,
  schedules,
}: {
  readonly data: InstalledPluginView;
  readonly reload: () => void;
  readonly runs: WorkflowRuns;
  readonly schedules: React.ReactNode;
}) {
  const { plugin } = data;
  const status = pluginStatusView(plugin);
  const active = data.versions.find((version) => version.active);
  const [pageOpen, setPageOpen] = useState(false);
  return (
    <>
      <div className="settings-add-hero">
        <IntegrationIcon
          icon={plugin.icon ?? undefined}
          id={plugin.slug}
          name={plugin.name}
          size="lg"
        />
        <SectionHeader
          title={plugin.name}
          lead={[
            pluginAuthorText(plugin.author),
            active?.createdAt ? `version from ${formatWhen(active.createdAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      </div>
      {plugin.updating ? (
        <p className="notice" role="status">
          Updating for this version of Opensteer. Agents can use it again when it finishes.{" "}
          {plugin.updating.reason}
        </p>
      ) : plugin.status === "not-built" ? (
        <>
          <p className="notice notice--error" role="status">
            This plugin has no working version. Its last build failed, so agents can't use it. Ask
            your agent to fix it, or roll back to an earlier version below.
          </p>
          {plugin.buildFailure ? (
            <pre className="plugin-arguments" tabIndex={0}>
              {plugin.buildFailure}
            </pre>
          ) : null}
        </>
      ) : status.tone === "attention" ? (
        <p className="notice notice--warn" role="status">
          Connect an account below before agents can use {plugin.name}.
        </p>
      ) : null}
      {pluginBackgroundNotice(data) ? (
        <p className="notice notice--warn" role="status">
          {pluginBackgroundNotice(data)}
        </p>
      ) : null}
      {data.importWarnings?.length ? (
        <section className="notice notice--warn" aria-label="Operations left out">
          <p>Some operations were left out of this import.</p>
          <ul>
            {data.importWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.page ? (
        <div className="plugin-page__open">
          <button
            className="btn"
            disabled={Boolean(data.page.unavailable)}
            onClick={() => setPageOpen(true)}
            type="button"
          >
            <Icon name="globe" />
            Open page
          </button>
          {data.page.unavailable ? (
            <span className="settings-footnote">{data.page.unavailable}</span>
          ) : null}
        </div>
      ) : null}
      {pageOpen && data.page && !data.page.unavailable ? (
        <PluginPageView
          pluginId={data.page.reference.pluginId}
          title={plugin.name}
          onClose={() => setPageOpen(false)}
        />
      ) : null}
      <AccessSection data={data} />
      <AccountsSection data={data} reload={reload} />
      <ToolsSection data={data} />
      {schedules}
      {data.workflows?.length || runs.visible.length || runs.error ? (
        <WorkflowsSection data={data} runs={runs} />
      ) : null}
      {data.webhooks.length ? <WebhooksSection data={data} reload={reload} /> : null}
      <VersionsSection data={data} />
      <RemoveSection data={data} />
    </>
  );
}

function PluginPageView({
  pluginId,
  title,
  onClose,
}: {
  readonly pluginId: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const { hostClient } = useShell();
  const theme = useAppTheme();
  const { view, failed, retry } = useAppView(hostClient, pluginId, theme, true, "plugin");
  return (
    <Dialog title={title} wide onClose={onClose}>
      {view ? (
        <AppFrame title={title} url={view.url} theme={theme} retry={retry} />
      ) : failed ? (
        <AppLoadFailure retry={retry} />
      ) : (
        <AppLoading />
      )}
    </Dialog>
  );
}

function AccessSection({ data }: { readonly data: InstalledPluginView }) {
  const { hostClient } = useShell();
  const action = usePluginAction();
  const [chosen, setChosen] = useState(data.plugin.access);
  const current = action.pending ? chosen : data.plugin.access;
  const choice = pluginAccessChoices.find(({ value }) => value === current)!;
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Agent access</h2>
      <div className="card plugin-page__access">
        <SettingsSegmented
          disabled={action.pending !== null}
          label="Agent access"
          onChange={(access) => {
            setChosen(access);
            action.run("access", () => setPluginAccess(hostClient, data.plugin.id, access));
          }}
          options={pluginAccessChoices}
          value={current}
        />
        <p className="settings-footnote">{choice.detail}</p>
        <SettingsError message={action.error} />
      </div>
    </section>
  );
}

function AccountsSection({
  data,
  reload,
}: {
  readonly data: InstalledPluginView;
  readonly reload: () => void;
}) {
  const { hostClient } = useShell();
  const action = usePluginAction();
  const [connecting, setConnecting] = useState<PluginRequirementTarget | null>(null);
  if (!data.requirements.length) return null;
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Connected accounts</h2>
      <div className="card">
        {data.requirements.map((requirement) => {
          const target = {
            pluginId: data.plugin.id,
            requirement: requirement.name,
            scope: requirement.scope,
          };
          const issue = pluginRequirementIssue(requirement);
          return (
            <div className="plugin-requirement" key={`${requirement.scope}:${requirement.name}`}>
              <SettingsRow
                title={requirement.providerName}
                detail={
                  issue ??
                  (requirement.cardinality === "many" ? "Any number of accounts" : "One account")
                }
                action={
                  requirement.links.length === 0 || requirement.cardinality === "many" || issue ? (
                    <button
                      className={`btn btn--small${issue ? " btn--primary" : ""}`}
                      disabled={!requirement.consent}
                      onClick={() => setConnecting(target)}
                      type="button"
                    >
                      {requirement.links.length ? (issue ? "Review" : "Add") : "Connect"}
                    </button>
                  ) : (
                    <button
                      className="btn btn--small"
                      onClick={() => setConnecting(target)}
                      type="button"
                    >
                      Change
                    </button>
                  )
                }
              />
              {requirement.links.map((link) => (
                <SettingsRow
                  className="plugin-requirement__link"
                  key={link.account.id}
                  title={link.account.label}
                  detail={
                    link.current ? "Linked" : "Needs review: the plugin changed what it asks for"
                  }
                  action={
                    <button
                      aria-label={`Unlink ${link.account.label}`}
                      className="btn btn--small btn--ghost"
                      disabled={action.pending !== null}
                      onClick={() =>
                        action.run(`unlink:${link.account.id}`, () =>
                          unlinkPluginAccount(hostClient, target, link.account.id),
                        )
                      }
                      type="button"
                    >
                      {action.pending === `unlink:${link.account.id}` ? "Unlinking…" : "Unlink"}
                    </button>
                  }
                />
              ))}
            </div>
          );
        })}
      </div>
      <SettingsError message={action.error} />
      {connecting ? (
        <PluginConnectDialog
          onClose={() => setConnecting(null)}
          onLinked={() => {
            setConnecting(null);
            reload();
          }}
          target={connecting}
        />
      ) : null}
    </section>
  );
}

/** "Show all" for a section the detail sends the first few of, with the Host's further pages. */
function SectionPages({
  label,
  noun,
  section,
}: {
  readonly label: string;
  readonly noun: string;
  readonly section: ReturnType<typeof usePluginSection<unknown>>;
}) {
  if (!section.expandable) return null;
  return (
    <>
      {section.error ? (
        <div className="card__row">
          <span className="card__row-body">
            <span className="card__row-detail">
              {readWords({ ...section.error, resource: noun })}
            </span>
          </span>
          <button className="btn btn--small" onClick={section.retry} type="button">
            Try again
          </button>
        </div>
      ) : null}
      {section.more ? (
        <button
          className="card__row plugins-link-row"
          disabled={section.loadingMore}
          onClick={section.more}
          type="button"
        >
          <span className="card__row-body">
            <span className="card__row-title">
              {section.loadingMore ? "Loading…" : `Show more ${noun}`}
            </span>
          </span>
        </button>
      ) : null}
      <button
        className="card__row plugins-link-row"
        disabled={section.loading}
        onClick={section.toggle}
        type="button"
      >
        <span className="card__row-body">
          <span className="card__row-title">
            {section.loading ? "Loading…" : section.all ? "Show fewer" : label}
          </span>
        </span>
      </button>
    </>
  );
}

function ToolsSection({ data }: { readonly data: InstalledPluginView }) {
  const emptyText = pluginEmptyToolsText(data);
  const { hostClient } = useShell();
  const id = data.plugin.id;
  const version = data.plugin.activeVersion;
  const tools = usePluginSection(
    data.tools ?? [],
    data.toolCount,
    pluginToolsReader(hostClient, id),
    `tools:${id}:${version}`,
    hostClient,
  );
  const skills = usePluginSection(
    data.skills ?? [],
    data.skillCount,
    pluginSkillsReader(hostClient, id),
    `skills:${id}:${version}`,
    hostClient,
  );
  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">
          Tools
          {data.toolCount ? <span className="plugin-page__count">{data.toolCount}</span> : null}
        </h2>
        {emptyText ? (
          <p className="settings-footnote">{emptyText}</p>
        ) : (
          <div className="card">
            {tools.items.map((tool) => (
              <SettingsRow
                key={tool.name}
                title={<code className="plugin-page__tool">{tool.name}</code>}
                detail={tool.description || undefined}
                action={
                  tool.readOnly ? (
                    <span className="chip">Reads</span>
                  ) : (
                    <span className="chip chip--warn">Writes</span>
                  )
                }
              />
            ))}
            <SectionPages label={`Show all ${data.toolCount} tools`} noun="tools" section={tools} />
          </div>
        )}
      </section>
      {data.skills?.length ? (
        <section className="settings-group">
          <h2 className="settings-group__title">Skills</h2>
          <div className="card">
            {skills.items.map((skill) => (
              <SettingsRow
                key={skill.name}
                title={skill.name}
                detail={skill.description || undefined}
              />
            ))}
            <SectionPages
              label={`Show all ${data.skillCount} skills`}
              noun="skills"
              section={skills}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}

function SchedulesSection({
  data,
  pluginId,
  runs,
}: {
  readonly data: InstalledPluginView | null;
  readonly pluginId: string;
  readonly runs: ReturnType<typeof usePluginScheduleRuns>;
}) {
  const { hostClient } = useShell();
  const action = usePluginAction();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Schedules</h2>
      {data?.schedules.length ? (
        <div className="card">
          {data.schedules.map((schedule) => {
            const settings = schedule.settings;
            const enabled = settings?.enabled ?? false;
            return (
              <div className="plugin-schedule" key={schedule.name}>
                <SettingsRow
                  title={schedule.name}
                  detail={[
                    pluginScheduleText(schedule.timing),
                    enabled && settings?.nextAt ? `next ${formatWhen(settings.nextAt)}` : null,
                    settings?.running ? "running now" : null,
                    pluginScheduleSkipped(schedule, data.requirements),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  action={
                    <SettingsSwitch
                      checked={enabled}
                      disabled={action.pending !== null}
                      label={`Run ${schedule.name}`}
                      onChange={(checked) =>
                        action.run(`schedule:${schedule.name}`, () =>
                          configurePluginSchedule(hostClient, {
                            pluginId: pluginId,
                            schedule: schedule.name,
                            enabled: checked,
                            ...(settings ? { approvalMode: settings.approvalMode } : {}),
                          }),
                        )
                      }
                    />
                  }
                />
                {enabled ? (
                  <div className="plugin-schedule__mode">
                    <SettingsSegmented
                      disabled={action.pending !== null}
                      label={`When ${schedule.name} runs`}
                      onChange={(approvalMode) =>
                        action.run(`mode:${schedule.name}`, () =>
                          configurePluginSchedule(hostClient, {
                            pluginId: pluginId,
                            schedule: schedule.name,
                            enabled: true,
                            approvalMode,
                          }),
                        )
                      }
                      options={[
                        { value: "automatic", label: "Run on its own" },
                        { value: "browser", label: "Ask me each time" },
                      ]}
                      value={settings?.approvalMode ?? "automatic"}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <SettingsError message={action.error} />
      {runs.error ? (
        <RunsReadFailure
          error={runs.error}
          retry={() => void runs.reload()}
          what="this plugin's scheduled runs"
        />
      ) : !runs.loaded ? (
        <LoadingRows label="Loading scheduled runs" rows={1} />
      ) : null}
      {runs.pending.map((run) => (
        <div className="plugin-approval" key={run.id}>
          <p className="plugin-approval__title">
            <Icon name="clock" />
            {run.schedule} is waiting for you
            {run.expiresAt ? (
              <span className="settings-footnote"> · until {formatWhen(run.expiresAt)}</span>
            ) : null}
          </p>
          {run.approval ? (
            <>
              <p className="settings-footnote">
                It wants to run <code>{run.approval.tool}</code> with exactly:
              </p>
              <pre className="plugin-arguments">
                {JSON.stringify(run.approval.arguments, null, 2)}
              </pre>
            </>
          ) : null}
          <div className="action-buttons">
            <button
              className="btn btn--ghost"
              disabled={action.pending !== null}
              onClick={() =>
                action.run(`decline:${run.id}`, () =>
                  answerPluginScheduledRun(hostClient, pluginId, run.id, "decline").then(
                    runs.reload,
                  ),
                )
              }
              type="button"
            >
              Decline
            </button>
            <button
              className="btn btn--primary"
              disabled={action.pending !== null}
              onClick={() =>
                action.run(`accept:${run.id}`, () =>
                  answerPluginScheduledRun(hostClient, pluginId, run.id, "accept").then(
                    runs.reload,
                  ),
                )
              }
              type="button"
            >
              Approve
            </button>
          </div>
        </div>
      ))}
      {runs.more ? (
        <button
          className="btn btn--small"
          disabled={runs.loadingMore}
          onClick={() => void runs.showMore()}
          type="button"
        >
          Show more approvals
        </button>
      ) : null}
      {runs.recent.length ? (
        <details className="plugin-runs">
          <summary>Recent runs</summary>
          <div className="card">
            {runs.recent.map((run) => (
              <SettingsRow
                key={run.id}
                title={run.schedule}
                detail={`${pluginScheduledRunLabel(run)}${run.scheduledAt ? ` · ${formatWhen(run.scheduledAt)}` : ""}`}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** A run read that failed, said as a failure: never as "nothing has run". */
function RunsReadFailure({
  error,
  retry,
  what,
}: {
  readonly error: import("@opensteer/client/feedback").ClientIssue;
  readonly retry: () => void;
  readonly what: string;
}) {
  return (
    <div className="plugin-runs-failure" role="alert">
      <p className="settings-footnote">{readWords({ ...error, resource: what })}</p>
      <button className="btn btn--small" onClick={retry} type="button">
        Try again
      </button>
    </div>
  );
}

function WorkflowsSection({
  data,
  runs,
}: {
  readonly data: InstalledPluginView;
  readonly runs: WorkflowRuns;
}) {
  const { hostClient } = useShell();
  const action = usePluginAction();
  const [starting, setStarting] = useState<
    NonNullable<InstalledPluginView["workflows"]>[number] | null
  >(null);
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Workflows</h2>
      {data.workflows === null ? (
        <p className="settings-footnote">
          {data.plugin.status === "ready"
            ? "This version's workflows couldn't be read, so none can be started. Runs already under way are below."
            : "Workflows can be started once its accounts are connected and a version builds. Runs already under way are below."}
        </p>
      ) : null}
      <div className="card">
        {data.workflows?.map((workflow) => (
          <SettingsRow
            key={workflow.name}
            title={workflow.name}
            detail={workflow.description ?? undefined}
            action={
              <button
                className="btn btn--small"
                onClick={() => setStarting(workflow)}
                type="button"
              >
                Start
              </button>
            }
          />
        ))}
        {runs.visible.map((run) => (
          <SettingsRow
            className="plugin-run"
            key={run.id}
            title={run.workflow}
            detail={`${pluginWorkflowRunLabel(run)} · ${formatWhen(run.createdAt)}`}
            action={
              pluginWorkflowRunLive(run) ? (
                <button
                  aria-label={`Stop ${run.workflow} run from ${formatWhen(run.createdAt)}`}
                  className="btn btn--small btn--ghost"
                  disabled={action.pending !== null}
                  onClick={() =>
                    action.run(`stop:${run.id}`, () =>
                      stopPluginWorkflow(hostClient, data.plugin.id, run.id).then(runs.retry),
                    )
                  }
                  type="button"
                >
                  {action.pending === `stop:${run.id}` ? "Stopping…" : "Stop"}
                </button>
              ) : undefined
            }
          />
        ))}
        {runs.loaded && runs.more ? (
          <button
            className="card__row plugins-link-row"
            disabled={runs.loadingMore}
            onClick={runs.showMore}
            type="button"
          >
            <span className="card__row-body">
              <span className="card__row-title">
                {runs.loadingMore ? "Loading…" : "Show more runs"}
              </span>
            </span>
          </button>
        ) : null}
      </div>
      {runs.error ? (
        <RunsReadFailure error={runs.error} retry={runs.retry} what="this plugin's workflow runs" />
      ) : !runs.loaded ? (
        <LoadingRows label="Loading workflow runs" rows={1} />
      ) : null}
      <SettingsError message={action.error} />
      {starting ? (
        <StartWorkflow
          onClose={() => setStarting(null)}
          onStarted={() => {
            setStarting(null);
            runs.retry();
          }}
          pluginId={data.plugin.id}
          workflow={starting}
        />
      ) : null}
    </section>
  );
}

function StartWorkflow({
  onClose,
  onStarted,
  pluginId,
  workflow,
}: {
  readonly onClose: () => void;
  readonly onStarted: () => void;
  readonly pluginId: string;
  readonly workflow: NonNullable<InstalledPluginView["workflows"]>[number];
}) {
  const { hostClient } = useShell();
  const form = pluginInputForm(workflow.inputSchema);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const action = usePluginAction();
  const titleId = useId();
  const content = pluginInputContent(form, answers);
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      title={<span id={titleId}>Start {workflow.name}</span>}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={"problem" in content || action.pending !== null}
            onClick={() =>
              "content" in content &&
              action.run("start", () =>
                startPluginWorkflow(hostClient, pluginId, workflow.name, content.content).then(
                  onStarted,
                ),
              )
            }
            type="button"
          >
            {action.pending ? "Starting…" : "Start"}
          </button>
        </>
      }
    >
      <div className="plugins-form">
        {workflow.description ? <p>{workflow.description}</p> : null}
        <PluginFormFields answers={answers} form={form} onChange={setAnswers} />
        {"problem" in content && form.unsupported.length ? (
          <p className="settings-footnote">{content.problem}</p>
        ) : null}
        <SettingsError message={action.error} />
      </div>
    </Dialog>
  );
}

function WebhooksSection({
  data,
  reload,
}: {
  readonly data: InstalledPluginView;
  readonly reload: () => void;
}) {
  const { hostClient } = useShell();
  const action = usePluginAction();
  const [setup, setSetup] = useState<string | null>(null);
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Webhooks</h2>
      <div className="card">
        {data.webhooks.map((webhook) => (
          <SettingsRow
            key={webhook.id}
            title={webhook.name}
            detail={pluginWebhookStatusText(webhook)}
            action={
              webhook.status === "setup-required" ||
              webhook.status === "stopping" ||
              webhook.status === "disabled" ? (
                <button
                  aria-label={`${webhook.status === "setup-required" ? "Finish setting up" : "Finish removing"} ${webhook.name}`}
                  className="btn btn--small btn--primary"
                  onClick={() => setSetup(webhook.id)}
                  type="button"
                >
                  {webhook.status === "setup-required" ? "Finish setup" : "Finish removal"}
                </button>
              ) : (
                <button
                  className="btn btn--small btn--ghost"
                  disabled={action.pending !== null}
                  type="button"
                  onClick={() =>
                    action.run(webhook.id, () =>
                      removePluginWebhook(hostClient, data.plugin.id, webhook.id).then(async () => {
                        const next = await readPluginWebhookSetup(
                          hostClient,
                          data.plugin.id,
                          webhook.id,
                        );
                        reload();
                        if (next.step === "remove") setSetup(webhook.id);
                      }),
                    )
                  }
                >
                  Remove
                </button>
              )
            }
          />
        ))}
      </div>
      <SettingsError message={action.error} />
      {data.webhookUnavailable ? (
        <p className="settings-footnote">{data.webhookUnavailable}</p>
      ) : null}
      {setup ? (
        <WebhookSetup
          onClose={() => {
            setSetup(null);
            reload();
          }}
          pluginId={data.plugin.id}
          webhookId={setup}
        />
      ) : null}
    </section>
  );
}

function WebhookSetup({
  onClose,
  pluginId,
  webhookId,
}: {
  readonly onClose: () => void;
  readonly pluginId: string;
  readonly webhookId: string;
}) {
  const { hostClient } = useShell();
  const setup = useSettingsRead(
    () => readPluginWebhookSetup(hostClient, pluginId, webhookId),
    `webhook:${pluginId}:${webhookId}`,
    false,
    { pluginId, categories: ["webhooks", "webhookSources"] },
  );
  const titleId = useId();
  const action = usePluginAction();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [secret, setSecret] = useState("");
  const [removing, setRemoving] = useState(false);
  const data = setup.data;
  const form = data ? pluginWebhookSetupForm(data) : null;
  const completion = data ? pluginWebhookSetupCompletion(pluginId, data, answers, secret) : null;
  const remove = () =>
    action.run("remove", () =>
      removePluginWebhook(hostClient, pluginId, webhookId).then(async () => {
        setRemoving(false);
        const next = await readPluginWebhookSetup(hostClient, pluginId, webhookId).catch(
          () => null,
        );
        if (next?.step === "remove") setup.reload();
        else onClose();
      }),
    );
  const footer =
    data?.step === "remove" ? (
      <button
        className="btn btn--danger"
        type="button"
        disabled={action.pending !== null}
        onClick={() =>
          action.run("confirm", () =>
            confirmPluginWebhookRemoval(hostClient, pluginId, webhookId).then(onClose),
          )
        }
      >
        I've removed it at the service
      </button>
    ) : data?.step === "configure" ? (
      removing ? (
        <>
          <button className="btn btn--ghost" onClick={() => setRemoving(false)} type="button">
            Keep it
          </button>
          <button
            className="btn btn--danger"
            disabled={action.pending !== null}
            onClick={remove}
            type="button"
          >
            {action.pending === "remove" ? "Removing…" : "Remove webhook"}
          </button>
        </>
      ) : (
        <>
          <button
            className="btn btn--ghost"
            disabled={action.pending !== null}
            onClick={() => setRemoving(true)}
            type="button"
          >
            Remove
          </button>
          <button
            className="btn btn--primary"
            disabled={!completion || "problem" in completion || action.pending !== null}
            onClick={() =>
              completion &&
              "command" in completion &&
              action.run("complete", () =>
                completePluginWebhookSetup(hostClient, completion.command).then(onClose),
              )
            }
            type="button"
          >
            {action.pending === "complete" ? "Finishing…" : "Done"}
          </button>
        </>
      )
    ) : data?.step === "done" ? (
      <button className="btn btn--primary" onClick={onClose} type="button">
        Close
      </button>
    ) : undefined;
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      footer={footer}
      title={
        <span id={titleId}>
          {data?.step === "remove"
            ? "Remove the webhook"
            : `Set up ${data?.webhook.name ?? "the webhook"}`}
        </span>
      }
    >
      <div className="plugins-form">
        <SettingsError message={action.error ?? setup.error} />
        {data && form ? (
          <>
            {data.unavailable ? (
              <p className="notice notice--warn" role="status">
                {data.unavailable}
              </p>
            ) : null}
            {data.step === "done" ? (
              <p>This webhook is set up. {pluginWebhookStatusText(data.webhook)}.</p>
            ) : null}
            {data.instructions ? <p>{data.instructions}</p> : null}
            {data.step !== "done" ? (
              <CopyBlock label="Address to give the service" value={data.callbackUrl} />
            ) : null}
            {form.secret?.kind === "generated" ? (
              <CopyBlock label="Signing secret to give the service" value={form.secret.value} />
            ) : form.secret?.kind === "provider" ? (
              <label className="plugins-field">
                <span>Signing secret from the service</span>
                <input
                  autoComplete="off"
                  className="text-input"
                  onChange={(event) => setSecret(event.currentTarget.value)}
                  placeholder="Paste it here"
                  type="password"
                  value={secret}
                />
              </label>
            ) : null}
            {form.fields.fields.length || form.fields.unsupported.length ? (
              <PluginFormFields answers={answers} form={form.fields} onChange={setAnswers} />
            ) : null}
            {data.step === "configure" && form.secret?.kind === "generated" ? (
              <p className="settings-footnote">The secret is shown only until setup is done.</p>
            ) : null}
            {removing ? (
              <p className="settings-footnote">
                Removing it stops events from reaching this plugin. If the service already has this
                address, you'll be asked to remove it there too.
              </p>
            ) : null}
          </>
        ) : setup.error ? null : (
          <LoadingRows label="Loading setup" rows={2} />
        )}
      </div>
    </Dialog>
  );
}

function VersionsSection({ data }: { readonly data: InstalledPluginView }) {
  const { hostClient } = useShell();
  const action = usePluginAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const versions = usePluginSection(
    data.versions,
    data.versionCount,
    pluginVersionsReader(hostClient, data.plugin.id),
    `versions:${data.plugin.id}:${data.plugin.activeVersion}`,
    hostClient,
  );
  const titleId = useId();
  if (!data.versions.length) return null;
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Versions</h2>
      <div className="card">
        {versions.items.map((version) => (
          <SettingsRow
            key={version.id}
            title={version.createdAt ? formatWhen(version.createdAt) : version.id}
            detail={pluginAuthorText(version.author)}
            action={
              version.active ? (
                <span className="chip chip--ok">In use</span>
              ) : (
                <button
                  className="btn btn--small"
                  disabled={action.pending !== null}
                  onClick={() => setConfirming(version.id)}
                  type="button"
                >
                  Use this version
                </button>
              )
            }
          />
        ))}
        <SectionPages
          label={`Show all ${data.versionCount} versions`}
          noun="versions"
          section={versions}
        />
      </div>
      <p className="settings-footnote">
        Switching versions changes the plugin's code, not the data it has stored.
      </p>
      <SettingsError message={action.error} />
      {confirming ? (
        <Dialog
          labelledBy={titleId}
          narrow
          onClose={() => setConfirming(null)}
          title={<span id={titleId}>Use this version?</span>}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(null)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--primary"
                disabled={action.pending !== null}
                onClick={() =>
                  action.run("activate", () =>
                    activatePluginVersion(hostClient, data.plugin.id, confirming).then(() =>
                      setConfirming(null),
                    ),
                  )
                }
                type="button"
              >
                {action.pending ? "Switching…" : "Use this version"}
              </button>
            </>
          }
        >
          <p>
            {data.plugin.name} will run this version's code from now on. Anything it has stored
            stays as it is: switching back changes code, not data.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

function RemoveSection({ data }: { readonly data: InstalledPluginView }) {
  const { hostClient } = useShell();
  const navigate = useNavigate();
  const action = usePluginAction();
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  return (
    <section className="settings-group">
      <div className="card">
        <SettingsRow
          title={`Remove ${data.plugin.name}`}
          detail={
            <>
              Agents lose its tools. Connected accounts stay saved;{" "}
              <Link to={pluginAccountsPath}>remove them in Connected accounts</Link>.
            </>
          }
          action={
            <button
              className="btn btn--small btn--danger"
              onClick={() => setConfirming(true)}
              type="button"
            >
              Remove
            </button>
          }
        />
      </div>
      {confirming ? (
        <Dialog
          labelledBy={titleId}
          narrow
          onClose={() => setConfirming(false)}
          title={<span id={titleId}>Remove {data.plugin.name}?</span>}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setConfirming(false)} type="button">
                Cancel
              </button>
              <button
                className="btn btn--danger"
                disabled={action.pending !== null}
                onClick={() =>
                  action.run("remove", () =>
                    removePlugin(hostClient, data.plugin.id).then(() => navigate(pluginsPath)),
                  )
                }
                type="button"
              >
                {action.pending ? "Removing…" : "Remove"}
              </button>
            </>
          }
        >
          <p>Its code, versions, schedules and stored data go with it.</p>
          <SettingsError message={action.error} />
        </Dialog>
      ) : null}
    </section>
  );
}
