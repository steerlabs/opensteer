import { ClientOperationError } from "../connections/operation-error.js";

export type AccountRuntimeIdentity = { readonly issuer: string; readonly subject: string } | null;

/** Account identity owns Account-scoped work; token rotation and entry attempts have separate lifetimes. */
export class AccountRuntimeOwner {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  readonly identity: AccountRuntimeIdentity;
  constructor(identity: AccountRuntimeIdentity) {
    this.identity = identity;
  }
  matches(identity: AccountRuntimeIdentity): boolean {
    return (
      this.identity?.issuer === identity?.issuer && this.identity?.subject === identity?.subject
    );
  }
  readonly assertCurrent = (): void => {
    if (this.signal.aborted) throw this.signal.reason;
  };
  async run<Value>(work: () => Promise<Value>): Promise<Value> {
    this.assertCurrent();
    const value = await work();
    this.assertCurrent();
    return value;
  }
  retire(): void {
    if (this.signal.aborted) return;
    this.#controller.abort(new ClientOperationError("The Account identity changed.", "transient"));
  }
}
