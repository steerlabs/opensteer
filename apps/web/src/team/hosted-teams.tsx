import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { unwrapRpcResult } from "@opensteer/client/host";
import {
  availabilityHint,
  createRefusal,
  localAddressHint,
  readTeamInvite,
  slugFromName,
  slugFromTyping,
  type TeamConnectionIntentState,
  type TeamCoordinatorSnapshot,
  type TeamSessionClient,
} from "@opensteer/client/team";
import {
  hostedTeamsDomain,
  type HostedTeamAvailability,
  type HostedTeamSlug,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { createId, DeploymentIdSchema, TeamInviteIdSchema } from "@opensteer/core";
import type { TeamCurrentInvite, TeamInviteExpiryDays } from "@opensteer/protocol";
import { Dialog } from "../components/dialog.js";
import { QrCode } from "../components/first-run/qr-code.js";
import { Icon } from "../components/icon.js";
import { TeamTile } from "../components/team/team-marks.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeamSessionValue, useTeams, type TeamAttachment } from "./team-attachments.js";
import { teamTile } from "./team-people.js";
import { teamPath } from "./team-paths.js";

export const selfHostGuide = "https://github.com/steerlabs/opensteer/tree/main/deploy/team";

/* ---- Where the dialogs open from ---- */

type OpenDialog =
  | { readonly kind: "create" }
  | { readonly kind: "join"; readonly url: string }
  | { readonly kind: "invite"; readonly teamId: string }
  | { readonly kind: "delete"; readonly teamId: string };

interface TeamDialogs {
  readonly openCreate: () => void;
  readonly openJoin: (url: string) => void;
  readonly openInvite: (teamId: string) => void;
  readonly openDelete: (teamId: string) => void;
}

const TeamDialogsContext = createContext<TeamDialogs>({
  openCreate: () => undefined,
  openJoin: () => undefined,
  openInvite: () => undefined,
  openDelete: () => undefined,
});

export function useTeamDialogs(): TeamDialogs {
  return useContext(TeamDialogsContext);
}

const noSnapshot: TeamCoordinatorSnapshot = {
  hostedTeams: [],
  intents: [],
  watching: null,
  ready: [],
};
const noSubscribe = () => () => undefined;

/** The coordinator's snapshot, or an empty one where teams open in the browser. */
export function useCoordinatorSnapshot(): TeamCoordinatorSnapshot {
  const coordinator = useTeams().coordination?.coordinator ?? null;
  return useSyncExternalStore(
    coordinator?.subscribe ?? noSubscribe,
    coordinator?.getSnapshot ?? (() => noSnapshot),
    coordinator?.getSnapshot ?? (() => noSnapshot),
  );
}

/**
 * Create, join, invite and delete, opened from wherever the person is; also where entering a team
 * navigates and where a team that became ready in the background is announced.
 */
export function TeamDialogsProvider({ children }: { readonly children: ReactNode }) {
  const { coordination, navigator } = useTeams();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState<OpenDialog | null>(null);
  useEffect(() => {
    navigator.current = (path) => {
      const team = /^\/teams\/([^/]+)\//u.exec(path)?.[1];
      void navigate(path, team ? { state: { enteredTeam: decodeURIComponent(team) } } : undefined);
    };
    return () => {
      navigator.current = null;
    };
  }, [navigate, navigator]);
  const snapshot = useCoordinatorSnapshot();
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const notice of snapshot.ready) {
      if (announced.current.has(notice.hostedTeamId)) continue;
      announced.current.add(notice.hostedTeamId);
      toast.success(`${notice.name} is ready`, {
        label: "Open",
        run: () => {
          coordination?.coordinator.dismissReady(notice.hostedTeamId);
          void navigate(teamPath(notice.teamDeploymentId, ""), {
            state: { enteredTeam: notice.teamDeploymentId },
          });
        },
        lapse: () => coordination?.coordinator.dismissReady(notice.hostedTeamId),
      });
    }
  }, [snapshot.ready, coordination, navigate, toast]);
  const dialogs = useMemo<TeamDialogs>(
    () => ({
      openCreate: () => setOpen({ kind: "create" }),
      openJoin: (url) => setOpen({ kind: "join", url }),
      openInvite: (teamId) => setOpen({ kind: "invite", teamId }),
      openDelete: (teamId) => setOpen({ kind: "delete", teamId }),
    }),
    [],
  );
  const close = () => setOpen(null);
  const watched = snapshot.hostedTeams.find((team) => team.id === snapshot.watching) ?? null;
  return (
    <TeamDialogsContext value={dialogs}>
      {children}
      {open?.kind === "create" && !watched ? <CreateTeamDialog onClose={close} /> : null}
      {watched ? <SetupDialog continued={open?.kind === "create"} team={watched} /> : null}
      {open?.kind === "join" ? <JoinDialog onClose={close} url={open.url} /> : null}
      {open?.kind === "invite" ? <InviteDialog onClose={close} teamId={open.teamId} /> : null}
      {open?.kind === "delete" ? <DeleteTeamDialog onClose={close} teamId={open.teamId} /> : null}
    </TeamDialogsContext>
  );
}

