import { request as httpRequest } from "node:http";
import { OpensteerError } from "@opensteer/core";

const maximumUrlLength = 16_384;
/** Where `antigravity acp --login` sends Google; the page displays a code the person pastes back. */
const codeRedirectUri = "https://antigravity.google/oauth-callback";

export interface AntigravityAuthorization {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

function invalidAuthorization(): OpensteerError {
  return new OpensteerError({
    code: "harness_error",
    message: "Antigravity returned an invalid Google sign-in URL",
  });
}

export function parseAntigravityAuthorizationUrl(
  value: string,
  kind: "loopback" | "code" = "loopback",
): AntigravityAuthorization {
  if (value.length > maximumUrlLength || /\s/u.test(value)) throw invalidAuthorization();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidAuthorization();
  }
  const states = url.searchParams.getAll("state");
  const redirects = url.searchParams.getAll("redirect_uri");
  const responseTypes = url.searchParams.getAll("response_type");
  const expectedPath = kind === "loopback" ? "/o/oauth2/v2/auth" : "/o/oauth2/auth";
  if (
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== expectedPath ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    states.length !== 1 ||
    !states[0] ||
    states[0].length > 512 ||
    /\s/u.test(states[0]) ||
    redirects.length !== 1 ||
    responseTypes.length !== 1 ||
    responseTypes[0] !== "code"
  ) {
    throw invalidAuthorization();
  }
  if (kind === "code") {
    if (redirects[0] !== codeRedirectUri) throw invalidAuthorization();
    return { authorizationUrl: value, redirectUri: codeRedirectUri, state: states[0] };
  }
  let redirect: URL;
  try {
    redirect = new URL(redirects[0]!);
  } catch {
    throw invalidAuthorization();
  }
  const port = Number(redirect.port);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.pathname !== "/" ||
    redirect.search !== "" ||
    redirect.hash !== "" ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    !Number.isSafeInteger(port) ||
    port < 1_024 ||
    port > 65_535
  ) {
    throw invalidAuthorization();
  }
  return { authorizationUrl: value, redirectUri: redirect.href, state: states[0] };
}

function invalidCallback(message: string): OpensteerError {
  return new OpensteerError({ code: "bad_request", message });
}

export function validateAntigravityCallbackUrl(
  pending: Pick<AntigravityAuthorization, "redirectUri" | "state">,
  value: string,
): URL {
  if (value.length > maximumUrlLength) {
    throw invalidCallback("The sign-in response URL is too long");
  }
  let callback: URL;
  try {
    callback = new URL(value);
  } catch {
    throw invalidCallback("Paste the complete redirect URL from the Google sign-in page");
  }
  const expected = new URL(pending.redirectUri);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    throw invalidCallback("This redirect URL does not belong to the current sign-in");
  }
  const states = callback.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) {
    throw invalidCallback("This redirect URL does not belong to the current sign-in");
  }
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  if (!(
    (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
    (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
  )) {
    throw invalidCallback("The redirect URL must contain one Google sign-in response");
  }
  const issuers = callback.searchParams.getAll("iss");
  if (
    issuers.length > 1 ||
    (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
  ) {
    throw invalidCallback("The redirect URL is not a Google sign-in response");
  }
  return callback;
}

/**
 * Validates what `antigravity acp --login` reads on stdin: either the bare code
 * displayed by the Antigravity callback page, or that page's URL belonging to
 * this sign-in's state. Rejects whitespace, control characters, and foreign URLs.
 */
export function validateAntigravityLoginResponse(
  pending: Pick<AntigravityAuthorization, "redirectUri" | "state">,
  raw: string,
): string {
  const value = raw.trim();
  if (/^[\w./~-]{1,2048}$/u.test(value)) return value;
  if (value.length > maximumUrlLength || /\s/u.test(value)) {
    throw invalidCallback("Paste the code or complete redirect URL from the Google sign-in page");
  }
  let callback: URL;
  try {
    callback = new URL(value);
  } catch {
    throw invalidCallback("Paste the code or complete redirect URL from the Google sign-in page");
  }
  if (
    `${callback.origin}${callback.pathname}` !== pending.redirectUri ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    throw invalidCallback("This redirect URL does not belong to the current sign-in");
  }
  const states = callback.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) {
    throw invalidCallback("This redirect URL does not belong to the current sign-in");
  }
  const codes = callback.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) {
    throw invalidCallback("The redirect URL must contain one Google sign-in code");
  }
  return value;
}

/** Sends one callback directly to the loopback listener without proxies or redirects. */
export function forwardAntigravityCallback(callback: URL, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = () =>
      new OpensteerError({
        code: "harness_error",
        message: "Could not deliver the sign-in response. Start sign-in again",
      });
    let settled = false;
    const finish = (result?: OpensteerError) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (result) reject(result);
      else resolve();
    };
    const abort = () => request.destroy(failed());
    const request = httpRequest(
      {
        agent: false,
        hostname: callback.hostname,
        method: "GET",
        path: `${callback.pathname}${callback.search}`,
        port: callback.port,
        protocol: "http:",
      },
      (response) => {
        response.once("error", () => finish(failed()));
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          finish(status >= 200 && status < 300 ? undefined : failed());
        });
        response.resume();
      },
    );
    request.setTimeout(10_000, () => request.destroy(failed()));
    request.once("error", () => finish(failed()));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    request.end();
  });
}
