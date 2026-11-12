import { useState } from "react";
import { QrCode } from "../first-run/qr-code.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { AgentOrb } from "../workspace/task-mark.js";
import { PersonAvatar, TeamTile } from "./team-marks.js";
import { plural, type PersonView, type TeamTileView } from "./team-models.js";
import { TeamProblemCard, type TeamProblem, type TeamProblemActions } from "./team-status.js";

export interface InviteView {
  readonly team: TeamTileView;
  /** Who made the link, when the team says. */
  readonly inviter: PersonView | null;
  readonly memberCount: number;
}

const downloads = [
  ["laptop", "Mac"],
  ["desktop", "Windows"],
  ["phone", "iPhone"],
  ["phone", "Android"],
] as const;

/**
 * The invite link in any browser, served by the team. It works whether or
 * not Opensteer is installed: open it in the app, or continue on the web.
 */
export function InvitePage({
  invite,
  onContinueInBrowser,
  onDownload,
  onOpenInApp,
  problem = null,
  problemActions = {},
}: {
  readonly invite: InviteView;
  readonly onContinueInBrowser: () => void;
  readonly onDownload: (platform: (typeof downloads)[number][1]) => void;
  readonly onOpenInApp: () => void;
  /** An expired or used link says so before anyone signs in. */
  readonly problem?: TeamProblem | null;
  readonly problemActions?: TeamProblemActions;
}) {
  return (
    <main className="join-page">
      {problem ? (
        <TeamProblemCard actions={problemActions} problem={problem} team={invite.team} />
      ) : (
        <div className="join-page__card">
          <TeamTile size={56} tile={invite.team} />
          <h1 className="join-page__title">Join {invite.team.name}</h1>
          <p className="join-page__lead">
            {invite.inviter ? (
              <>
                <PersonAvatar person={invite.inviter} size={18} />
                {invite.inviter.name} invited you.{" "}
              </>
            ) : null}
            {plural(invite.memberCount, "person", "people")}{" "}
            {invite.memberCount === 1 ? "is" : "are"} here.
          </p>
          <button className="btn btn--primary join-page__wide" onClick={onOpenInApp} type="button">
            Open in Opensteer
          </button>
          <button className="btn join-page__wide" onClick={onContinueInBrowser} type="button">
            Continue in this browser
          </button>
          <p className="join-page__quiet">Don’t have Opensteer?</p>
          <div className="join-page__downloads">
            {downloads.map(([icon, label]) => (
              <button
                className="btn btn--small"
                key={label}
                onClick={() => onDownload(label)}
                type="button"
              >
                <Icon name={icon} />
                {label}
              </button>
            ))}
          </div>
          <p className="join-page__note">
            You’ll sign in with your Opensteer Account. After installing, open this link again to
            finish joining.
          </p>
        </div>
      )}
    </main>
  );
}

/**
 * In the app: one confirm, then the team is in the sidebar. It says who joins,
 * that their agent stays on their own computers, and what the team can see.
 */
