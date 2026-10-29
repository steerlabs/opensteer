import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runnerWebSocketTransport, validateRunnerTransport } from "./transport.js";

describe("Runner transport policy", () => {
  it("requires HTTPS for every non-loopback production Runner", () => {
    expect(() =>
      validateRunnerTransport({
        hostOrigin: new URL("http://host:4310"),
        mode: "production",
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      validateRunnerTransport({
        hostOrigin: new URL("http://127.0.0.1:4310"),
        mode: "production",
      }),
    ).not.toThrow();
  });

  it("loads a bounded private CA for primary and auxiliary secure sockets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-runner-ca-"));
    const path = join(directory, "root.pem");
    await writeFile(path, "private-ca");
    const policy = {
      controlCaPath: path,
      hostOrigin: new URL("https://gateway:8443"),
      mode: "production" as const,
    };

    await expect(runnerWebSocketTransport(policy, "/internal/v1/runners")).resolves.toMatchObject({
      ca: Buffer.from("private-ca"),
      url: new URL("wss://gateway:8443/internal/v1/runners"),
    });
    await expect(
      runnerWebSocketTransport(policy, "/internal/v1/runners/auxiliary/browser"),
    ).resolves.toMatchObject({
      ca: Buffer.from("private-ca"),
      url: new URL("wss://gateway:8443/internal/v1/runners/auxiliary/browser"),
    });
  });
});
