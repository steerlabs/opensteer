import { describe, expect, it, vi } from "vitest";
import { antigravityAuthStdoutPrefix, antigravityBrowserMarker } from "./environment.js";
import { consumeAntigravityStderr, transformAntigravityStdout } from "./output.js";

const authorizationUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?state=opaque&redirect_uri=http%3A%2F%2F127.0.0.1%3A42123%2F&response_type=code";

async function collect(source: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

describe("Antigravity ACP output", () => {
  it("captures and removes the auth line before ACP framing", async () => {
    const listener = vi.fn();
    const stdout = (async function* () {
      yield Buffer.from(`{"jsonrpc":"2.0"}\n${antigravityAuthStdoutPrefix}${authorizationUrl}\n`);
    })();

    await expect(collect(transformAntigravityStdout(stdout, listener))).resolves.toBe(
      '{"jsonrpc":"2.0"}\n',
    );
    expect(listener).toHaveBeenCalledWith(authorizationUrl);
  });

  it("captures a browser-helper URL from stderr without returning stderr", async () => {
    const listener = vi.fn();
    const stderr = (async function* () {
      yield Buffer.from(`private provider detail\n${antigravityBrowserMarker}`);
      yield Buffer.from(`${JSON.stringify(authorizationUrl)}\n`);
    })();

    await consumeAntigravityStderr(stderr, listener);
    expect(listener).toHaveBeenCalledWith(authorizationUrl);
  });

  it("turns an unmanaged auth line into authentication-required", async () => {
    const stdout = (async function* () {
      yield Buffer.from(`${antigravityAuthStdoutPrefix}${authorizationUrl}\n`);
    })();

    await expect(collect(transformAntigravityStdout(stdout))).rejects.toMatchObject({
      code: "harness_error",
      message: "Antigravity requires Google authentication",
    });
  });
});
