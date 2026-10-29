import { MutationQueue } from "@opensteer/shared/mutationQueue";

type DesktopPersonalAccountMutationKind = "background" | "link" | "remote-access" | "unlink";

export class PersonalAccountUnlinkInProgressError extends Error {
  readonly code = "personal-account-unlink-in-progress";

  constructor() {
    super("Personal Account unlink is in progress. Wait for unlink to finish before trying again.");
    this.name = "PersonalAccountUnlinkInProgressError";
  }
}

/** One owner for every mutation that can create or revoke Account-derived
 * Personal access. An unlink request fences later Link and Connect requests as
 * soon as it is queued, rather than after its first asynchronous step. */
export class DesktopPersonalAccountMutationCoordinator {
  readonly #queue = new MutationQueue();
  #pendingUnlinks = 0;

  run<T>(kind: DesktopPersonalAccountMutationKind, operation: () => Promise<T>): Promise<T> {
    if ((kind === "link" || kind === "remote-access") && this.#pendingUnlinks > 0) {
      return Promise.reject(new PersonalAccountUnlinkInProgressError());
    }
    if (kind === "unlink") this.#pendingUnlinks += 1;
    const result = this.#queue.run(operation);
    if (kind !== "unlink") return result;
    return result.finally(() => {
      this.#pendingUnlinks -= 1;
    });
  }
}
