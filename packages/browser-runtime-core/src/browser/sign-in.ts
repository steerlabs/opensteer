import type {
  BrowserClientMessage,
  LoginAuthorizationOutcome,
  LoginField,
  LoginFillStatus,
  PasswordSignInAvailability,
  PasswordSignInRequester,
} from "@opensteer/protocol";

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
}
