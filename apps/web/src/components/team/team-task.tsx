import {
  audienceLabel,
  composerRuntimeNotice,
  isTeamPlace,
  requestOutcomeLine,
  requestWaitLines,
  taskStarterLine,
  taskStoppedText,
  type HostSnapshot,
  type ThreadSummary,
} from "@opensteer/client/host";
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
export function TeamTaskFacts({ thread }: { readonly thread: ThreadSummary }) {
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
  const outcomes = (thread.requestOutcomes ?? []).slice(-outcomesShown);
  const starter = thread.startedBy
    ? taskStarterLine(thread.startedBy, snapshot.user?.id ?? null)
    : null;
  if (
    !starter &&
    !thread.audience &&
    !thread.stopped &&
    waits.length === 0 &&
    outcomes.length === 0
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
      {thread.stopped ? (
        <p className="team-task__stopped">{taskStoppedText(thread.stopped, place).long}</p>
      ) : null}
      {waits.map((line) => (
        <p className="team-task__wait" key={line}>
          <Icon name="clock" />
          {line}
        </p>
      ))}
      {outcomes.map((outcome) => (
        <p className="team-task__outcome" key={outcome.requestId}>
          {requestOutcomeLine(outcome, place)} · {formatWhen(outcome.at)}
        </p>
      ))}
    </div>
  );
}

/**
 * The composer's refusal on a shared Project that can't run tasks, from the
 * summary's runtime and the reader's level on the Project. Null when it runs
 * or nothing is known.
 */
export function useTeamSendBlocked(thread: ThreadSummary): string | null {
  const { snapshot } = useShell();
  const { summary } = useShellTeam();
  if (!isTeamPlace(snapshot)) return null;
  const runtime = summary?.projects.find(({ id }) => id === thread.workspaceId)?.runtime;
  const notice = composerRuntimeNotice(runtime, {
    ...placeOf(snapshot, thread),
    manages: thread.audience?.myLevel === "manage",
  });
  return notice ? `Can’t send yet. ${notice.why} ${notice.fix}` : null;
}
