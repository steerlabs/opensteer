interface RetentionCut {
  readonly head: string;
  readonly floor: string;
  readonly nextExpiryAt: number | null;
}

export class PersonalRetentionDeadline {
  readonly #prune: () => Promise<void>;
  readonly #onFailure: (error: unknown) => void;
  #cut: RetentionCut | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(prune: () => Promise<void>, onFailure: (error: unknown) => void) {
    this.#prune = prune;
    this.#onFailure = onFailure;
  }

  update(cut: RetentionCut) {
    if (this.#closed) return;
    const prior = this.#cut;
    if (
      prior &&
      (BigInt(prior.head) > BigInt(cut.head) ||
        (prior.head === cut.head && BigInt(prior.floor) > BigInt(cut.floor)))
    )
      return;
    this.#cut = cut;
    if (this.#timer && prior?.nextExpiryAt === cut.nextExpiryAt) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (cut.nextExpiryAt === null) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        void this.#prune().catch((error) => {
          if (!this.#closed) this.#onFailure(error);
        });
      },
      Math.max(0, cut.nextExpiryAt - Date.now()),
    );
    this.#timer.unref();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
