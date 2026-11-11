import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  TeamAccess,
  openTeamJoin,
  teamErrorText,
  teamInvitationVerifier,
  unwrapRpcResult,
  type HostClient,
  type TeamJoinState,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { BrandMark } from "../brand.js";
import { CredentialForm } from "../credential-form.js";
import { Icon } from "../icon.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { formatWhen } from "../settings/primitives.js";
import { CopyButton } from "./team-people.js";
import { TeamMark } from "./team-ui.js";

/**
 * The page an invite link opens, before its person is a member. The verifier
 * rides in the fragment, is read once, and leaves the address bar at once.
 */
export function TeamJoinRoute({ hostClient }: { readonly hostClient: HostClient }) {
  const { selector = "" } = useParams();
  const navigate = useNavigate();
  const { snapshot } = useHostSnapshot(hostClient);
  const team = useMemo(() => new TeamAccess(hostClient), [hostClient]);
  const [verifier] = useState(() => teamInvitationVerifier(window.location.hash));
  const [state, setState] = useState<TeamJoinState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"create" | "sign-in">("create");
  const [joined, setJoined] = useState(false);
  const opened = useRef(false);
  const settled = snapshot.session !== "checking";
  const authenticated = snapshot.session === "authenticated";

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const finish = async () => {
    await hostClient.refresh();
    setJoined(true);
  };

  // Opened once the session has settled. A return from sign-in is a new
  // page: it has no verifier, and joins on the Host's proof alone.
  useEffect(() => {
    if (!selector || !settled || opened.current) return;
    opened.current = true;
    openTeamJoin(team, { selector, verifier, authenticated }).then((next) => {
      setState(next);
      if (next.kind === "joined") void finish();
    }, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector, settled]);

  const accept = async (before?: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await before?.();
      await team.invitationAccept();
      await finish();
    } catch (next) {
      setError(next);
    } finally {
      setPending(false);
    }
  };

  if (joined) {
    const teamName = snapshot.identityConfig?.deployment.name ?? "the team";
    const address = window.location.origin;
    return (
      <OnboardingCard
        description={`Open ${teamName} here, or in the Opensteer app.`}
        eyebrow={
          <span className="team-join__eyebrow">
            <TeamMark name={teamName} /> Joined
          </span>
        }
        title={`You’re in ${teamName}`}
        titleId="team-join-heading"
      >
        <div className="onboarding__form">
          <button
            className="btn btn--primary"
            onClick={() => void navigate("/", { replace: true })}
            type="button"
          >
            Open {teamName}
            <Icon name="arrow-right" />
          </button>
          <div className="team-join__app">
            <span className="field__label">Use the Opensteer app</span>
            <span className="field__hint">
              In the app, choose Add a server by address, enter this address, and sign in as
              yourself.
            </span>
            <div className="team-join__address">
              <code>{address}</code>
              <CopyButton label="Copy address" text={address} />
            </div>
          </div>
        </div>
      </OnboardingCard>
    );
  }

  if (!state || state.kind === "joined")
    return (
      <main className={error ? "splash" : "splash splash--quiet"}>
        <div className="splash__inner">
          <BrandMark large />
          <p className="splash__detail">
            {error
              ? teamErrorText(error)
              : state?.kind === "joined"
                ? "Joining…"
                : "Checking this invite…"}
          </p>
        </div>
      </main>
    );

  if (state.kind === "unavailable")
    return (
      <OnboardingCard
        description="It may have expired, been used, or been revoked. Ask the person who invited you for a new link."
        eyebrow="Invitation"
        title="This invite can’t be used"
        titleId="team-join-heading"
      >
        {null}
      </OnboardingCard>
    );

  const { preview } = state;
  const kind = preview.kind === "guest" ? "a guest" : "a member";
  return (
    <OnboardingCard
      description={
        <>
          {preview.inviterName} invited {preview.emailMasked} to {preview.teamName} as {kind}.
          You’ll work in {preview.teamName}’s shared projects
          {preview.kind === "guest" ? " you’re added to" : ""}, and you and your agents can reach{" "}
          {preview.teamName}’s computer and its network. Your own Opensteer, its chats and accounts
          stay yours.
        </>
      }
      eyebrow={
        <span className="team-join__eyebrow">
          <TeamMark name={preview.teamName} /> Invitation
        </span>
      }
      footnote={
        <>
          <Icon name="key" />
          <span>
            {preview.state === "used"
              ? "This invite has been used."
              : `It works once, only for ${preview.emailMasked}, until ${formatWhen(preview.expiresAt)}.`}
          </span>
        </>
      }
      title={`Join ${preview.teamName}`}
      titleId="team-join-heading"
    >
      {state.kind === "used" ? (
        <p className="onboarding__lead">If that was you, open {preview.teamName} and sign in.</p>
      ) : state.kind === "missing-link" ? (
        <ErrorNotice message="This link is missing its last part. Open the whole link from your invite." />
      ) : state.kind === "ready" || authenticated ? (
        <div className="onboarding__form">
          <ErrorNotice message={error ? teamErrorText(error, preview.teamName) : null} />
          <button
            className="btn btn--primary"
            disabled={pending}
            onClick={() => void accept()}
            type="button"
          >
            {pending ? "Joining…" : `Join ${preview.teamName}`}
            <Icon name="arrow-right" />
          </button>
        </div>
      ) : (
        <CredentialForm
          busy={pending}
          config={preview.signIn}
          error={error ? teamErrorText(error, preview.teamName) : null}
          footer={
            <p className="onboarding__switch">
              <button
                disabled={pending}
                onClick={() => setMode((current) => (current === "create" ? "sign-in" : "create"))}
                type="button"
              >
                {mode === "create" ? "I already have an account" : "Create a new account"}
              </button>
            </p>
          }
          idPrefix="team-join"
          mode={mode}
          onOidc={(providerId) =>
            void hostClient.rpc["auth.oidc.begin"]({ providerId, returnPath: `/join/${selector}` })
              .then(unwrapRpcResult)
              .then(({ redirectUrl }) => window.location.assign(redirectUrl))
              .catch(setError)
          }
          onSubmit={(values) => {
            const email = String(values.get("email") ?? "").trim();
            const password = String(values.get("password") ?? "");
            if (!email || !password) return;
            void accept(async () => {
              unwrapRpcResult(
                await hostClient.rpc[
                  mode === "create" ? "auth.password.signUp" : "auth.password.signIn"
                ]({
                  email,
                  password,
                }),
              );
              await hostClient.refresh();
            });
          }}
          pendingLabel="Joining…"
          submitLabel={mode === "create" ? `Create account and join` : `Sign in and join`}
        />
      )}
    </OnboardingCard>
  );
}

export function isTeamJoinPath(pathname: string): boolean {
  return /^\/join\/[A-Za-z0-9_-]{24,96}$/u.test(pathname);
}
