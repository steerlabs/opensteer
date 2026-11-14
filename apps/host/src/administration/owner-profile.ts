import type {
  AccountProfile,
  UpdateAccountProfileRequest,
} from "@opensteer/control-plane-protocol";
import { OpensteerError, type PersonName, type UserId } from "@opensteer/core";
import type { OwnerNameLink, OwnerProfile, OwnerProfileStore } from "@opensteer/database";
import type { OwnerProfileView } from "@opensteer/protocol";

/** The linked Account as this Host reaches it; null while no link is active. */
export interface OwnerProfileAccount {
  readOwnerProfile(): Promise<{ account: OwnerNameLink; profile: AccountProfile } | null>;
  /** Refused with `conflict` unless the live link is to `subject`'s Account. */
  updateOwnerProfile(
    request: UpdateAccountProfileRequest,
    subject: string,
  ): Promise<{
    account: OwnerNameLink;
    applied: boolean;
    profile: AccountProfile;
  } | null>;
}

/** Background refreshes on attach wait this long after the last one. */
const refreshIntervalMilliseconds = 5 * 60 * 1_000;

/**
 * The personal owner's name. Unlinked, this Host owns it. Linked, the Account owns it: a rename
 * is saved there first and the Host keeps the answer, and a refresh picks up a rename made
 * elsewhere. No Account request ever runs inside a Host transaction.
 */
export class OwnerProfileService {
  readonly #store: OwnerProfileStore;
  readonly #account: OwnerProfileAccount | null;
  readonly #changed: () => void;
  readonly #report: (error: unknown) => void;
  #refreshing: Promise<void> | undefined;
  /** A link changed while a refresh was reading: read again once it ends. */
  #again = false;
  #refreshedAt = Number.NEGATIVE_INFINITY;

  constructor(options: {
    readonly store: OwnerProfileStore;
    readonly account: OwnerProfileAccount | null;
    /** Tells attached clients the owner's name changed. */
    readonly changed: () => void;
    readonly report: (error: unknown) => void;
  }) {
    this.#store = options.store;
    this.#account = options.account;
    this.#changed = options.changed;
    this.#report = options.report;
  }

  async view(): Promise<OwnerProfileView | null> {
    const profile = await this.#store.read();
    return profile ? ownerProfileView(profile) : null;
  }

  /**
   * `expectedVersion` is the view's `version` when the person began editing: the Account and
   * revision they saw. A rename elsewhere since makes `applied` false and the view the newer name,
   * so the person sees it before choosing again; another Account since is refused outright.
   */
  async update(
    userId: UserId,
    name: PersonName | null,
    expectedVersion: string | null,
  ): Promise<{ readonly applied: boolean; readonly profile: OwnerProfileView }> {
    const current = await this.#store.read();
    if (!current || current.ownerId !== userId)
      throw new OpensteerError({ code: "forbidden", message: "The personal owner is required." });
    const linked = await this.#saveToAccount(current, name, expectedVersion);
    if (linked) return linked;
    const profile = await this.#store.setLocal({ userId, name });
    this.#changed();
    return { applied: true, profile: ownerProfileView(profile) };
  }

  /** Catches up with the linked Account, or detaches from one that is gone. */
  refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#again = true;
      return this.#refreshing;
    }
    const run = async (): Promise<void> => {
      let failure: unknown;
      do {
        this.#again = false;
        failure = undefined;
        // A read through an old link may fail; the one queued behind it still runs.
        await this.#refresh().catch((error: unknown) => {
          failure = error;
        });
      } while (this.#again);
      if (failure !== undefined) throw failure;
    };
    this.#refreshing = run().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** A client attached: refresh in the background unless one ran recently. */
  refreshSoon(): void {
    if (!this.#account || Date.now() - this.#refreshedAt < refreshIntervalMilliseconds) return;
    void this.refresh().catch(this.#report);
  }

  /** The owner's first name, before anyone sets one; see `OwnerProfileStore.seed`. */
  async seed(computerName: string | null): Promise<void> {
    if (await this.#store.seed(computerName)) this.#changed();
  }

  async #saveToAccount(current: OwnerProfile, name: PersonName | null, edited: string | null) {
    if (!this.#account) return null;
    let expected =
      edited !== null
        ? parseVersion(edited)
        : current.account && {
            subject: current.account.subject,
            revision: current.account.revision,
          };
    if (!expected) {
      // The person edited a name of their own, and the Host has linked since: start from the
      // Account's current one.
      const fetched = await this.#account.readOwnerProfile();
      if (!fetched) return this.#detached();
      await this.#apply(fetched.account, fetched.profile);
      expected = { subject: fetched.account.subject, revision: fetched.profile.revision };
    }
    if (name === null)
      throw new OpensteerError({
        code: "bad_request",
        message: "Your Opensteer Account needs a name. Enter the name others should see.",
      });
    const saved = await this.#account.updateOwnerProfile(
      { name, expectedRevision: expected.revision },
      expected.subject,
    );
    if (!saved) return this.#detached();
    const applied = await this.#apply(saved.account, saved.profile);
    if (applied.stale)
      throw new OpensteerError({
        code: "conflict",
        message: "Your Opensteer Account changed while saving. Check your name, then try again.",
      });
    return { applied: saved.applied, profile: ownerProfileView(applied.profile) };
  }

  /** The link ended since the name was last read: the name is the owner's own again. */
  async #detached() {
    if (await this.#store.detachAccount()) this.#changed();
    return null;
  }

  async #apply(account: OwnerNameLink, profile: AccountProfile) {
    const applied = await this.#store.applyAccount({
      account,
      name: profile.name,
      revision: profile.revision,
    });
    if (applied.changed) this.#changed();
    return applied;
  }

  async #refresh(): Promise<void> {
    if (!this.#account) return;
    this.#refreshedAt = Date.now();
    const fetched = await this.#account.readOwnerProfile();
    if (!fetched) {
      await this.#detached();
      return;
    }
    await this.#apply(fetched.account, fetched.profile);
  }
}

export function ownerProfileView(profile: OwnerProfile): OwnerProfileView {
  return {
    name: profile.name,
    accountBacked: profile.account !== null,
    version: profile.account ? `${profile.account.subject}:${profile.account.revision}` : null,
  };
}

/** The Account and revision an edit began from; opaque to clients. */
function parseVersion(version: string): { subject: string; revision: number } {
  const separator = version.lastIndexOf(":");
  const revision = Number(version.slice(separator + 1));
  if (separator <= 0 || !Number.isSafeInteger(revision) || revision < 1)
    throw new OpensteerError({ code: "bad_request", message: "The name's version is invalid." });
  return { subject: version.slice(0, separator), revision };
}
