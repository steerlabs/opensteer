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
  updateOwnerProfile(request: UpdateAccountProfileRequest): Promise<{
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
   * `expectedRevision` is the Account revision the person was looking at when they began editing,
   * so an edit begun before a rename elsewhere never overwrites it. `applied` is false then, and
   * the view is the newer name, so the person sees it before choosing again.
   */
  async update(
    userId: UserId,
    name: PersonName | null,
    expectedRevision: number | null,
  ): Promise<{ readonly applied: boolean; readonly profile: OwnerProfileView }> {
    const current = await this.#store.read();
    if (!current || current.ownerId !== userId)
      throw new OpensteerError({ code: "forbidden", message: "The personal owner is required." });
    const linked = await this.#saveToAccount(current, name, expectedRevision);
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
      do {
        this.#again = false;
        await this.#refresh();
      } while (this.#again);
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

  /** The hosting computer's name for its user; used only before anyone names the owner. */
  async seed(name: string): Promise<void> {
    if (await this.#store.seed(name)) this.#changed();
  }

  async #saveToAccount(current: OwnerProfile, name: PersonName | null, edited: number | null) {
    if (!this.#account) return null;
    let expectedRevision = edited ?? current.account?.revision;
    if (expectedRevision === undefined) {
      // The person edited a name of their own, and the Host has linked since: start from the
      // Account's current one.
      const fetched = await this.#account.readOwnerProfile();
      if (!fetched) return this.#detached();
      await this.#apply(fetched.account, fetched.profile);
      expectedRevision = fetched.profile.revision;
    }
    if (name === null)
      throw new OpensteerError({
        code: "bad_request",
        message: "Your Opensteer Account needs a name. Enter the name others should see.",
      });
    const saved = await this.#account.updateOwnerProfile({ name, expectedRevision });
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
    revision: profile.account?.revision ?? null,
  };
}
