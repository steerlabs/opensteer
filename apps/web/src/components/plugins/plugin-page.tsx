import { useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  activatePluginVersion,
  answerPluginScheduledRun,
  configurePluginSchedule,
  pluginAccessChoices,
  pluginAuthorText,
  pluginEngineRefusal,
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
  setPluginAccess,
  startPluginWorkflow,
  stopPluginWorkflow,
  unlinkPluginAccount,
  type InstalledPluginView,
  type PluginRequirementTarget,
} from "@opensteer/client/plugins";
import { useShell } from "../app-shell.js";
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
import { actionErrorMessage } from "../../ui-utils.js";
import { PluginConnectDialog } from "./plugin-connect.js";
import { PluginFormFields } from "./plugin-form-fields.js";
import { EngineNotice, pluginsPath, usePluginEngine } from "./plugins-area.js";

/** Runs a person's action once at a time, with its failure shown where they acted. */
function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (key: string, action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(key);
    setError(null);
    void action()
      .catch((reason: unknown) => setError(actionErrorMessage(reason)))
      .finally(() => setPending(null));
  };
  return { pending, error, run };
}

export function PluginPage({ pluginId }: { readonly pluginId: string }) {
  const { hostClient } = useShell();
  const detail = useSettingsRead(() => readPlugin(hostClient, pluginId), `plugin:${pluginId}`);
  const data = detail.data;
  const refused = data ? null : pluginEngineRefusal(detail.error);
  const engine = usePluginEngine(refused);
  return (
    <div className="plugins-area plugin-page">
      <Link className="plugins-back" to={pluginsPath}>
        <Icon name="arrow-left" />
        Plugins
      </Link>
      <EngineNotice engine={data ? null : engine} />
      <SettingsError message={detail.error && !refused ? actionErrorMessage(detail.error) : null} />
      {data ? (
        <PluginContent data={data} reload={detail.reload} />
      ) : detail.error ? (
        <button className="btn" onClick={detail.reload} type="button">
          Try again
        </button>
      ) : (
        <LoadingRows label="Loading plugin" rows={4} />
      )}
    </div>
  );
}

function PluginContent({
  data,
  reload,
}: {
  readonly data: InstalledPluginView;
  readonly reload: () => void;
}) {
  const { plugin } = data;
  const status = pluginStatusView(plugin);
  const active = data.versions.find((version) => version.active);
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
      {plugin.status === "not-built" ? (
        <p className="notice notice--error" role="status">
          This plugin has no working version. Its last build failed, so agents can't use it. Ask
          your agent to fix it, or roll back to an earlier version below.
        </p>
      ) : status.tone === "attention" ? (
        <p className="notice notice--warn" role="status">
          Connect an account below before agents can use {plugin.name}.
        </p>
      ) : null}
      {data.page ? (
        <div className="plugin-page__open">
          <button
            className="btn"
            disabled={data.page.url === null}
            onClick={() => data.page?.url && window.open(data.page.url, "_blank", "noopener")}
            type="button"
          >
            <Icon name="globe" />
            Open {plugin.name}'s page
          </button>
          {data.page.unavailable ? (
            <span className="settings-footnote">{data.page.unavailable}</span>
          ) : null}
        </div>
      ) : null}
      <AccessSection data={data} />
      <AccountsSection data={data} reload={reload} />
      <ToolsSection data={data} />
      {data.schedules.length ? <SchedulesSection data={data} /> : null}
      {data.workflows?.length ? <WorkflowsSection data={data} /> : null}
      {data.webhooks.length ? <WebhooksSection data={data} /> : null}
      <VersionsSection data={data} />
      <RemoveSection data={data} />
    </>
  );
}

