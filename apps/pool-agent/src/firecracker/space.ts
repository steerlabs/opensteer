/**
 * Space on the saved-state array that writes in progress have claimed but not yet used: a save
 * checks free space minus every other save's claim, and holds its own claim until it ends.
 */
export class SpaceLedger {
  #reserved = 0;

  get reserved(): number {
    return this.#reserved;
  }

  /** Claims `bytes` of `available`, or throws if other claims leave too little. */
  reserve(available: number, bytes: number): () => void {
    if (available - this.#reserved < bytes)
      throw new Error("The saved-state array has no room for this guest.");
    this.#reserved += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved -= bytes;
    };
  }
}