/* ---- Teams page ---- */

/** Create a hosted team or join with an invite: two choices, and self-hosting for those who want it. */
export function TeamsHome({ portalOrigin }: { readonly portalOrigin: string | null }) {
  const { coordination } = useTeams();
  const { openCreate, openJoin } = useTeamDialogs();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inviteId = useId();
  const createInBrowser = coordination === null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const invite = readTeamInvite(link);
    if (!invite) {
      setError("That isn’t an invite link. Copy the whole link and try again.");
      return;
    }
    setError(null);
    // Without in-app joining, the team's own page signs the person in and admits them.
    if (createInBrowser) window.open(link.trim(), "_blank", "noopener,noreferrer");
    else openJoin(link.trim());
  };
  return (
    <div className="teams-home">
      <header className="teams-home__head">
        <h1 className="teams-home__title">Teams</h1>
        <p className="teams-home__lede">
          Chat with your team in channels. Everyone brings their own agent, and it only works when
          its owner asks.
        </p>
      </header>
      <section aria-labelledby="teams-create" className="teams-card">
        <span aria-hidden className="teams-card__mark">
          <Icon name="plus" />
        </span>
        <div className="teams-card__text">
          <h2 className="teams-card__title" id="teams-create">
            Create a team
          </h2>
          <p className="teams-card__detail">Opensteer hosts it. Ready in about a minute.</p>
        </div>
        {createInBrowser ? (
          portalOrigin ? (
            <a
              className="btn btn--primary teams-card__action"
              href={`${portalOrigin}/teams/new`}
              rel="noreferrer"
              target="_blank"
            >
              Create
            </a>
          ) : null
        ) : (
          <button
            className="btn btn--primary teams-card__action"
            onClick={openCreate}
            type="button"
          >
            Create
          </button>
        )}
      </section>
      <section aria-labelledby="teams-join" className="teams-card teams-card--stack">
        <div className="teams-card__text">
          <h2 className="teams-card__title" id="teams-join">
            Have an invite?
          </h2>
          <p className="teams-card__detail">Paste the link someone sent you.</p>
        </div>
        <form className="teams-card__join" onSubmit={submit}>
          <label className="visually-hidden" htmlFor={inviteId}>
            Invite link
          </label>
          <input
            aria-describedby={error ? `${inviteId}-error` : undefined}
            aria-invalid={error ? true : undefined}
            autoCapitalize="none"
            autoComplete="off"
            className="text-input"
            id={inviteId}
            onChange={(event) => {
              setLink(event.currentTarget.value);
              setError(null);
            }}
            placeholder={`https://acme.${hostedTeamsDomain}/invite/…`}
            spellCheck={false}
            value={link}
          />
          <button className="btn btn--primary" disabled={!link.trim()} type="submit">
            Join
          </button>
        </form>
        {error ? (
          <p
            className="teams-field-hint teams-field-hint--error"
            id={`${inviteId}-error`}
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </section>
      <p className="teams-home__foot">
        Prefer your own server?{" "}
        <a href={selfHostGuide} rel="noreferrer" target="_blank">
          Run your own team server
        </a>
      </p>
    </div>
  );
}

/* ---- Create ---- */

type AddressState =
  | { readonly kind: "idle" | "checking" }
  | { readonly kind: "known"; readonly slug: string; readonly answer: HostedTeamAvailability };

function addressHint(
  slug: string,
  state: AddressState,
): { text: string; tone: "" | "ok" | "error" } {
  const local = localAddressHint(slug);
  if (local) return { text: local.hint, tone: slug ? "error" : "" };
  if (state.kind !== "known" || state.slug !== slug) return { text: "Checking…", tone: "" };
  return {
    text: availabilityHint(slug, state.answer),
    tone: state.answer.available ? "ok" : "error",
  };
}

function CreateTeamDialog({ onClose }: { readonly onClose: () => void }) {
  const { coordination } = useTeams();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [address, setAddress] = useState<AddressState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const slugId = useId();
  useEffect(() => {
    if (localAddressHint(slug) || !coordination) return setAddress({ kind: "idle" });
    setAddress({ kind: "checking" });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void coordination.account.hostedTeamAvailability(slug, controller.signal).then(
        (answer) => setAddress({ kind: "known", slug, answer }),
        () => {
          if (!controller.signal.aborted) setAddress({ kind: "idle" });
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug, coordination]);
  const hint = addressHint(slug, address);
  const ready =
    name.trim().length > 0 &&
    address.kind === "known" &&
    address.slug === slug &&
    address.answer.available &&
    !busy;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !coordination) return;
    const personal = coordination.personalDeploymentId();
    if (!personal) {
      setError("Your Opensteer isn’t ready yet. Try again in a moment.");
      return;
    }
    setBusy(true);
    setError(null);
    void coordination.coordinator
      .createHostedTeam({
        name: name.trim(),
        slug: slug as HostedTeamSlug,
        personalDeploymentId: personal,
      })
      .then(onClose, (failure: unknown) => {
        setBusy(false);
        setError(createRefusal(failure));
      });
  };
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!ready} form="create-team" type="submit">
            {busy ? "Creating…" : "Create team"}
          </button>
        </>
      }
      labelledBy="create-team-title"
      onClose={onClose}
      title="Create a team"
    >
      <form className="teams-form" id="create-team" onSubmit={submit}>
        <p className="teams-form__lede">
          You’ll be its owner. Opensteer runs the team server for you.
        </p>
        <div className="field">
          <label className="field__label" htmlFor={nameId}>
            Team name
          </label>
          <input
            autoComplete="off"
            autoFocus
            className="text-input"
            id={nameId}
            maxLength={120}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setName(next);
              if (!edited) setSlug(slugFromName(next));
            }}
            placeholder="Acme"
            value={name}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={slugId}>
            Address
          </label>
          <div className="teams-address">
            <input
              aria-describedby={`${slugId}-hint`}
              aria-invalid={hint.tone === "error" ? true : undefined}
              autoCapitalize="none"
              autoComplete="off"
              className="teams-address__input"
              id={slugId}
              onChange={(event) => {
                setEdited(true);
                setSlug(slugFromTyping(event.currentTarget.value));
              }}
              placeholder="acme"
              spellCheck={false}
              value={slug}
            />
            <span aria-hidden className="teams-address__domain">
              .{hostedTeamsDomain}
            </span>
          </div>
          <p
            aria-live="polite"
            className={
              hint.tone ? `teams-field-hint teams-field-hint--${hint.tone}` : "teams-field-hint"
            }
            id={`${slugId}-hint`}
          >
            {hint.text}
          </p>
        </div>
        <p className="teams-form__fine">
          Team chat, files and knowledge live on Opensteer’s servers. Everyone’s agents, files and
          logins stay on their own computers.
        </p>
        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/* ---- Setting up ---- */

