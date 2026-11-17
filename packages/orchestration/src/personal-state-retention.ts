interface RetentionCut {
  readonly head: string;
  readonly floor: string;
  readonly nextExpiryAt: number | null;
}

const failedPruneDelayMs = 1_000;

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
    this.#schedule(cut, Math.max(0, cut.nextExpiryAt - Date.now()));
  }

  #schedule(cut: RetentionCut, delayMs: number) {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#prune().catch((error: unknown) => {
        if (this.#closed) return;
        if (this.#cut === cut && !this.#timer) this.#schedule(cut, failedPruneDelayMs);
        this.#onFailure(error);
      });
    }, delayMs);
    this.#timer.unref();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