export function JoinTeamDialog({
  invite,
  joining = false,
  me,
  account,
  onCancel,
  onJoin,
}: {
  readonly invite: InviteView;
  readonly joining?: boolean;
  readonly me: PersonView;
  /** The Opensteer Account they join as, shown masked. */
  readonly account: string;
  readonly onCancel: () => void;
  readonly onJoin: () => void;
}) {
  const name = invite.team.name;
  return (
    <Dialog
      footer={
        <>
          <button className="btn btn--ghost" onClick={onCancel} type="button">
            Not now
          </button>
          <button
            aria-disabled={joining}
            className="btn btn--primary"
            onClick={() => {
              if (!joining) onJoin();
            }}
            type="button"
          >
            {joining ? "Joining…" : `Join ${name}`}
          </button>
        </>
      }
      labelledBy="join-team-title"
      onClose={onCancel}
      title={
        <span className="join-dialog__title">
          <TeamTile size={28} tile={invite.team} />
          Join {name}?
        </span>
      }
    >
      <p className="join-dialog__lead">
        {invite.inviter ? `${invite.inviter.name} invited you. ` : ""}
        {plural(invite.memberCount, "person", "people")} {invite.memberCount === 1 ? "is" : "are"}{" "}
        here.
      </p>
      <div className="join-dialog__facts">
        <div className="join-dialog__fact">
          <PersonAvatar person={me} size={24} />
          <span>
            <span className="join-dialog__strong">{me.name}</span>
            <span className="join-dialog__quiet">Opensteer Account · {account}</span>
          </span>
        </div>
        <div className="join-dialog__fact">
          <AgentOrb size={22} />
          <span className="join-dialog__quiet">
            Your agent stays on your computers. {name} sees only what you, or your agent when you
            ask it, post there. Admins can see what agents read, searched and posted in {name}.
          </span>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The page the team's setup link opens. Signing in with an Opensteer Account
 * makes that person the team's owner; the next thing they need is people.
 */
export function FirstOwnerSetup({
  copied = false,
  inviteUrl,
  onCopy,
  onOpenTeam,
  onSignIn,
  signingIn = false,
  step,
  team,
}: {
  readonly copied?: boolean;
  readonly inviteUrl: string | null;
  readonly onCopy: () => void;
  readonly onOpenTeam: () => void;
  readonly onSignIn: () => void;
  readonly signingIn?: boolean;
  readonly step: "sign-in" | "invite";
  readonly team: TeamTileView;
}) {
  return (
    <main className="join-page">
      <div className="join-page__card">
        <TeamTile size={56} tile={team} />
        {step === "sign-in" ? (
          <>
            <h1 className="join-page__title">Set up {team.name}</h1>
            <p className="join-page__lead">
              This link was made when {team.name}’s server was installed. Whoever opens it first and
              signs in becomes its owner.
            </p>
            <button
              aria-disabled={signingIn}
              className="btn btn--primary join-page__wide"
              onClick={() => {
                if (!signingIn) onSignIn();
              }}
              type="button"
            >
              {signingIn ? "Signing in…" : "Sign in with Opensteer Account"}
            </button>
            <p className="join-page__note">
              The server keeps the team’s channels, files and knowledge. It runs no agents and holds
              no one’s passwords; each person’s agent stays on their own computer.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow eyebrow--accent">You’re the owner</p>
            <h1 className="join-page__title">Invite people to {team.name}</h1>
            <p className="join-page__lead">
              Each person joins with their own Opensteer Account and brings their own agent.
            </p>
            {inviteUrl ? (
              <div className="invite-link">
                <div className="invite-link__row">
                  <span className="invite-link__url">
                    <Icon name="link" />
                    <span>{inviteUrl}</span>
                  </span>
                  <button className="btn btn--small" onClick={onCopy} type="button">
                    <Icon name={copied ? "check" : "copy"} />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <QrCode label={`Invite link for ${team.name}`} value={inviteUrl} />
                <p className="join-page__note">
                  Anyone with this link can join as a member. Turn it off or make a new one in Team
                  settings → Invites.
                </p>
              </div>
            ) : (
              <p className="join-page__quiet">Making the invite link…</p>
            )}
            <button className="btn btn--primary join-page__wide" onClick={onOpenTeam} type="button">
              Open {team.name}
            </button>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * Asking your agent needs this team connected to your own Opensteer. In the
 * app that is one press. On the team's web page, the person copies a short
 * link and pastes it in their Opensteer, which redeems it.
 */
export function ConnectOpensteerCard({
  code,
  onConnect,
  onCreateCode,
  team,
}: {
  /** The web form's one-time link, valid for ten minutes. */
  readonly code?: string | null | undefined;
  /** In the app: connects directly. */
  readonly onConnect?: (() => void) | undefined;
  /** On the web: makes the link to paste. */
  readonly onCreateCode?: (() => void) | undefined;
  readonly team: TeamTileView;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="opensteer-connect">
      <AgentOrb size={28} />
      <div className="opensteer-connect__body">
        <h2 className="opensteer-connect__title">Connect your Opensteer</h2>
        <p className="opensteer-connect__text">
          Your agent works in your own Opensteer, on your computer. Connect it to {team.name} to ask
          it in channels. Your tasks stay on your computer; {team.name} sees only what your agent
          posts.
        </p>
        {onConnect ? (
          <button className="btn btn--small btn--primary" onClick={onConnect} type="button">
            Connect
          </button>
        ) : code ? (
          <div className="invite-link__row">
            <code className="invite-link__url">{code}</code>
            <button
              className="btn btn--small"
              onClick={() => {
                void navigator.clipboard.writeText(code).then(() => setCopied(true));
              }}
              type="button"
            >
              <Icon name={copied ? "check" : "copy"} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : onCreateCode ? (
          <button className="btn btn--small btn--primary" onClick={onCreateCode} type="button">
            Get a link for your Opensteer
          </button>
        ) : null}
        {code ? (
          <p className="opensteer-connect__note">
            Paste it in your Opensteer under Settings → Join a team. It works once, for 10 minutes.
          </p>
        ) : null}
      </div>
    </section>
  );
}
