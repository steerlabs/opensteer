import type { z } from "zod";
import type {
  PluginOAuthClientChoiceSchema,
  PluginOAuthMethodsSchema,
  PluginOAuthStartSchema,
  PluginOAuthStatusSchema,
  PluginRequirementTarget,
} from "@opensteer/protocol";
import {
  authorizationStatusReturned,
  authorizationTerminalStatuses,
  waitForAuthorizationAttempt,
} from "../host/authorization-attempt.js";
import { HostClientRequestError, type HostClient } from "../host/client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "../host/host-session-client.js";

/**
 * Signing in to an account for one plugin requirement. The Host prepares a
 * connection with the consent and the ways in it offers; the person picks one;
 * begin carries that consent and the method's review back unchanged; the
 * surface opens the provider's page and brings it back; the Host's own status
 * says how it ended. Closing the screen is not cancelling: only `cancel` is.
 */
export type PluginOAuthMethods = z.infer<typeof PluginOAuthMethodsSchema>;
export type PluginOAuthStatus = z.infer<typeof PluginOAuthStatusSchema>;
export type PluginOAuthStart = z.infer<typeof PluginOAuthStartSchema>;
export type PluginOAuthClientChoice = z.infer<typeof PluginOAuthClientChoiceSchema>;
export type PluginSignInHost = Pick<HostClient, "rpc" | "dispatch">;
export type PluginAttemptId = PluginOAuthStatus["attemptId"];

/* ---- What the person chooses from ---- */

export interface PluginSignInOption {
  /** Unique within one preparation. */
  readonly key: string;
  readonly kind: "one-click" | "saved-app" | "automatic";
  readonly method: string;
  readonly review: string;
  readonly label: string;
  readonly detail: string | null;
  readonly scopes: readonly string[];
  /** What begin names as the client; null uses the method's own (one-click). */
  readonly client: PluginOAuthClientChoice | null;
  /** A saved app the person can forget from here. */
  readonly savedApp: string | null;
}

/** Entering an OAuth app the person registered at the provider themselves. */
export interface PluginOwnAppForm {
  readonly method: string;
  readonly review: string;
  /** The exact address to register at the provider. */
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Whether the provider wants a client secret with the id. */
  readonly secret: "required" | "optional" | "none";
}

export interface PluginSignInChoices {
  readonly connection: string;
  /** Sent back unchanged with begin. */
  readonly consent: PluginOAuthMethods["consent"];
  readonly options: readonly PluginSignInOption[];
  readonly ownApp: PluginOwnAppForm | null;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The browser sign-ins a preparation offers, best first. API keys are offered by the review. */
export function pluginSignInChoices(
  prepared: PluginOAuthMethods,
  providerName: string,
): PluginSignInChoices {
  const options: PluginSignInOption[] = [];
  let ownApp: PluginOwnAppForm | null = null;
  for (const entry of prepared.methods) {
    const setup = entry.setup;
    if (setup.kind !== "oauth2" || setup.grant !== "authorization_code") continue;
    const scopes = strings(setup.scopes);
    const base = { method: entry.method, review: entry.review, scopes };
    if (entry.oneClick) {
      const firstParty =
        setup.firstParty && typeof setup.firstParty === "object" && !Array.isArray(setup.firstParty)
          ? text(setup.firstParty.label)
          : null;
      options.push({
        ...base,
        key: `${entry.method}:one-click`,
        kind: "one-click",
        label: `Sign in with ${providerName}`,
        detail: firstParty
          ? `Uses ${firstParty}, Opensteer's own app. The account stays on this computer.`
          : "Uses Opensteer's own app. The account stays on this computer.",
        client: null,
        savedApp: null,
      });
    }
    for (const saved of Array.isArray(setup.clients) ? setup.clients : []) {
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) continue;
      const id = text(saved.id);
      const clientId = text(saved.clientId);
      if (!id || !clientId) continue;
      const registered = saved.source === "registered";
      options.push({
        ...base,
        key: `${entry.method}:saved:${id}`,
        kind: "saved-app",
        label: registered ? "Use the app registered earlier" : `Use your app ${clientId}`,
        detail: registered
          ? `Registered automatically as ${clientId}.`
          : saved.hasSecret === true
            ? "Saved with its client secret."
            : "Saved without a client secret.",
        client: { id },
        savedApp: id,
      });
    }
    if (setup.mode === "automatic")
      options.push({
        ...base,
        key: `${entry.method}:automatic`,
        kind: "automatic",
        label: "Sign in with automatic setup",
        detail: `${providerName} lets Opensteer register its own app for this computer.`,
        client: { automatic: true },
        savedApp: null,
      });
    ownApp ??= {
      ...base,
      redirectUri: prepared.redirectUri,
      secret:
        setup.tokenEndpointAuthMethod === "none"
          ? "none"
          : setup.tokenEndpointAuthMethod === undefined
            ? "optional"
            : "required",
    };
  }
  return { connection: prepared.connection, consent: prepared.consent, options, ownApp };
}

