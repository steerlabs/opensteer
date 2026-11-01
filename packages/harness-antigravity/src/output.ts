import { OpensteerError } from "@opensteer/core";
import { antigravityAuthStdoutPrefix, antigravityBrowserMarker } from "./environment.js";
import { parseAntigravityAuthorizationUrl } from "./oauth.js";

const maximumProtocolLineBytes = 32 * 1_024 * 1_024;
const maximumAuthLineCharacters = 20_000;

type AuthorizationListener = (authorizationUrl: string) => Promise<void> | void;

/** Removes Antigravity's human auth line before ACP's NDJSON parser sees it. */
export function transformAntigravityStdout(
  stdout: AsyncIterable<Buffer>,
  onAuthorizationUrl?: AuthorizationListener,
): AsyncIterable<Buffer> {
  return (async function* () {
    let pending = Buffer.alloc(0);
    for await (const chunk of stdout) {
      pending = Buffer.concat([pending, chunk], pending.byteLength + chunk.byteLength);
      if (pending.byteLength > maximumProtocolLineBytes) {
        throw new OpensteerError({
          code: "harness_error",
          message: "Antigravity sent an oversized protocol line",
        });
      }
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        const line = pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
        if (await captureStdoutAuthorization(line, onAuthorizationUrl)) continue;
        yield line;
      }
    }
    if (pending.byteLength > 0) {
      if (!(await captureStdoutAuthorization(pending, onAuthorizationUrl))) yield pending;
    }
  })();
}

async function captureStdoutAuthorization(
  line: Buffer,
  listener: AuthorizationListener | undefined,
): Promise<boolean> {
  const text = line.toString("utf8").replace(/\r?\n$/u, "");
  if (!text.startsWith(antigravityAuthStdoutPrefix)) return false;
  const authorization = parseAntigravityAuthorizationUrl(
    text.slice(antigravityAuthStdoutPrefix.length),
  );
  if (!listener) throw authenticationRequired();
  await listener(authorization.authorizationUrl);
  return true;
}

/** Captures only a validated OAuth URL and deliberately discards every stderr byte. */
export async function consumeAntigravityStderr(
  stderr: AsyncIterable<Buffer>,
  onAuthorizationUrl?: AuthorizationListener,
): Promise<void> {
  let pending = "";
  for await (const chunk of stderr) {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > maximumAuthLineCharacters) pending = "";
    for (const line of lines) await captureStderrAuthorization(line.replace(/\r$/u, ""));
  }
  if (pending) await captureStderrAuthorization(pending);

  async function captureStderrAuthorization(line: string): Promise<void> {
    if (line.length > maximumAuthLineCharacters) return;
    let value: string | undefined;
    if (line.startsWith(antigravityAuthStdoutPrefix)) {
      value = line.slice(antigravityAuthStdoutPrefix.length);
    } else if (line.startsWith(antigravityBrowserMarker)) {
      try {
        const parsed: unknown = JSON.parse(line.slice(antigravityBrowserMarker.length));
        if (typeof parsed === "string") value = parsed;
      } catch {
        throw new OpensteerError({
          code: "harness_error",
          message: "Antigravity returned an invalid browser sign-in request",
        });
      }
    }
    if (!value) return;
    const authorization = parseAntigravityAuthorizationUrl(value);
    if (!onAuthorizationUrl) throw authenticationRequired();
    await onAuthorizationUrl(authorization.authorizationUrl);
  }
}

export function authenticationRequired(): OpensteerError {
  return new OpensteerError({
    code: "harness_error",
    message: "Antigravity requires Google authentication",
  });
}

export function isAntigravityAuthenticationRequired(error: unknown): boolean {
  return (
    error instanceof OpensteerError &&
    error.message === "Antigravity requires Google authentication"
  );
}
