import type {
  AccountProfile,
  UpdateAccountProfileRequest,
  UpdateAccountProfileResponse,
} from "@opensteer/control-plane-protocol";

export interface AccountProfilePort {
  profile(signal?: AbortSignal): Promise<AccountProfile>;
  updateProfile(request: UpdateAccountProfileRequest): Promise<UpdateAccountProfileResponse>;
}

/** Older than this, a held receipt is read again before it is relayed. */
const maximumAgeMilliseconds = 10 * 60 * 1_000;

/**
 * The signed-in person's Account name for the team sessions on this device. Account cannot
 * reach team servers, so each session relays the receipt to its team when the team's copy is
 * older; the team verifies it. One read serves every team, and nothing is read while every copy
 * is current.
 */
export class AccountProfileRelay {
  readonly #account: AccountProfilePort;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #held: { readonly profile: AccountProfile; readonly at: number } | null = null;
  #reading: Promise<AccountProfile | null> | null = null;
  /** Bumped by every change, so a read started before it never becomes the held name. */
  #generation = 0;

  constructor(account: AccountProfilePort, now: () => number = Date.now) {
    this.#account = account;
    this.#now = now;
  }

  /** The current profile, or null when the Account cannot be reached; never throws. */
  current(): Promise<AccountProfile | null> {
    if (this.#held && this.#now() - this.#held.at < maximumAgeMilliseconds)
      return Promise.resolve(this.#held.profile);
    if (this.#reading) return this.#reading;
    const generation = this.#generation;
    const reading = this.#account
      .profile()
      .then((profile) => (generation === this.#generation ? this.#hold(profile) : profile))
      .catch(() => (generation === this.#generation ? (this.#held?.profile ?? null) : null))
      .finally(() => {
        if (this.#reading === reading) this.#reading = null;
      });
    this.#reading = reading;
    return reading;
  }

  /** The name changed here or through this person's Opensteer: read it once, then relay. */
  changed(profile?: AccountProfile): void {
    this.#generation++;
    this.#reading = null;
    this.#held = null;
    if (profile) this.#hold(profile);
    for (const listener of this.#listeners) listener();
  }

  /** Saves a name for someone with no personal Opensteer; every team session relays it. */
  async update(request: UpdateAccountProfileRequest): Promise<UpdateAccountProfileResponse> {
    const generation = this.#generation;
    const result = await this.#account.updateProfile(request);
    // Another Account signed in meanwhile: this answer is not its name.
    if (generation === this.#generation) this.changed(result.profile);
    return result;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Relays the receipt to one team when the team holds an older revision. `nameRevision`
   * undefined means the team predates names it can verify, so nothing is sent.
   */
  async relay(team: {
    readonly nameRevision: number | undefined;
    readonly apply: (receipt: AccountProfile["receipt"]) => Promise<unknown>;
  }): Promise<void> {
    if (team.nameRevision === undefined) return;
    const profile = await this.current();
    if (!profile || profile.revision <= team.nameRevision) return;
    await team.apply(profile.receipt);
  }

  #hold(profile: AccountProfile): AccountProfile {
    if (!this.#held || profile.revision >= this.#held.profile.revision)
      this.#held = { profile, at: this.#now() };
    return this.#held.profile;
  }
}
