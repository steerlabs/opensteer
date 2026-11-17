import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { traceCodesign } = require("../apps/desktop/scripts/codesign-timing.cjs") as {
  traceCodesign: (
    args: readonly string[],
    options: {
      root: string;
      execute: (
        command: string,
        args: readonly string[],
      ) => Promise<{ code: number; signal: string | null; stderr: string }>;
      record: (event: Record<string, unknown>) => void;
    },
  ) => Promise<number>;
};

it("records notarization submit, acceptance and staple without credentials, output or altered status", async () => {
  const { traceXcrun } = require("../apps/desktop/scripts/codesign-timing.cjs") as {
    traceXcrun: (
      args: readonly string[],
      options: {
        execute: (
          command: string,
          args: readonly string[],
        ) => Promise<{ code: number; signal: string | null; stdout: string; stderr: string }>;
        record: (event: Record<string, unknown>) => void;
      },
    ) => Promise<number>;
  };
  const events: Record<string, unknown>[] = [];
  for (const [args, code, stdout] of [
    [
      ["notarytool", "submit", "/private/app.zip", "--key", "DO-NOT-RECORD", "--wait"],
      0,
      '{"status":"Accepted","id":"PRIVATE-ID"}',
    ],
    [["stapler", "staple", "/private/app"], 0, "PRIVATE-OUTPUT"],
    [
      ["notarytool", "submit", "/private/app.zip", "--password", "DO-NOT-RECORD"],
      7,
      "PRIVATE-OUTPUT",
    ],
  ] as const) {
    expect(
      await traceXcrun(args, {
        execute: async (command: string, actual: readonly string[]) => {
          expect(command).toBe("/usr/bin/xcrun");
          expect(actual).toEqual(args);
          return { code, signal: null, stdout, stderr: "PRIVATE-ERROR" };
        },
        record: (event: Record<string, unknown>) => events.push(event),
      }),
    ).toBe(code);
  }
  expect(events.map(({ phase, event }) => [phase, event])).toEqual([
    ["package.notarize.submit", "start"],
    ["package.notarize.submit", "accepted"],
    ["package.notarize.staple", "start"],
    ["package.notarize.staple", "complete"],
    ["package.notarize.submit", "start"],
    ["package.notarize.submit", "failed"],
  ]);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE|DO-NOT-RECORD|--key|--password/);
});
it("measures each signing call without changing security options, exit status or retaining credential arguments", async () => {
  const events: Record<string, unknown>[] = [];
  const args = [
    "--force",
    "--sign",
    "DO-NOT-RECORD-IDENTITY",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    "/private/entitlements.plist",
    "/private/app/Contents/Frameworks/binary",
  ];
  for (const code of [0, 7]) {
    const result = await traceCodesign(args, {
      root: "/private/app",
      execute: async (command, actual) => {
        expect(command).toBe("/usr/bin/time");
        expect(actual).toEqual(["-p", "/usr/bin/codesign", ...args]);
        return { code, signal: null, stderr: "real 2.0\nuser 0.10\nsys 0.02\n" };
      },
      record: (event) => events.push(event),
    });
    expect(result).toBe(code);
  }
  const ends = events.filter((event) => event.event !== "start");
  expect(ends.map((event) => event.event)).toEqual(["complete", "failed"]);
  expect(ends[0]).toMatchObject({
    file: "Contents/Frameworks/binary",
    elapsedMs: 2000,
    cpuUserMs: 100,
    cpuSystemMs: 20,
  });
  expect(JSON.stringify(events)).not.toContain("DO-NOT-RECORD-IDENTITY");
  expect(JSON.stringify(events)).not.toContain("entitlements.plist");
});

it("requires diagnostic opt-in and removes the measurement shim after a packaging failure", async () => {
  const { withMacSigningTimings } = await import("../apps/desktop/scripts/mac-signing-timing.js");
  const { access } = await import("node:fs/promises");
  const stock = { PATH: "/usr/bin", OPENSTEER_RELEASE_TIMING_FILE: "/unused.jsonl" };
  await withMacSigningTimings(stock, "/private/app", async (environment) => {
    expect(environment).toBe(stock);
  });
  let shim = "";
  await expect(
    withMacSigningTimings(
      { ...stock, OPENSTEER_MAC_SIGN_TIMINGS: "1" },
      "/private/app",
      async (environment) => {
        shim = path.join(environment.PATH!.split(path.delimiter)[0]!, "codesign");
        await access(shim);
        await access(path.join(path.dirname(shim), "xcrun"));
        throw Error("injected packaging failure");
      },
    ),
  ).rejects.toThrow("injected packaging failure");
  await expect(access(shim)).rejects.toThrow();
});