/* ---- How a surface opens the provider and brings it back ---- */

/** What begin tells the Host about the way back. */
export interface PluginSignInRoute {
  readonly returnPath: string;
  readonly finish?: "app";
  readonly appReturnPort?: number;
}
/** One sign-in's trip through the browser on this surface. */
export interface PluginSignInLaunch {
  route(): Promise<PluginSignInRoute>;
  /**
   * Opens the provider's page for the started attempt. Resolves once it is open,
   * or, where the browser returns to this call, once that return was delivered.
   * Rejects with `PluginSignInDismissed` when the person closed the browser's
   * own sign-in sheet, which ends the sign-in.
   */
  launch(started: PluginOAuthStart): Promise<void>;
  /** The attempt never started: close anything `open` opened. */
  abandon(): void;
}
export interface PluginSignInSurface {
  readonly surface: "web" | "desktop" | "native";
  /**
   * Called inside the person's click, before anything is awaited, so a browser
   * can open its window while it still may.
   */
  open(): PluginSignInLaunch;
}

/** The person closed the system sign-in sheet. */
export class PluginSignInDismissed extends Error {
  constructor() {
    super("Sign-in was closed.");
  }
}

/* ---- Returns ---- */

/**
 * Hands an app return's one-use proof to the Host and wakes anything waiting on
 * this attempt with the Host's answer.
 */
export async function returnPluginAuthorization(
  client: PluginSignInHost,
  attemptId: PluginAttemptId,
  returnProof: string,
): Promise<PluginOAuthStatus> {
  const result = await client.dispatch({
    type: "plugin.authorization.return",
    idempotencyKey: `plugin-auth-return:${attemptId}`,
    attemptId,
    returnProof,
  });
  if (result.type !== "plugin.authorization.return")
    throw new Error("The Host answered a different command.");
  const { type: _type, ...status } = result;
  authorizationStatusReturned(client, attemptId, status);
  return status;
}

