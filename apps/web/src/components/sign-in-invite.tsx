import { useState } from "react";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { useWebRemoteAccess } from "../account/remote-access-port.js";
import { useShell } from "./app-shell.js";

function key(deploymentId: string): string {
  return `opensteer.sign-in-invite.v1:${deploymentId}`;
}

/** "Not now", for this Home: answered by the person, or by starting it without an account. */
export function declineSignInInvite(deploymentId: string): void {
  try {
    localStorage.setItem(key(deploymentId), "not-now");
  } catch {
    // Without storage it asks again next time; nothing else depends on it.
  }
}

function declined(deploymentId: string): boolean {
  try {
    return localStorage.getItem(key(deploymentId)) === "not-now";
  } catch {
    return false;
  }
}

/**
 * Whether this Mac's own Opensteer, which no Opensteer account holds, is to be invited to sign
 * in: the account can be signed in to, nobody is signed in, the person hasn't said "Not now",
 * and its Remote access is off (a Home on a private network chose its way in). "maybe" while
 * that Remote access is still being read: the card waits for "invite", and the Cloud Computer
 * suggestion is held back by either, so only one prompt is ever on screen.
 */
export function useSignInInvite(): "invite" | "maybe" | "none" {
  const { deploymentAccess, desktopBridge, desktopDeployment, hostClient } = useShell();
  const here = desktopBridge !== null && desktopDeployment?.onThisComputer === true;
  const remote = usePersonalRemoteAccess(here ? hostClient : null);
  if (!here || !deploymentAccess) return "none";
  const candidate =
    deploymentAccess.account.available &&
    deploymentAccess.account.status !== "signed-in" &&
    deploymentAccess.personalAccountLink.status === "unlinked" &&
    !declined(desktopDeployment.id);
  if (!candidate) return "none";
  if (remote.status === null) return remote.error ? "none" : "maybe";
  return remote.status.access.mode === "off" ? "invite" : "none";
}

/** Whether the invitation is, or may be about to be, the one prompt on screen. */
export function useSignInInvitePending(): boolean {
  return useSignInInvite() !== "none";
}

/**
 * One card, on an Opensteer that runs on this Mac without an account: an invitation to sign
 * in, and nothing else. Pressing it always does the same three things, and the card says them:
 * sign in, add this Mac's Opensteer to the account, turn Remote access on. "Not now" is
 * remembered, and the Opensteer keeps working as it always has.
 */
export function SignInInvite() {
  return useSignInInvite() === "invite" ? <SignInInviteCard /> : null;
}

function SignInInviteCard() {
  const { desktopDeployment, hostClient } = useShell();
  const remote = usePersonalRemoteAccess(hostClient);
  const connect = useWebRemoteAccess(remote);
  const [notNow, setNotNow] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  if (notNow || !desktopDeployment) return null;
  const name = desktopDeployment.name;
  const busy = signingIn && connect.view.tone === "busy";
  const failure = signingIn && connect.view.tone === "attention" ? connect.view.sentence : null;
  return (
    <section aria-labelledby="sign-in-invite-title" className="sign-in-invite" role="region">
      <h2 className="sign-in-invite__title" id="sign-in-invite-title">
        Use Opensteer from anywhere
      </h2>
      <p className="sign-in-invite__body">
        Sign in with your Opensteer account to add {name} to it and turn on Remote access, so your
        phone and connected agents can reach it. You can turn Remote access off in Settings.
      </p>
      {failure ? (
        <p className="sign-in-invite__body sign-in-invite__body--error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="sign-in-invite__actions">
        <button
          className="btn btn--ghost btn--small"
          onClick={() => {
            declineSignInInvite(desktopDeployment.id);
            connect.stop();
            setNotNow(true);
          }}
          type="button"
        >
          Not now
        </button>
        <button
          className="btn btn--primary btn--small"
          disabled={busy}
          onClick={() => {
            setSigningIn(true);
            connect.act("turn-on");
          }}
          type="button"
        >
          {busy ? "Finish signing in in your browser" : "Sign in"}
        </button>
      </div>
    </section>
  );
}
