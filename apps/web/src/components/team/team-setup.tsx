import { teamSetupSteps, type TeamSetupStep } from "@opensteer/client/host";
import { useHostRead } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { AreaLink } from "../workspace/area-link.js";
import { useShellTeam } from "./team-ui.js";

/**
 * "Get Acme ready": what a new team still needs, ticked from what its Host
 * reports. Read only for someone the Host lets connect its computer and invite.
 */
export function TeamSetupChecklist() {
  const { openNewWorkspace } = useShell();
  const { team, summary, identity, generation } = useShellTeam();
  const allowed = summary?.can.computer?.allowed === true && summary.can.invite.allowed;
  const computer = useHostRead(
    team && allowed ? () => team.computer() : null,
    `team-setup-computer:${identity}:${generation}`,
  );
  const invitations = useHostRead(
    team && allowed ? () => team.invitations({ limit: 1 }) : null,
    `team-setup-invitations:${identity}:${generation}`,
  );
  if (!summary || !allowed) return null;
  const steps = teamSetupSteps({
    team: summary.team.name,
    computer: computer.data ? computer.data.computer : undefined,
    projects: summary.projects,
    invited: invitations.data ? invitations.data.items.length > 0 : undefined,
  });
  if (!steps) return null;
  const done = steps.filter((step) => step.done).length;
  const action = (step: TeamSetupStep) =>
    step.key === "computer" ? (
      <AreaLink className="btn btn--small" to="/settings/team/computer">
        Open
      </AreaLink>
    ) : step.key === "project" ? (
      <button className="btn btn--small" onClick={openNewWorkspace} type="button">
        New project
      </button>
    ) : (
      <AreaLink className="btn btn--small" to="/settings/team/people">
        Invite
      </AreaLink>
    );
  return (
    <section aria-labelledby="team-setup" className="team-setup card">
      <div className="team-setup__head">
        <h2 className="team-setup__title" id="team-setup">
          Get {summary.team.name} ready
        </h2>
        <span className="team-setup__count">
          {done} of {steps.length}
        </span>
      </div>
      <ol className="team-setup__steps">
        {steps.map((step) => (
          <li className={`card__row${step.done ? " team-setup__done" : ""}`} key={step.key}>
            <Icon name={step.done ? "check-circle" : "dot"} />
            <span className="card__row-body">
              <span className="card__row-title">{step.title}</span>
            </span>
            {step.done ? null : action(step)}
          </li>
        ))}
      </ol>
    </section>
  );
}
