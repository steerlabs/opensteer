import {
  audienceLabel,
  composerRuntimeNotice,
  isTeamPlace,
  requestOutcomeLine,
  requestWaitLines,
  taskStarterLine,
  taskStoppedText,
  unplacedOutcomes,
  type HostSnapshot,
  type ThreadSummary,
} from "@opensteer/client/host";
import { useHostRead } from "@opensteer/client/react";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { formatWhen } from "../settings/primitives.js";
import { AreaLink } from "../workspace/area-link.js";
import { useShellTeam } from "./team-ui.js";

/** The latest outcomes a task shows; the Host keeps more than a reader needs here. */
const outcomesShown = 3;

function placeOf(snapshot: HostSnapshot, thread: ThreadSummary) {
  const project =
    snapshot.workspaces.find(({ id }) => id === thread.workspaceId)?.name ?? "this project";
  return { project, team: snapshot.identityConfig?.deployment.name ?? "the team" };
}

/**
 * What a shared task says above its composer on a team place: who started it,
 * who can see it, why it stopped, whom its questions wait on and how they
 * ended. Every line is a Host fact; a fact it doesn't send is not drawn.
 */
export function TeamTaskFacts({
  runtime = null,
  thread,
}: {
  readonly runtime?: TeamRuntimeNotice | null;
  readonly thread: ThreadSummary;
}) {
  const { snapshot } = useShell();
  if (!isTeamPlace(snapshot)) return null;
  const place = placeOf(snapshot, thread);
  const held = new Set(
    (snapshot.requests[thread.id] ?? [])
      .filter(({ status }) => status === "pending")
      .map(({ id }) => id),
  );
  const waits = thread.requestWaits
    ? requestWaitLines(thread.requestWaits, place.project, held)
    : [];
  // An outcome whose question the transcript shows is told there, where it was asked.
  const outcomes = unplacedOutcomes(
    thread.requestOutcomes ?? [],
    snapshot.transcripts[thread.id] ?? [],
  ).slice(-outcomesShown);
  const starter = thread.startedBy
    ? taskStarterLine(thread.startedBy, snapshot.user?.id ?? null)
    : null;
  if (
    !starter &&
    !thread.audience &&
    !thread.stopped &&
    waits.length === 0 &&
    outcomes.length === 0 &&
    runtime === null
  )
    return null;
  return (
    <div className="team-task" role="group" aria-label="About this task">
      {starter || thread.audience ? (
        <div className="team-task__line">
          {starter ? (
            <span className="team-task__starter">
              <Icon
                name={
                  thread.startedBy?.kind === "trigger"
                    ? "repeat"
                    : thread.startedBy?.kind === "watch"
                      ? "eye"
                      : "user"
                }
              />
              {starter}
            </span>
          ) : null}
          {thread.audience ? (
            <AreaLink
              className="team-marker"
              title="Who can see this"
              to={`/workspaces/${encodeURIComponent(thread.workspaceId)}/settings`}
            >
              <Icon name="users" />
              {audienceLabel(thread.audience, place.project)}
            </AreaLink>
          ) : null}
        </div>
      ) : null}
      {outcomes.length > 0 ? (
        <ul aria-label="Earlier questions" className="team-task__earlier">
          {outcomes.map((outcome) => (
            <li className="team-task__outcome" key={outcome.requestId}>
              <Icon name="check-circle" />
              <span>
                Earlier question · {requestOutcomeLine(outcome, place)} · {formatWhen(outcome.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {thread.stopped ? (
        <p className="team-task__stopped">{taskStoppedText(thread.stopped, place).long}</p>
      ) : null}
      {waits.map((line) => (
        <p className="team-task__wait" key={line}>
          <Icon name="clock" />
          {line}
        </p>
      ))}
      {runtime ? (
        <p className="team-task__runtime">
          <Icon name="alert-circle" />
          <span>
            {runtime.why} {runtime.fix}{" "}
            {runtime.settings ? (
              <AreaLink
                to={`/workspaces/${encodeURIComponent(thread.workspaceId)}/settings#team-project-runtime`}
              >
                How it runs
              </AreaLink>
            ) : null}
          </span>
        </p>
      ) : null}
    </div>
  );
}

export type TeamRuntimeNotice = NonNullable<ReturnType<typeof composerRuntimeNotice>>;

/**
 * Why a shared Project's composer can't send, from the summary's runtime. Who
 * may fix it comes from the Host's `can` on the Project, read only while it
 * can't run; until that answers, the reader is told who can.
 */
export function useTeamRuntimeNotice(thread: ThreadSummary): TeamRuntimeNotice | null {
  const { snapshot } = useShell();
  const { team, summary, identity, generation } = useShellTeam();
  const runtime = summary?.projects.find(({ id }) => id === thread.workspaceId)?.runtime;
  const blocked = isTeamPlace(snapshot) && runtime !== undefined && runtime.state !== "ready";
  const access = useHostRead(
    team && blocked
      ? () => team.projectAccess({ workspaceId: thread.workspaceId, limit: 1 })
      : null,
    `team-runtime-access:${identity}:${thread.workspaceId}:${generation}`,
  );
  if (!blocked) return null;
  return composerRuntimeNotice(runtime, {
    ...placeOf(snapshot, thread),
    canChange: access.data?.can.manage.allowed === true,
  });
}
