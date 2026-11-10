import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  TeamAccess,
  teamErrorText,
  teamInvitationVerifier,
  unwrapRpcResult,
  type HostClient,
  type InvitePreviewView,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import { BrandMark } from "../brand.js";
import { CredentialForm } from "../credential-form.js";
import { Icon } from "../icon.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { formatWhen } from "../settings/primitives.js";
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
  const [verifier] = useState(() => {
    const value = teamInvitationVerifier(window.location.hash);
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    return value;
  });
  const [preview, setPreview] = useState<InvitePreviewView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"create" | "sign-in">("create");

  useEffect(() => {
    if (!selector || snapshot.session === "checking") return;
    let alive = true;
    (verifier
      ? team.invitationExchange({ selector, verifier }).then(({ preview: next }) => next)
      : team.invitationPreview(selector)
    ).then(
      (next) => alive && setPreview(next),
      (next: unknown) => alive && setError(next),
    );
    return () => {
      alive = false;
    };
    // The session settling is the only moment worth exchanging again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector, verifier, snapshot.session === "checking"]);

  const accept = async (before?: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await before?.();
      await team.invitationAccept();
      await hostClient.refresh();
      await navigate("/", { replace: true });
    } catch (next) {
      setError(next);
    } finally {
      setPending(false);
    }
  };

  if (!preview)
    return (
      <main className={error ? "splash" : "splash splash--quiet"}>
        <div className="splash__inner">
          <BrandMark large />
          <p className="splash__detail">{error ? teamErrorText(error) : "Checking this invite…"}</p>
        </div>
      </main>
    );

  if (preview.state === "unavailable")
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

  const kind = preview.kind === "guest" ? "a guest" : "a member";
  return (
    <OnboardingCard
      description={
        <>
          {preview.inviterName} invited {preview.emailMasked} to {preview.teamName} as {kind}.
          You’ll work in {preview.teamName}’s shared projects
          {preview.kind === "guest" ? " you’re added to" : ""}. Your own Opensteer, its chats and
          accounts stay yours.
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
      {preview.state === "used" ? (
        <p className="onboarding__lead">If that was you, open {preview.teamName} and sign in.</p>
      ) : !verifier ? (
        <ErrorNotice message="This link is missing its last part. Open the whole link from your invite." />
      ) : snapshot.session === "authenticated" ? (
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