function AccessSection({ data }: { readonly data: InstalledPluginView }) {
  const { hostClient } = useShell();
  const action = useAction();
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
  const action = useAction();
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

function ToolsSection({ data }: { readonly data: InstalledPluginView }) {
  const [all, setAll] = useState(false);
  const tools = data.tools;
  const shown = tools && !all ? tools.slice(0, 8) : tools;
  return (
    <>
      <section className="settings-group">
        <h2 className="settings-group__title">
          Tools
          {data.toolCount ? <span className="plugin-page__count">{data.toolCount}</span> : null}
        </h2>
        {tools === null ? (
          <p className="settings-footnote">
            {data.plugin.status === "not-built"
              ? "Tools appear once a version builds."
              : "Tools appear once its accounts are connected."}
          </p>
        ) : tools.length === 0 ? (
          <p className="settings-footnote">This plugin has no tools.</p>
        ) : (
          <div className="card">
            {shown!.map((tool) => (
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
            {tools.length > 8 ? (
              <button
                className="card__row plugins-link-row"
                onClick={() => setAll(!all)}
                type="button"
              >
                <span className="card__row-body">
                  <span className="card__row-title">
                    {all ? "Show fewer" : `Show all ${data.toolCount} tools`}
                  </span>
                </span>
              </button>
            ) : null}
          </div>
        )}
      </section>
      {data.skills?.length ? (
        <section className="settings-group">
          <h2 className="settings-group__title">Skills</h2>
          <div className="card">
            {data.skills.map((skill) => (
              <SettingsRow
                key={skill.name}
                title={skill.name}
                detail={skill.description || undefined}
              />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function SchedulesSection({ data }: { readonly data: InstalledPluginView }) {
  const { hostClient } = useShell();
  const action = useAction();
  const runs = useSettingsRead(
    () => readPluginScheduleRuns(hostClient, data.plugin.id),
    `plugin-runs:${data.plugin.id}`,
  );
  const waiting = runs.data?.runs.filter((run) => run.status === "awaiting-approval") ?? [];
  const recent =
    runs.data?.runs.filter((run) => run.status !== "awaiting-approval").slice(0, 5) ?? [];
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Schedules</h2>
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
                          pluginId: data.plugin.id,
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
                          pluginId: data.plugin.id,
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
      <SettingsError
        message={action.error ?? (runs.error ? actionErrorMessage(runs.error) : null)}
      />
      {waiting.map((run) => (
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
                  answerPluginScheduledRun(hostClient, data.plugin.id, run.id, "decline").then(
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
                  answerPluginScheduledRun(hostClient, data.plugin.id, run.id, "accept").then(
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
      {recent.length ? (
        <details className="plugin-runs">
          <summary>Recent runs</summary>
          <div className="card">
            {recent.map((run) => (
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

function WorkflowsSection({ data }: { readonly data: InstalledPluginView }) {
  const { hostClient } = useShell();
  const action = useAction();
  const runs = useSettingsRead(
    () => readPluginWorkflowRuns(hostClient, data.plugin.id),
    `plugin-workflows:${data.plugin.id}`,
  );
  const [starting, setStarting] = useState<
    NonNullable<InstalledPluginView["workflows"]>[number] | null
  >(null);
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Workflows</h2>
      <div className="card">
        {data.workflows!.map((workflow) => (
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
        {runs.data?.runs.slice(0, 6).map((run) => (
          <SettingsRow
            className="plugin-run"
            key={run.id}
            title={run.workflow}
            detail={`${pluginWorkflowRunLabel(run)} · ${formatWhen(run.createdAt)}`}
            action={
              pluginWorkflowRunLive(run) ? (
                <button
                  className="btn btn--small btn--ghost"
                  disabled={action.pending !== null}
                  onClick={() =>
                    action.run(`stop:${run.id}`, () =>
                      stopPluginWorkflow(hostClient, data.plugin.id, run.id).then(runs.reload),
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
      </div>
      <SettingsError message={action.error} />
      {starting ? (
        <StartWorkflow
          onClose={() => setStarting(null)}
          onStarted={() => {
            setStarting(null);
            runs.reload();
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
  const action = useAction();
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

function WebhooksSection({ data }: { readonly data: InstalledPluginView }) {
  const [setup, setSetup] = useState<string | null>(null);
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Webhooks</h2>
      <div className="card">
        {data.webhooks.map((webhook) => (
          <SettingsRow
            key={webhook.id}
            title={webhook.name}
            detail={
              webhook.failure
                ? `Couldn't ${webhook.failure === "register" ? "register with" : "unregister from"} the service`
                : webhook.status === "active"
                  ? "Receiving events"
                  : webhook.status === "setup-required"
                    ? "Needs setup at the service"
                    : webhook.status === "pending"
                      ? "Setting up"
                      : webhook.status === "stopping"
                        ? "Stopping"
                        : "Stopped"
            }
            action={
              webhook.status === "setup-required" ? (
                <button
                  className="btn btn--small btn--primary"
                  onClick={() => setSetup(webhook.id)}
                  type="button"
                >
                  Finish setup
                </button>
              ) : (
                <span className={`chip${webhook.status === "active" ? " chip--ok" : ""}`}>
                  {webhook.status === "active" ? "On" : webhook.status.replace("-", " ")}
                </span>
              )
            }
          />
        ))}
      </div>
      <p className="settings-footnote">
        Webhook events reach this computer once Opensteer's webhook route is set up for it.
      </p>
      {setup ? (
        <WebhookSetup onClose={() => setSetup(null)} pluginId={data.plugin.id} webhookId={setup} />
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
    `webhook:${webhookId}`,
  );
  const titleId = useId();
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      title={<span id={titleId}>Set up the webhook</span>}
    >
      <div className="plugins-form">
        <SettingsError message={setup.error ? actionErrorMessage(setup.error) : null} />
        {setup.data ? (
          <>
            {setup.data.instructions ? <p>{setup.data.instructions}</p> : null}
            <label className="plugins-field">
              <span>Address to give the service</span>
              <input className="text-input" readOnly value={setup.data.callbackUrl} />
            </label>
            {setup.data.signingSecret ? (
              <label className="plugins-field">
                <span>Signing secret</span>
                <input className="text-input" readOnly value={setup.data.signingSecret} />
              </label>
            ) : null}
          </>
        ) : (
          <LoadingRows label="Loading setup" rows={2} />
        )}
      </div>
    </Dialog>
  );
}

function VersionsSection({ data }: { readonly data: InstalledPluginView }) {
  const { hostClient } = useShell();
  const action = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const titleId = useId();
  if (!data.versions.length) return null;
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Versions</h2>
      <div className="card">
        {data.versions.map((version) => (
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
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  return (
    <section className="settings-group">
      <div className="card">
        <SettingsRow
          title={`Remove ${data.plugin.name}`}
          detail="Agents lose its tools. Connected accounts stay saved for other plugins."
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