/** Reads a plugin attempt until it ends. On web this read is what finishes an Account-proven result. */
export function waitForPluginAuthorization(input: {
  readonly client: Pick<HostClient, "rpc">;
  readonly attemptId: PluginAttemptId;
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
  readonly pollIntervalMilliseconds?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<PluginOAuthStatus> {
  const { client, ...rest } = input;
  return waitForAuthorizationAttempt<PluginOAuthStatus>({
    ...rest,
    client,
    read: async () =>
      unwrapRpcResult(await client.rpc["plugin.authorization.get"]({ attemptId: input.attemptId })),
    expired: (status) => ({ ...status, status: "expired", failureCode: null }),
  });
}

/* ---- What a person is told ---- */

export type PluginSignInEnd =
  | { readonly kind: "completed"; readonly account: string }
  | {
      readonly kind:
        | "denied"
        | "failed"
        | "expired"
        | "cancelled"
        /** The Host is reached remotely and must be linked to an Account first. */
        | "account-link-required"
        /** What the person reviewed changed; prepare again. */
        | "review-changed"
        | "error";
      readonly message: string;
    };

/** One sentence for a failure code the Host recorded; codes it adds later read as the generic one. */
export function pluginSignInFailure(failureCode: string | null): string {
  switch (failureCode) {
    case "account-link-mismatch":
      return "Your Opensteer Account link changed during sign-in. Sign in again.";
    case "plugin-declaration-changed":
      return "The plugin changed what it asks for during sign-in. Review it and sign in again.";
    case "scope-escalation":
      return "The service didn't grant every permission the plugin needs. Sign in again and approve them all.";
    case "client-rejected":
      return "The service rejected the OAuth app. Check its client ID, secret and registered address.";
    case "grant-rejected":
      return "The service rejected the sign-in. Start again.";
    case "invalid-provider-response":
      return "The service answered the sign-in in a way Opensteer can't use. Try again.";
    case "provider-exchange-failed":
    case "exchange-failed":
      return "The service couldn't finish the sign-in. Try again.";
    default:
      return "The sign-in didn't finish. Try again.";
  }
}

export function pluginSignInEnd(status: PluginOAuthStatus): PluginSignInEnd {
  switch (status.status) {
    case "completed":
      return status.account
        ? { kind: "completed", account: status.account }
        : { kind: "failed", message: pluginSignInFailure(null) };
    case "denied":
      return { kind: "denied", message: "You didn't approve access at the service." };
    case "expired":
      return { kind: "expired", message: "The sign-in took too long and expired. Start again." };
    case "cancelled":
      return { kind: "cancelled", message: "Sign-in was cancelled." };
    case "failed":
      return { kind: "failed", message: pluginSignInFailure(status.failureCode) };
    default:
      return { kind: "error", message: "The sign-in is still open." };
  }
}

/** A refused prepare or begin, as what the person can do about it. */
export function pluginSignInRefusal(
  error: unknown,
): Exclude<PluginSignInEnd, { kind: "completed" }> {
  const reason = error instanceof HostClientRequestError ? error.reason : undefined;
  if (reason === "plugin-account-link-required")
    return {
      kind: "account-link-required",
      message:
        "This computer must be linked to an Opensteer Account before you can sign in from here.",
    };
  if (reason === "plugin-consent-changed")
    return {
      kind: "review-changed",
      message: "What this sign-in asks for changed. Review it again before signing in.",
    };
  if (reason === "account-link-mismatch")
    return { kind: "failed", message: pluginSignInFailure("account-link-mismatch") };
  return {
    kind: "error",
    message: error instanceof Error && error.message ? error.message : "Sign-in couldn't start.",
  };
}

/* ---- One sign-in, step by step ---- */

export type PluginSignInState =
  | { readonly step: "preparing" }
  | { readonly step: "choosing"; readonly choices: PluginSignInChoices }
  | { readonly step: "starting"; readonly choices: PluginSignInChoices; readonly key: string }
  | {
      readonly step: "waiting";
      readonly choices: PluginSignInChoices;
      readonly key: string;
      readonly attemptId: PluginAttemptId;
      readonly expiresAt: string;
      readonly cancelling: boolean;
    }
  | { readonly step: "ended"; readonly end: PluginSignInEnd };

export type PluginSignInPick =
  | { readonly option: PluginSignInOption }
  | {
      readonly ownApp: {
        readonly clientId: string;
        readonly clientSecret?: string;
        /** Remember the app for later sign-ins. */
        readonly save: boolean;
      };
    };

export class PluginSignInFlow {
  readonly #client: PluginSignInHost;
  readonly #surface: PluginSignInSurface;
  readonly #target: PluginRequirementTarget;
  readonly #providerName: string;
  readonly #pollIntervalMilliseconds: number | undefined;
  readonly #listeners = new Set<() => void>();
  #state: PluginSignInState = { step: "preparing" };
  #waiting: AbortController | null = null;
  #closed = false;
  #generation = 0;

  constructor(options: {
    readonly client: PluginSignInHost;
    readonly surface: PluginSignInSurface;
    readonly target: PluginRequirementTarget;
    readonly providerName: string;
    readonly pollIntervalMilliseconds?: number;
  }) {
    this.#client = options.client;
    this.#surface = options.surface;
    this.#target = options.target;
    this.#providerName = options.providerName;
    this.#pollIntervalMilliseconds = options.pollIntervalMilliseconds;
  }

  getState(): PluginSignInState {
    return this.#state;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #set(state: PluginSignInState, generation = this.#generation) {
    if (this.#closed || generation !== this.#generation) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  /** A fresh connection: every start and every refusal needs a new one. */
  async prepare(): Promise<void> {
    const generation = ++this.#generation;
    this.#set({ step: "preparing" }, generation);
    try {
      const result = await this.#client.dispatch({
        type: "plugin.authorization.prepare",
        idempotencyKey: mutationIdempotencyKey("plugin-auth-prepare"),
        input: {
          plugin: this.#target.pluginId,
          requirement: this.#target.requirement,
          scope: this.#target.scope,
        },
      });
      if (result.type !== "plugin.authorization.prepare")
        throw new Error("The Host answered a different command.");
      this.#set(
        { step: "choosing", choices: pluginSignInChoices(result, this.#providerName) },
        generation,
      );
    } catch (error) {
      this.#set({ step: "ended", end: pluginSignInRefusal(error) }, generation);
    }
  }

  /** Call from the person's click: a browser surface opens its window before anything waits. */
  start(pick: PluginSignInPick): void {
    const state = this.#state;
    if (state.step !== "choosing") return;
    const { choices } = state;
    const generation = this.#generation;
    const key = "option" in pick ? pick.option.key : "own-app";
    const method = "option" in pick ? pick.option.method : choices.ownApp?.method;
    const review = "option" in pick ? pick.option.review : choices.ownApp?.review;
    if (!method || !review) return;
    const client: PluginOAuthClientChoice | null =
      "option" in pick
        ? pick.option.client
        : {
            clientId: pick.ownApp.clientId.trim(),
            ...(pick.ownApp.clientSecret?.trim()
              ? { clientSecret: pick.ownApp.clientSecret.trim() }
              : {}),
            ...(pick.ownApp.save ? { save: true } : {}),
          };
    let launch: PluginSignInLaunch;
    try {
      launch = this.#surface.open();
    } catch (error) {
      this.#set({ step: "ended", end: pluginSignInRefusal(error) });
      return;
    }
    this.#set({ step: "starting", choices, key });
    void this.#begin({ choices, key, method, review, client, launch, generation });
  }

  async #begin(input: {
    readonly choices: PluginSignInChoices;
    readonly key: string;
    readonly method: string;
    readonly review: string;
    readonly client: PluginOAuthClientChoice | null;
    readonly launch: PluginSignInLaunch;
    readonly generation: number;
  }) {
    const { choices, launch, generation } = input;
    let started: PluginOAuthStart;
    try {
      const route = await launch.route();
      const result = await this.#client.dispatch({
        type: "plugin.authorization.begin",
        idempotencyKey: mutationIdempotencyKey(`plugin-auth-begin:${choices.connection}`),
        input: {
          connection: choices.connection,
          consent: choices.consent,
          method: input.method,
          review: input.review,
          ...(input.client ? { client: input.client } : {}),
          surface: this.#surface.surface,
          returnPath: route.returnPath,
          ...(route.finish ? { finish: route.finish } : {}),
          ...(route.appReturnPort === undefined ? {} : { appReturnPort: route.appReturnPort }),
        },
      });
      if (result.type !== "plugin.authorization.begin")
        throw new Error("The Host answered a different command.");
      started = result;
    } catch (error) {
      launch.abandon();
      this.#set({ step: "ended", end: pluginSignInRefusal(error) }, generation);
      return;
    }
    const waiting = new AbortController();
    this.#waiting = waiting;
    this.#set(
      {
        step: "waiting",
        choices,
        key: input.key,
        attemptId: started.attemptId,
        expiresAt: started.expiresAt,
        cancelling: false,
      },
      generation,
    );
    try {
      await launch.launch(started);
    } catch (error) {
      if (waiting.signal.aborted) return;
      // Closing the system sheet, or failing to open the page at all, ends this sign-in.
      await this.cancel(
        error instanceof PluginSignInDismissed ? null : pluginSignInRefusal(error).message,
      );
      return;
    }
    try {
      const status = await waitForPluginAuthorization({
        client: this.#client,
        attemptId: started.attemptId,
        expiresAt: started.expiresAt,
        signal: waiting.signal,
        ...(this.#pollIntervalMilliseconds === undefined
          ? {}
          : { pollIntervalMilliseconds: this.#pollIntervalMilliseconds }),
      });
      if (!waiting.signal.aborted)
        this.#set({ step: "ended", end: pluginSignInEnd(status) }, generation);
    } catch (error) {
      if (!waiting.signal.aborted)
        this.#set({ step: "ended", end: pluginSignInRefusal(error) }, generation);
    }
  }

  /**
   * Ends the open sign-in at the Host. A proof already delivered may have
   * finished it first, and then the Host's answer says so.
   */
  async cancel(reason: string | null = null): Promise<void> {
    const state = this.#state;
    if (state.step !== "waiting" || state.cancelling) return;
    const generation = this.#generation;
    this.#waiting?.abort();
    this.#set({ ...state, cancelling: true }, generation);
    try {
      const result = await this.#client.dispatch({
        type: "plugin.authorization.cancel",
        idempotencyKey: mutationIdempotencyKey(`plugin-auth-cancel:${state.attemptId}`),
        attemptId: state.attemptId,
      });
      if (result.type !== "plugin.authorization.cancel")
        throw new Error("The Host answered a different command.");
      const end = pluginSignInEnd(result);
      this.#set(
        {
          step: "ended",
          end:
            reason && end.kind === "cancelled"
              ? { kind: "error", message: reason }
              : authorizationTerminalStatuses.has(result.status)
                ? end
                : { kind: "cancelled", message: "Sign-in was cancelled." },
        },
        generation,
      );
    } catch {
      this.#set(
        {
          step: "ended",
          end: {
            kind: "error",
            message:
              "Opensteer couldn't confirm the cancel. Check this plugin's accounts to see whether it finished.",
          },
        },
        generation,
      );
    }
  }

  /** Stops watching. The sign-in itself carries on at the Host. */
  close(): void {
    this.#closed = true;
    this.#waiting?.abort();
    this.#listeners.clear();
  }
}

/** Forgets a saved OAuth app. What a preparation offers changes, so prepare again after. */
export async function forgetPluginOAuthApp(client: PluginSignInHost, savedApp: string) {
  const result = await client.dispatch({
    type: "plugin.oauthApp.remove",
    idempotencyKey: mutationIdempotencyKey(`plugin-oauth-app:${savedApp}`),
    client: savedApp,
  });
  if (result.type !== "plugin.oauthApp.remove")
    throw new Error("The Host answered a different command.");
}

/** Whether ending this way is worth starting again from the same screen. */
export function pluginSignInRetryable(end: PluginSignInEnd) {
  return end.kind !== "completed" && end.kind !== "account-link-required";
}
