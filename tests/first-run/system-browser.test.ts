import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openedByPress, openedMarker, type ElectronAppCalls } from "./system-browser.js";

/*
 * The journey's stand-in for the system browser, against a stand-in Electron app: the install is
 * one call that returns at once, the address comes back as a console event, and a press that
 * fails is the step's failure, heard where it happened.
 */

function app() {
  const shell: { openExternal: unknown } = { openExternal: () => undefined };
  const console = new EventEmitter();
  let calls = 0;
  const calls$: ElectronAppCalls = {
    evaluate: async (install, marker) => {
      calls += 1;
      install({ shell }, marker);
    },
    waitForEvent: (_event, options) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), options.timeout);
        console.on("message", (text: string) => {
          const message = { text: () => text };
          if (options.predicate(message)) {
            clearTimeout(timer);
            resolve(message);
          }
        });
      }),
  };
  // What the app's main process does: openExternal's console.log reaches the journey as an event.
  const open = async (url: string) => {
    const log = globalThis.console.log;
    globalThis.console.log = (line: string) => console.emit("message", line);
    try {
      await (shell.openExternal as (url: string) => Promise<void>)(url);
    } finally {
      globalThis.console.log = log;
    }
  };
  return { calls: () => calls, calls$, open };
}

describe("the journey's system browser", () => {
  const prefix = "http://127.0.0.1:4142/api/auth/oauth2/authorize";

  it("installs with one call that returns at once, and hears the address the press opened", async () => {
    const fake = app();
    const url = await openedByPress(
      fake.calls$,
      prefix,
      async () => {
        await fake.open("https://help.opensteer.example/other");
        await fake.open(`${prefix}?state=abc`);
      },
      1_000,
    );
    expect(url).toBe(`${prefix}?state=abc`);
    expect(fake.calls()).toBe(1);
    expect(openedMarker).toBe("first-run-journey opened ");
  });

  it("fails the step when the press fails, without an unheard rejection", async () => {
    const fake = app();
    await expect(
      openedByPress(fake.calls$, prefix, async () => Promise.reject(new Error("no Sign in")), 50),
    ).rejects.toThrow("no Sign in");
  });
});
