import {
  HostedTeamOwnerCheckClaimsSchema,
  type AdoptExistingDeploymentResponse,
  type HostAccountAdoptionAuthority,
  type HostedTeamBootstrapReceipt,
  type HostedTeamOwnerCheckClaims,
} from "@opensteer/control-plane-protocol";
import type { ControlPlaneStore } from "../database/store.js";
import { ControlPlaneError } from "../server/errors.js";
import { HostedTeamHostError, type HostedTeamHost } from "./hosted-team-host.js";
import {
  HostedTeamSupersededError,
  type HostedTeamBootstrapClaim,
  type HostedTeamOwnerCheck,
  type HostedTeamStore,
} from "./hosted-team-store.js";

/** Past this, a team still setting up is reported failed so its creator can retry or cancel. */
export const hostedTeamSetupDeadlineMilliseconds = 15 * 60_000;
const pollMilliseconds = 5_000;

class PermanentSetupFailure extends Error {}

/**
 * Finishes each hosted team's setup from Account once the provisioner reports its Host
 * running: exchanges the sealed setup token at the team's own origin, adopts the Host for the
 * creator, and asks the Host to commit the creator as owner and create #general. Every step can
 * be repeated; a lost answer is recovered from Account's stored adoption result.
 */
export class HostedTeamBootstrapper {
  readonly #teams: HostedTeamStore;
  readonly #accounts: Pick<ControlPlaneStore, "adoptExistingDeployment" | "resumeAdoption">;
  readonly #host: HostedTeamHost;
  readonly #ownerCheck: HostedTeamOwnerCheck;
  readonly #issuer: string;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(input: {
    readonly teams: HostedTeamStore;
    readonly accounts: Pick<ControlPlaneStore, "adoptExistingDeployment" | "resumeAdoption">;
    readonly host: HostedTeamHost;
    readonly ownerCheck: HostedTeamOwnerCheck;
    readonly issuer: URL;
    readonly onError: (error: unknown) => void;
    readonly now?: () => number;
  }) {
    this.#teams = input.teams;
    this.#accounts = input.accounts;
    this.#host = input.host;
    this.#ownerCheck = input.ownerCheck;
    this.#issuer = input.issuer.origin;
    this.#onError = input.onError;
    this.#now = input.now ?? Date.now;
  }

  start(): void {
    this.#schedule(0);
  }

  /** Runs soon, for a team the provisioner just reported running. */
  kick(): void {
    if (this.#stopped) return;
    if (this.#running) this.#again = true;
    else this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
  }

  /** Works every team whose setup is due; answers how many attempts ran. */
  async runOnce(): Promise<number> {
    await this.#teams.failStalledSetups(
      new Date(this.#now() - hostedTeamSetupDeadlineMilliseconds),
    );
    let attempts = 0;
    for (;;) {
      const claim = await this.#teams.claimBootstrap(new Date(this.#now()));
      if (!claim) return attempts;
      attempts += 1;
      await this.#attempt(claim);
    }
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const running = this.runOnce()
        .then(() => undefined)
        .catch((error: unknown) => this.#onError(error));
      this.#running = running;
      void running.finally(() => {
        this.#running = undefined;
        const again = this.#again;
        this.#again = false;
        this.#schedule(again ? 0 : pollMilliseconds);
      });
    }, delay);
    this.#timer.unref();
  }

  async #attempt(claim: HostedTeamBootstrapClaim): Promise<void> {
    const elapsed = this.#now() - claim.configuringSince.getTime();
    try {
      if (!claim.bootstrapped) await this.#bootstrap(claim);
      else if (!(await this.#teams.settleBootstrapped(claim, this.#retryAt(claim)))) {
        if (elapsed > hostedTeamSetupDeadlineMilliseconds)
          await this.#teams.failBootstrap(claim, "Your team couldn’t reach Opensteer. Try again.");
      }
    } catch (error) {
      if (error instanceof PermanentSetupFailure) {
        await this.#teams.failBootstrap(claim, error.message);
        return;
      }
      if (error instanceof HostedTeamHostError && error.permanent) {
        this.#onError(error);
        await this.#teams.failBootstrap(claim, "Setup didn’t finish. Try again.");
        return;
      }
      if (error instanceof ControlPlaneError) {
        if (error.reason === "account-deployment-quota-exceeded") {
          await this.#teams.failBootstrap(claim, error.message);
          return;
        }
      }
      // Cancelled, retried or claimed again meanwhile: whoever changed it owns the team now.
      if (error instanceof HostedTeamSupersededError) return;
      if (!(error instanceof HostedTeamHostError)) this.#onError(error);
      if (elapsed > hostedTeamSetupDeadlineMilliseconds)
        await this.#teams.failBootstrap(claim, "Setting up took too long. Try again.");
      else await this.#teams.deferBootstrap(claim, this.#retryAt(claim));
    }
  }

  async #bootstrap(claim: HostedTeamBootstrapClaim): Promise<void> {
    if (!claim.owner) throw new PermanentSetupFailure("Verify your Account email, then try again.");
    const origin = claim.origin;
    const discovery = await this.#host.discover(origin);
    if (!discovery.hostedBootstrap) {
      throw new PermanentSetupFailure("This team server needs an update. Try again later.");
    }
    let adoption: AdoptExistingDeploymentResponse;
    if (await this.#host.setupComplete(origin)) {
      // The Host committed an owner but Account never heard back: send that completion again.
      const resumed = await this.#accounts.resumeAdoption(claim.creator, discovery.authority);
      if (!resumed) {
        // That result expired: the Host's own receipt says whether it was this setup.
        const answer = await this.#ownerCheck({
          accountId: claim.creator,
          authority: discovery.authority,
        });
        if (!answer)
          throw new HostedTeamHostError("The team server didn’t answer", { permanent: false });
        if (!answer.receipt) throw new PermanentSetupFailure("This team was set up another way.");
        await this.#record(claim, answer.receipt, discovery.authority);
        return;
      }
      adoption = resumed;
    } else {
      const token = this.#teams.openSetupToken(claim);
      if (!token) throw new PermanentSetupFailure("Setup didn’t finish. Try again.");
      const cookie = await this.#host.exchange(origin, token);
      const account = { issuer: this.#issuer, subject: claim.creator };
      const proof = await this.#host.proof(origin, cookie, account);
      if (
        !sameAuthority(proof.authority, discovery.authority) ||
        proof.account.issuer !== account.issuer ||
        proof.account.subject !== account.subject
      ) {
        throw new HostedTeamHostError("The team server proved a different identity", {
          permanent: true,
        });
      }
      adoption = await this.#accounts.adoptExistingDeployment(
        claim.creator,
        {
          name: claim.name,
          reachability: "canonical",
          authority: proof.authority,
          proof: { proofId: proof.proofId, proofCredential: proof.proofCredential },
        },
        { guard: this.#teams.adoptionGuard(claim) },
      );
    }
    const completed = await this.#host.complete(origin, {
      grant: adoption.completionGrant,
      bundle: adoption.provisioningBundle,
      hostedBootstrap: { hostedTeamId: claim.id, owner: claim.owner },
    });
    await this.#record(claim, completed.receipt, discovery.authority);
  }

  async #record(
    claim: HostedTeamBootstrapClaim,
    receipt: HostedTeamBootstrapReceipt | undefined,
    authority: HostAccountAdoptionAuthority,
  ): Promise<void> {
    if (
      !receipt ||
      receipt.hostedTeamId !== claim.id ||
      !sameAuthority(receipt.authority, authority)
    ) {
      throw new HostedTeamHostError("The team server answered for a different team", {
        permanent: true,
      });
    }
    await this.#teams.recordBootstrap(claim, { receipt });
  }

  #retryAt(claim: HostedTeamBootstrapClaim): Date {
    const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(claim.attempt, 6));
    return new Date(this.#now() + backoff);
  }
}

