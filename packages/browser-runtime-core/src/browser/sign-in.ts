import type {
  CardField,
  BrowserClientMessage,
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
   * Writes one released value into a bound element after rechecking it.
   * False: the element or page changed, so nothing more may be written.
   */
  readonly write: (slot: PersonFillSlot, value: string) => Promise<boolean>;
  readonly signal: AbortSignal;
}

export interface BrowserLoginAuthorizeInput {
  readonly expiresAt: Date;
  readonly operationId: string;
  readonly requester: PasswordSignInRequester;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly site: string;
  readonly workspaceId: Extract<BrowserClientMessage, { type: "login.authorize" }>["workspaceId"];
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
}
