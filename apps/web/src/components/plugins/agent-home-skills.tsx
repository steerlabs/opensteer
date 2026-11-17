import { useRef, useState } from "react";
import { Link } from "react-router";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { agentHomeSkills } from "@opensteer/client/plugins";
import { settingsMutationRejected } from "@opensteer/client/settings";
import type { PluginRow } from "@opensteer/protocol";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { LoadingRows } from "../loading-rows.js";
import { SectionHeader, SettingsError } from "../settings/primitives.js";
import { useSettingsRead } from "../settings/use-settings-read.js";
import { pluginsPath } from "./plugins-area.js";

/** The skills in the agent home folder, each with its switch. */
export function AgentHomeSkills() {
  const { hostClient } = useShell();
  const overview = useSettingsRead(
    () => hostClient.rpc["plugins.overview.get"]({}).then(unwrapRpcResult),
    "agent-home-skills",
    true,
  );
  const skills = overview.data ? agentHomeSkills(overview.data.rows) : null;
  return (
    <div className="plugins-area">
      <Link className="plugins-back" to={pluginsPath}>
        <Icon name="arrow-left" />
        Plugins
      </Link>
      <SectionHeader
        title="Skills in Agent home"
        lead="Instructions your agent reads from its folder. Turn one off to keep it from your agent."
      />
      <SettingsError message={overview.error ? actionErrorMessage(overview.error) : null} />
      {!skills ? (
        overview.error ? null : (
          <LoadingRows label="Loading skills" rows={3} />
        )
      ) : skills.length === 0 ? (
        <p className="settings-footnote">
          No skills yet. Your agent adds them to its folder when you ask it to remember how to do
          something.
        </p>
      ) : (
        <div className="card" role="list">
          {skills.map((skill) => (
            <SkillRow key={skill.target.fullName} row={skill} reload={overview.reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillRow({ row, reload }: { readonly row: PluginRow; readonly reload: () => void }) {
  const { hostClient } = useShell();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A lost response may have committed, so a retry repeats the same operation.
  const attempt = useRef<{ key: string; enabled: boolean; revision: number } | null>(null);
  return (
    <div className="card__row" role="listitem">
      <span className="card__row-body">
        <span className="card__row-title">{row.title}</span>
        {row.description ? <span className="card__row-detail">{row.description}</span> : null}
        <SettingsError message={error} />
      </span>
      <label className="settings-switch-target">
        <input
          aria-busy={pending}
          aria-label={`Use ${row.title}`}
          checked={row.placement.enabled}
          className="switch"
          disabled={pending || !row.permissions.canEnable}
          onChange={() => {
            if (pending) return;
            const operation = attempt.current ?? {
              key: mutationIdempotencyKey("skill-enabled"),
              enabled: !row.placement.enabled,
              revision: row.placement.revision,
            };
            attempt.current = operation;
            setPending(true);
            setError(null);
            void hostClient
              .dispatch({
                type: "settings.plugin.enabled.set",
                idempotencyKey: operation.key,
                target: row.target,
                expectedRevision: operation.revision,
                enabled: operation.enabled,
              })
              .then(() => {
                attempt.current = null;
                reload();
              })
              .catch((reason: unknown) => {
                if (settingsMutationRejected(reason)) {
                  attempt.current = null;
                  reload();
                }
                setError(actionErrorMessage(reason));
              })
              .finally(() => setPending(false));
          }}
          role="switch"
          type="checkbox"
        />
      </label>
    </div>
  );
}