/**
 * Asks a hosted team's own Host whether an Account is one of its owners, and who they all are,
 * with a one-minute Account-signed question. Undefined when that Host can't answer: an older release, or
 * down.
 */
export function hostedTeamOwnerCheck(input: {
  readonly host: HostedTeamHost;
  readonly issuer: URL;
  readonly sign: (claims: HostedTeamOwnerCheckClaims) => Promise<string>;
  readonly now?: () => number;
}): HostedTeamOwnerCheck {
  const now = input.now ?? Date.now;
  return async ({ accountId, authority }) => {
    try {
      const discovery = await input.host.discover(authority.canonicalOrigin);
      if (!discovery.hostedBootstrap || !sameAuthority(discovery.authority, authority))
        return undefined;
      const issuedAt = Math.floor(now() / 1_000);
      const claims = HostedTeamOwnerCheckClaimsSchema.parse({
        tokenUse: "opensteer-hosted-team-owner-check",
        iss: input.issuer.origin,
        aud: authority.canonicalOrigin,
        sub: accountId,
        iat: issuedAt,
        exp: issuedAt + 60,
        jti: `hto_${crypto.randomUUID()}`,
        authority,
      });
      return await input.host.isOwner(authority.canonicalOrigin, await input.sign(claims));
    } catch {
      return undefined;
    }
  };
}

function sameAuthority(left: HostAccountAdoptionAuthority, right: HostAccountAdoptionAuthority) {
  return (
    left.canonicalOrigin === right.canonicalOrigin &&
    left.deploymentId === right.deploymentId &&
    left.hostInstanceId === right.hostInstanceId &&
    left.hostKeyFingerprint === right.hostKeyFingerprint
  );
}