function setupSteps(team: HostedTeamView) {
  const at =
    team.stage === "reserving"
      ? 0
      : team.stage === "starting" || team.stage === "configuring"
        ? 1
        : 2;
  return [
    `Reserving ${team.slug}.${hostedTeamsDomain}`,
    "Starting your team server",
    "Connecting your agent",
  ].map((label, index) => ({
    label,
    state: index < at ? "done" : index === at ? "active" : "waiting",
  }));
}

function SetupDialog({
  continued,
  team,
}: {
  readonly continued: boolean;
  readonly team: HostedTeamView;
}) {
  const coordinator = useTeams().coordination?.coordinator ?? null;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Read once: the sheet took over from Create in place, and must not enter again later.
  const [inPlace] = useState(continued);
  const failed = team.stage === "failed";
  const keepWorking = () => coordinator?.keepWorking(team.id);
  const cancel = () => {
    setBusy(true);
    void coordinator
      ?.deleteHostedTeam(team.id)
      .catch((error: unknown) => toast.error(actionErrorMessage(error)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      continued={inPlace}
      footer={
        <>
          <button
            className="btn btn--ghost teams-setup__cancel"
            disabled={busy}
            onClick={cancel}
            type="button"
          >
            Cancel setup
          </button>
          {failed ? (
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() =>
                void coordinator
                  ?.retryHostedTeam(team.id)
                  .catch((error: unknown) => toast.error(actionErrorMessage(error)))
              }
              type="button"
            >
              Try again
            </button>
          ) : (
            <button className="btn btn--primary" onClick={keepWorking} type="button">
              Keep working
            </button>
          )}
        </>
      }
      labelledBy="team-setup-title"
      onClose={keepWorking}
      title={`Setting up ${team.name}`}
    >
      <p className="teams-form__lede">
        {failed
          ? (team.error?.message ?? "Setup didn’t finish.")
          : "About a minute. You can keep working; we’ll tell you when it’s ready."}
      </p>
      <ol aria-label="Setup steps" className="teams-steps">
        {setupSteps(team).map((step) => (
          <li
            aria-current={step.state === "active" && !failed ? "step" : undefined}
            className={`teams-steps__step teams-steps__step--${failed && step.state === "active" ? "failed" : step.state}`}
            key={step.label}
          >
            <span aria-hidden className="teams-steps__dot" />
            <span>{step.label}</span>
            <span className="visually-hidden">
              {step.state === "done"
                ? " (done)"
                : step.state === "active"
                  ? failed
                    ? " (failed)"
                    : " (in progress)"
                  : ""}
            </span>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

/** Teams still being set up, while their sheet is closed; each reopens it. */
export function SetupEntries() {
  const coordinator = useTeams().coordination?.coordinator ?? null;
  const snapshot = useCoordinatorSnapshot();
  const shown = snapshot.hostedTeams.filter(
    (team) => team.id !== snapshot.watching && team.stage !== "deleting" && team.stage !== "ready",
  );
  if (!coordinator || shown.length === 0) return null;
  return (
    <ul aria-label="Teams being set up" className="teams-setup-entries">
      {shown.map((team) => (
        <li key={team.id}>
          <button
            className="teams-setup-entry"
            onClick={() => coordinator.watch(team.id)}
            type="button"
          >
            <span
              aria-hidden
              className={
                team.stage === "failed"
                  ? "teams-setup-entry__dot is-failed"
                  : "teams-setup-entry__dot"
              }
            />
            <span className="teams-setup-entry__text">
              {team.stage === "failed"
                ? `${team.name} didn’t finish setting up`
                : `Setting up ${team.name}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---- Join ---- */

type JoinState =
  | { readonly kind: "checking" }
  | {
      readonly kind: "ready";
      readonly name: string;
      readonly host: string;
      readonly joining: boolean;
      readonly error: string | null;
    }
  | { readonly kind: "failed"; readonly message: string };

function JoinDialog({ onClose, url }: { readonly onClose: () => void; readonly url: string }) {
  const { account, coordination } = useTeams();
  const [state, setState] = useState<JoinState>({ kind: "checking" });
  useEffect(() => {
    const read = readTeamInvite(url);
    if (!read || !coordination) {
      setState({
        kind: "failed",
        message: "That isn’t an invite link. Copy the whole link and try again.",
      });
      return;
    }
    const host = new URL(read.origin).host;
    let live = true;
    void coordination.coordinator.previewInvite(url).then(
      (preview) =>
        live &&
        setState({
          kind: "ready",
          name: preview.teamName ?? host.split(".")[0]!,
          host,
          joining: false,
          error: null,
        }),
      (error: unknown) => live && setState({ kind: "failed", message: actionErrorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [url, coordination]);
  const join = () => {
    if (state.kind !== "ready" || !coordination) return;
    const personal = coordination.personalDeploymentId();
    if (!personal) {
      setState({ ...state, error: "Your Opensteer isn’t ready yet. Try again in a moment." });
      return;
    }
    setState({ ...state, joining: true, error: null });
    void coordination.coordinator
      .joinWithInvite({ inviteUrl: url, personalDeploymentId: personal })
      .then(onClose, (error: unknown) =>
        setState({ ...state, joining: false, error: actionErrorMessage(error) }),
      );
  };
  const title = state.kind === "ready" ? `Join ${state.name}` : "Join a team";
  return (
    <Dialog
      footer={
        state.kind === "ready" ? (
          <>
            <button className="btn btn--ghost" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={state.joining}
              onClick={join}
              type="button"
            >
              {state.joining ? "Joining…" : `Join ${state.name}`}
            </button>
          </>
        ) : (
          <button className="btn" onClick={onClose} type="button">
            Close
          </button>
        )
      }
      labelledBy="join-team-title"
      onClose={onClose}
      title={title}
    >
      {state.kind === "checking" ? (
        <p aria-live="polite" className="teams-form__lede">
          Opening the invite…
        </p>
      ) : state.kind === "failed" ? (
        <p className="notice notice--error" role="alert">
          {state.message}
        </p>
      ) : (
        <div className="teams-join">
          <div className="teams-join__team">
            <TeamTile size={28} tile={teamTile(state.host, state.name)} />
            <span className="teams-join__host">{state.host}</span>
          </div>
          <p className="teams-form__lede">
            You’ll join as <b>{account?.email ?? "your Opensteer Account"}</b>. Your agent will be
            connected so you can ask it in threads. It stays on your computer and only acts when you
            ask.
          </p>
          {state.error ? (
            <p className="notice notice--error" role="alert">
              {state.error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

/* ---- Invite ---- */

const expiryChoices: readonly TeamInviteExpiryDays[] = [1, 7, 30];

/** The team's one reusable invite: its link, a code for phones, how long it works, and Reset. */
export function InvitePanel({ client }: { readonly client: TeamSessionClient }) {
  const toast = useToast();
  const [invite, setInvite] = useState<TeamCurrentInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const expiryId = useId();
  const linkId = useId();
  const reset = useCallback(
    async (expiresInDays: TeamInviteExpiryDays) => {
      setBusy(true);
      try {
        const result = unwrapRpcResult(
          await client.rpc["commands.dispatch"]({
            type: "team.invite.reset",
            id: TeamInviteIdSchema.parse(createId("teamInvite")),
            expiresInDays,
            maxUses: null,
          }),
        );
        if (result.type === "team.invite.reset") {
          setInvite(result.invite);
          setCopied(false);
        }
      } finally {
        setBusy(false);
      }
    },
    [client],
  );
  useEffect(() => {
    let live = true;
    void client.rpc["team.invite.current.get"]({})
      .then(unwrapRpcResult)
      .then(async ({ invite: current }) => {
        if (!live) return;
        if (current) setInvite(current);
        else await reset(7);
      })
      .catch((failure: unknown) => live && setError(actionErrorMessage(failure)));
    return () => {
      live = false;
    };
  }, [client, reset]);
  if (error)
    return (
      <p className="notice notice--error" role="alert">
        {error}
      </p>
    );
  if (!invite)
    return (
      <p aria-live="polite" className="teams-form__lede">
        Making the invite…
      </p>
    );
  const copy = () =>
    void navigator.clipboard.writeText(invite.url).then(
      () => setCopied(true),
      () => toast.error("Copy didn’t work. Select the link and copy it."),
    );
  return (
    <div className="teams-invite">
      <div className="teams-invite__qr">
        <QrCode label="QR code for the invite link" value={invite.url} />
      </div>
      <div className="teams-invite__controls">
        <div className="field">
          <label className="field__label" htmlFor={linkId}>
            Invite link
          </label>
          <div className="teams-invite__link">
            <input
              className="text-input"
              id={linkId}
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={invite.url}
            />
            <button className="btn" onClick={copy} type="button">
              <Icon name={copied ? "check" : "copy"} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <div className="teams-invite__expiry">
          <label className="field__label" htmlFor={expiryId}>
            Link works for
          </label>
          <select
            className="select-input"
            disabled={busy}
            id={expiryId}
            onChange={(event) =>
              void reset(Number(event.currentTarget.value) as TeamInviteExpiryDays)
                .then(() => toast.success("New link made"))
                .catch((failure: unknown) => toast.error(actionErrorMessage(failure)))
            }
            value={invite.expiresInDays}
          >
            {expiryChoices.map((days) => (
              <option key={days} value={days}>
                {days === 1 ? "1 day" : `${days} days`}
              </option>
            ))}
          </select>
          <span className="field__hint">Changing it makes a new link</span>
        </div>
        <button
          className="btn btn--ghost btn--small teams-invite__reset"
          disabled={busy}
          onClick={() =>
            void reset(invite.expiresInDays)
              .then(() => toast.success("New invite link made"))
              .catch((failure: unknown) => toast.error(actionErrorMessage(failure)))
          }
          type="button"
        >
          <Icon name="reload" />
          Reset link (the old one stops working)
        </button>
      </div>
    </div>
  );
}

function InviteDialog({
  onClose,
  teamId,
}: {
  readonly onClose: () => void;
  readonly teamId: string;
}) {
  const team = useTeams().teams.find((candidate) => candidate.teamId === teamId) ?? null;
  const name = useTeamSessionValue(
    team?.client ?? null,
    (snapshot) => snapshot?.bootstrap?.teamName ?? null,
  );
  return (
    <Dialog
      footer={
        <button className="btn btn--primary" onClick={onClose} type="button">
          Done
        </button>
      }
      labelledBy="invite-team-title"
      onClose={onClose}
      title={`Invite people to ${name ?? team?.name ?? "the team"}`}
    >
      <p className="teams-form__lede">
        Anyone with this link can join with their Opensteer Account.
      </p>
      {team?.client ? (
        <InvitePanel client={team.client} />
      ) : (
        <p className="notice notice--error">Open the team on this computer first.</p>
      )}
    </Dialog>
  );
}

/* ---- Your agent, and the ways out ---- */

export type AgentLine = Exclude<TeamConnectionIntentState, "no-agent"> | "none";

/** Whether this person's agent can be asked in a team, from what this device knows. */
export function useAgentLine(team: TeamAttachment | null): AgentLine {
  const snapshot = useCoordinatorSnapshot();
  if (!team) return "none";
  const intent = snapshot.intents.find((row) => row.teamDeploymentId === team.teamId);
  if (intent && intent.state !== "no-agent") return intent.state;
  if (team.link && team.link.state !== "revoked" && team.link.state !== "leaving")
    return "connected";
  return "none";
}

/** Connects this person's agent to a team they are already in. */
export function useConnectAgent(team: TeamAttachment | null): (() => void) | null {
  const { coordination } = useTeams();
  const toast = useToast();
  if (!coordination || !team) return null;
  return () => {
    const personal = coordination.personalDeploymentId();
    if (!personal) return toast.error("Your Opensteer isn’t ready yet. Try again in a moment.");
    void coordination.coordinator
      .connectAgent({
        teamDeploymentId: DeploymentIdSchema.parse(team.teamId),
        origin: team.origin,
        personalDeploymentId: personal,
      })
      .catch((error: unknown) => toast.error(actionErrorMessage(error)));
  };
}

function AgentSentence({
  line,
  onConnect,
}: {
  readonly line: AgentLine;
  readonly onConnect: (() => void) | null;
}) {
  if (line === "connected")
    return (
      <span>
        Your agent is connected. Mention <b>@your agent</b> in a thread to ask it; it runs on your
        computer and only acts when you ask.
      </span>
    );
  if (line === "connecting") return <span>Connecting your agent…</span>;
  if (line === "pending-offline")
    return <span>Your agent will connect when your computer is online.</span>;
  return (
    <span className="teams-welcome__grow">
      {line === "failed" ? "Your agent couldn’t connect." : "Your agent isn’t connected yet."}
      {onConnect ? (
        <button className="btn btn--small teams-welcome__inline" onClick={onConnect} type="button">
          {line === "failed" ? "Try again" : "Connect your agent"}
        </button>
      ) : null}
    </span>
  );
}

/** The first thing #general shows a new owner or member, until they put it away. */
export function WelcomeCard({ team }: { readonly team: TeamAttachment }) {
  const client = team.client;
  const role = useTeamSessionValue(client, (snapshot) => snapshot?.bootstrap?.member.role ?? null);
  const invites = useTeamSessionValue(
    client,
    (snapshot) => snapshot?.bootstrap?.can.manageInvites ?? false,
  );
  const name =
    useTeamSessionValue(client, (snapshot) => snapshot?.bootstrap?.teamName ?? null) ?? team.name;
  const line = useAgentLine(team);
  const connect = useConnectAgent(team);
  const { openInvite } = useTeamDialogs();
  const key = `opensteer:team-welcome:v1:${team.teamId}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  if (hidden || role === null) return null;
  const owner = role === "owner";
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(key, "1");
    } catch {
      // Shown again next time; nothing else depends on it.
    }
  };
  return (
    <section aria-labelledby={`welcome-${team.teamId}`} className="teams-welcome">
      <header className="teams-welcome__head">
        <h2 className="teams-welcome__title" id={`welcome-${team.teamId}`}>
          {owner ? `${name} is ready` : `Welcome to ${name}`}
        </h2>
        <button
          aria-label="Dismiss welcome"
          className="icon-btn icon-btn--small"
          onClick={hide}
          type="button"
        >
          <Icon name="close" />
        </button>
      </header>
      <ul className="teams-welcome__list">
        <li className="teams-welcome__row">
          <Icon name="check" />
          <span>{owner ? "You’re the owner." : "You joined as a member."}</span>
        </li>
        <li className="teams-welcome__row">
          <Icon name={line === "connected" ? "check" : "dot"} />
          <AgentSentence line={line} onConnect={connect} />
        </li>
        {invites ? (
          <li className="teams-welcome__row teams-welcome__row--todo">
            <Icon name="dot" />
            <span className="teams-welcome__grow">Invite your team</span>
            <button
              className="btn btn--small btn--primary"
              onClick={() => openInvite(team.teamId)}
              type="button"
            >
              Invite people
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** Delete a hosted team for good: the owner types its name first. */
function DeleteTeamDialog({
  onClose,
  teamId,
}: {
  readonly onClose: () => void;
  readonly teamId: string;
}) {
  const { coordination, teams } = useTeams();
  const team = teams.find((candidate) => candidate.teamId === teamId) ?? null;
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmId = useId();
  if (!team || !coordination) return null;
  const name = team.client?.getSnapshot().bootstrap?.teamName ?? team.name;
  const matches = typed.trim() === name;
  const hostedTeamId = team.client?.getSnapshot().bootstrap?.hostedTeamId ?? null;
  const remove = async () => {
    if (hostedTeamId === null) throw new Error("Only teams Opensteer hosts can be deleted here.");
    await coordination.coordinator.deleteHostedTeam(hostedTeamId);
  };
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn--danger"
            disabled={!matches || busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void remove().then(
                () => {
                  onClose();
                  void navigate("/");
                },
                (failure: unknown) => {
                  setBusy(false);
                  setError(createRefusal(failure));
                },
              );
            }}
            type="button"
          >
            {busy ? "Deleting…" : `Delete ${name}`}
          </button>
        </>
      }
      labelledBy="delete-team-title"
      onClose={onClose}
      title={`Delete ${name}?`}
    >
      <p className="teams-form__lede">
        Its channels, files and knowledge are deleted for everyone, and everyone’s agents are
        disconnected. Tasks agents did for {name} stay on each person’s computer.
      </p>
      <div className="field">
        <label className="field__label" htmlFor={confirmId}>
          Type {name} to confirm
        </label>
        <input
          autoComplete="off"
          autoFocus
          className="text-input"
          id={confirmId}
          onChange={(event) => setTyped(event.currentTarget.value)}
          value={typed}
        />
      </div>
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
