import type { DeploymentId } from "@opensteer/core";
import type {
  CardField,
  LoginAuthorizationOutcome,
  LoginField,
  LoginFillStatus,
  PasswordSignInAvailability,
  PasswordSignInRequester,
  PersonFillAccountView,
  PersonFillPresence,
  PersonFillRole,
  PersonFillSlot,
  PersonFillStatus,
  PersonSaveStatus,
} from "@opensteer/protocol";

/** Who a person fill is for and where it lands; `origin` is the bound frame's committed origin. */
export interface PersonFillScope {
  readonly consumerToken: string;
  readonly targetId: string;
  readonly origin: string;
  readonly role: PersonFillRole;
  readonly presence: PersonFillPresence;
}

export interface PersonFillInput extends PersonFillScope {
  readonly loginId: string;
  readonly revision: number;
  /** Which bound elements exist besides the activated one. */
  readonly slots: { readonly partner: boolean; readonly group: boolean };
  /**
   * The account was offered as already confirmed, so the viewer skipped its own
   * check: fill only inside that confirmation, never begin a new one.
   */
  readonly reuseOnly: boolean;
  /**
   * Writes one released value into a bound element after rechecking it.
   * False: the element or page changed, so nothing more may be written.
   */
  readonly write: (slot: PersonFillSlot, value: string) => Promise<boolean>;
  readonly signal: AbortSignal;
}

/**
 * A login a person typed and submitted on a page, attributed to one viewer.
 * `origin` is the submitting frame's committed origin. The password goes only
 * to the authority, which hands it to the vault's broker and keeps no copy.
 */
export interface PersonSaveCandidate {
  readonly targetId: string;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly presence: PersonFillPresence;
}

/**
 * `offer`: the broker holds the login until `personSaveCommit`,
 * `personSaveCancel` or `expiresAt`. `setup`: Passwords is not set up on this
 * Mac and the person typed here. `skip`: nothing to ask.
 */
export type PersonSaveBegin =
  | {
      readonly kind: "offer";
      readonly transactionId: string;
      readonly expiresAt: number;
      /** Aborted once the broker no longer holds it: its connection went or saving turned off. */
      readonly ended: AbortSignal;
    }
  | { readonly kind: "setup" }
  | { readonly kind: "skip" };

export interface BrowserLoginAuthorizeInput {
  readonly deploymentId: DeploymentId;
  readonly expiresAt: Date;
  readonly operationId: string;
  readonly requester: PasswordSignInRequester;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly site: string;
}

/** Only the desktop's Personal runtime on macOS supplies this authority. */
export interface BrowserLoginAuthority {
  probe(input: { site: string }): Promise<PasswordSignInAvailability>;
  /** Resolves on authorization or termination; never releases a value. */
  authorize(
    input: BrowserLoginAuthorizeInput,
    signal: AbortSignal,
    needs: (need: "approval" | null) => void,
  ): Promise<
    | { kind: "authorized"; account: string; authority: AbortSignal }
    | { kind: "ended"; outcome: Exclude<LoginAuthorizationOutcome, { kind: "authorized" }> }
  >;
  fillCardReference?(input: {
    lease: AbortSignal;
    cardRef: string;
    targetId: string;
    field: CardField;
  }): Promise<LoginFillStatus>;
  fillReference?(input: {
    lease: AbortSignal;
    loginRef: string;
    targetId: string;
    field: LoginField;
  }): Promise<LoginFillStatus>;
  fill(input: {
    operationId: string;
    targetId: string;
    field: LoginField;
    lease: AbortSignal;
  }): Promise<LoginFillStatus>;
  /** Ends the broker transaction, idempotently. */
  end(operationId: string): Promise<void>;
  /**
   * A person's saved logins for the scope's site, never prompting. Empty when
   * person fill is off, not set up or unsupported by the broker.
   */
  personFillAccounts?(input: PersonFillScope): Promise<PersonFillAccountView[]>;
  /** Confirms (or reuses) the person's choice, then releases and writes each field. */
  personFill?(input: PersonFillInput): Promise<PersonFillStatus>;
  /** Never prompts and saves nothing; see `PersonSaveBegin`. */
  personSaveBegin?(input: PersonSaveCandidate): Promise<PersonSaveBegin>;
  /** Adds exactly the held login, once. */
  personSaveCommit?(transactionId: string): Promise<PersonSaveStatus>;
  personSaveCancel?(transactionId: string): void;
}
