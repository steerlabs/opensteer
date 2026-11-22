import { useState } from "react";
import { remoteAccessOnWhenSignedInStart } from "@opensteer/client/host";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { useWebRemoteAccess } from "../account/remote-access-port.js";
import { useShell } from "./app-shell.js";

function key(deploymentId: string): string {
  return `opensteer.sign-in-invite.v1:${deploymentId}`;
}

function declined(deploymentId: string): boolean {
  try {
    return localStorage.getItem(key(deploymentId)) === "not-now";
  } catch {
    return false;
  }
}

/**
 * Whether this Mac's own Opensteer, which no Opensteer account holds, is still to be invited
 * to sign in: the account can be signed in to, nobody is signed in, and the person hasn't
 * said "Not now". While it is, the invitation is the one prompt: the Cloud Computer suggestion
 * waits.
 */
export function useSignInInvitePending(): boolean {
  const { deploymentAccess, desktopBridge, desktopDeployment } = useShell();
  const here = desktopBridge !== null && desktopDeployment?.onThisComputer === true;
  if (!here || !deploymentAccess) return false;
  return (
    deploymentAccess.account.available &&
    deploymentAccess.account.status !== "signed-in" &&
    deploymentAccess.personalAccountLink.status === "unlinked" &&
    !declined(desktopDeployment.id)
  );
}

/**
 * One card, on an Opensteer that runs on this Mac without an account: an invitation to sign
 * in, and nothing else. Signing in adds this Mac's Opensteer to the account and, with
 * `remoteAccessOnWhenSignedInStart`, turns Remote access on, so the phone and connected agents
 * reach it. "Not now" is remembered, and the Opensteer keeps working as it always has.
 */
export function SignInInvite() {
  const pending = useSignInInvitePending();
  return pending ? <SignInInviteCard /> : null;
}

function SignInInviteCard() {
  const { desktopBridge, desktopDeployment, hostClient } = useShell();
  const remote = usePersonalRemoteAccess(hostClient);
  const connect = useWebRemoteAccess(remote);
  const [notNow, setNotNow] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  if (notNow || !desktopDeployment) return null;
  const name = desktopDeployment.name;
  const busy = signingIn && connect.view.tone === "busy";
  const failure = signingIn && connect.view.tone === "attention" ? connect.view.sentence : null;
  const signIn = () => {
    setSigningIn(true);
    if (remoteAccessOnWhenSignedInStart) connect.act("turn-on");
    else void desktopBridge?.signIn().catch(() => undefined);
  };
  return (
    <section aria-labelledby="sign-in-invite-title" className="sign-in-invite" role="region">
      <h2 className="sign-in-invite__title" id="sign-in-invite-title">
        Use Opensteer from anywhere
      </h2>
      <p className="sign-in-invite__body">
        Sign in with your Opensteer account so your phone and connected agents can reach {name}.
        Nothing else changes.
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
            try {
              localStorage.setItem(key(desktopDeployment.id), "not-now");
            } catch {
              // Without storage it asks again next time; nothing else depends on it.
            }
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
          onClick={signIn}
          type="button"
        >
          {busy ? "Finish signing in in your browser" : "Sign in"}
        </button>
      </div>
    </section>
  );
}
