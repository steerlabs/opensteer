import { useEffect } from "react";
import type { RemoteAccessController } from "@opensteer/client/react";

/**
 * The one wish to turn Remote access on, from one question only: "Where should your Opensteer
 * live? › On this Mac", asked while signed in. It is held here in memory and nowhere else: for
 * the Home that choice creates, for the account that made it, and acted on at most once. It is
 * forgotten the moment the turn-on is sent, and when Setup is finished, skipped or left; a quit
 * before then loses it, and the phone step offers its button instead.
 */
interface Wish {
  readonly issuer: string;
  readonly subject: string;
  /** The Home the choice created, once this computer's setup names it. */
  deploymentId: string | null;
}

interface Account {
  readonly issuer?: string | undefined;
  readonly status: string;
  readonly subject?: string | undefined;
}

let wish: Wish | null = null;
let leaving: ReturnType<typeof setTimeout> | null = null;

/** "On this Mac", chosen while signed in as this account. */
export function wishRemoteAccessOnStart(account: Account): void {
  wish =
    account.status === "signed-in" && account.issuer && account.subject
      ? { issuer: account.issuer, subject: account.subject, deploymentId: null }
      : null;
}

/** This computer's setup named the Home the choice is creating. */
export function bindRemoteAccessOnStart(deploymentId: string): void {
  if (wish && wish.deploymentId === null) wish.deploymentId = deploymentId;
}

export function forgetRemoteAccessOnStart(): void {
  wish = null;
}

/** Whether a wish is held at all: for tests and the report, never shown. */
export function remoteAccessWishHeld(): boolean {
  return wish !== null;
}

/** The wish for this Home and this account, taken: true at most once. */
function take(deploymentId: string, account: Account | null): boolean {
  const held = wish;
  if (!held || held.deploymentId !== deploymentId || !account) return false;
  wish = null;
  return (
    account.status === "signed-in" &&
    account.issuer === held.issuer &&
    account.subject === held.subject
  );
}

/**
 * Setup's half: while Setup is open on the Home the wish names, and the account that made it is
 * signed in, Remote access is turned on with the same steps as pressing "Turn on Remote access".
 * A Home already on, or on a private network, is left as it is and the wish is dropped.
 */
export function useRemoteAccessOnStart(
  deploymentId: string | null,
  account: Account | null,
  connect: RemoteAccessController,
): void {
  // Leaving Setup forgets the wish. A remount at once (React's own checks) is not leaving.
  useEffect(() => {
    if (leaving !== null) clearTimeout(leaving);
    leaving = null;
    return () => {
      leaving = setTimeout(() => {
        leaving = null;
        forgetRemoteAccessOnStart();
      }, 0);
    };
  }, []);
  const state = connect.view.state;
  useEffect(() => {
    if (deploymentId === null || wish === null) return;
    if (state === "loading") return;
    if (state === "off" || state === "link-activating") {
      if (take(deploymentId, account)) connect.act("turn-on");
      return;
    }
    // On, turning on elsewhere, on a private network, or not this person's to change.
    forgetRemoteAccessOnStart();
  }, [account, connect, deploymentId, state]);
}
