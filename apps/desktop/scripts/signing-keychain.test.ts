import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const input = require("./signing-input.cjs") as typeof import("./signing-input.cjs");
const directory = mkdtempSync(path.join(tmpdir(), "opensteer-keychain-"));
const keychain = path.join(directory, "release keys.keychain-db");
writeFileSync(keychain, "fixture");
const fixture = {
  teamId: "ABCDE12345",
  identity: "Developer ID Application: Example (ABCDE12345)",
};
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function source(relative: string): string {
  return readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
}
function balanced(source: string, start: number, open: string, close: string): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    if (source[i] === close && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error("Unclosed command expression");
}
function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const javascript = transformSync(`globalThis.result = (${expression});`, { loader: "ts" }).code;
  return vm.runInNewContext(javascript + "\nresult", context);
}

// Evaluate the actual command argument expressions, with cheap collaborators;
// never invoke codesign, a keychain, Electron or Apple's service in these tests.
describe("explicit signing keychain boundary", () => {
  it("accepts only absolute keychain-db files and refuses a missing configured file", () => {
    expect(input.parseSigningInput({ ...fixture, keychain })).toEqual({ ...fixture, keychain });
    for (const invalid of ["relative.keychain-db", "/tmp/wrong.keychain", ""]) {
      expect(() => input.parseSigningInput({ ...fixture, keychain: invalid })).toThrow();
    }
    const file = path.join(directory, "input.json");
    writeFileSync(file, JSON.stringify({ ...fixture, keychain }));
    expect(input.readSigningMode({ OPENSTEER_DESKTOP_SIGNING_FILE: file }).mode).toBe("signed");
    writeFileSync(
      file,
      JSON.stringify({ ...fixture, keychain: path.join(directory, "missing.keychain-db") }),
    );
    expect(() => input.readSigningMode({ OPENSTEER_DESKTOP_SIGNING_FILE: file })).toThrow();
    writeFileSync(file, JSON.stringify(fixture));
    expect(input.readSigningMode({ OPENSTEER_DESKTOP_SIGNING_FILE: file }).mode).toBe("signed");
  });

  for (const leaf of [
    "build-computer-use-helper.ts",
    "build-passwords-broker.ts",
    "build-personal-runtime.ts",
    "sign-release-artifact.ts",
  ]) {
    it(`${leaf} pins the configured keychain and preserves default-keychain arguments`, () => {
      const root = source(leaf);
      const commands = [...root.matchAll(/run\(\s*"\/usr\/bin\/codesign",\s*\[/gu)]
        .map((match) => balanced(root, match.index + match[0].lastIndexOf("["), "[", "]"))
        .filter((args) => args.includes('"--sign"'));
      expect(commands).toHaveLength(1);
      for (const configured of [false, true]) {
        const file = path.join(directory, "leaf.json");
        writeFileSync(file, JSON.stringify({ ...fixture, ...(configured ? { keychain } : {}) }));
        const environment = { OPENSTEER_DESKTOP_SIGNING_FILE: file };
        const context = {
          identity: fixture.identity,
          signingMode: input.readSigningMode(environment),
          personalRuntimeSigningOptions: input.personalRuntimeSigningOptions,
          signingKeychainArguments: () => {
            const module = require("./signing-input.cjs") as {
              signingKeychainArguments: (env: Record<string, string>) => string[];
            };
            return module.signingKeychainArguments(environment);
          },
          target: "/fixture/target",
          bundle: "/fixture/app",
          destination: "/fixture/destination",
          identifier: "com.example.fixture",
          bundleIdentifier: "com.example.fixture",
          entitlementsPath: "/fixture/entitlements",
          entitlements: null,
          artifact: { path: "fixture" },
          artifactPath: "/fixture/artifact",
          layout: { interpreter: "node" },
          inheritsRunnerSandbox: () => false,
          interpreterEntitlements: "/fixture/interpreter",
          harnessEntitlements: "/fixture/harness",
        };
        const args = Array.from(evaluate(commands[0]!, context) as string[]);
        expect(args.includes("--keychain")).toBe(configured);
        if (configured) expect(args[args.indexOf("--keychain") + 1]).toBe(keychain);
        expect(args[args.indexOf("--sign") + 1]).toBe(fixture.identity);
      }
    });
  }

  it("pins electron-builder signing and its notarizer to the same file", () => {
    const root = source("package-macos.ts");
    const start =
      root.indexOf("const releaseEnvironment = {") + "const releaseEnvironment = ".length;
    const declaration = balanced(root, start, "{", "}");
    for (const configured of [false, true]) {
      const signing = {
        ...fixture,
        notarizationProfile: "profile",
        ...(configured ? { keychain } : {}),
      };
      const env = evaluate(declaration, {
        process: { env: { CSC_LINK: "alternate-certificate" } },
        signingMode: { mode: "signed", signing },
        targetArchitecture: { manifest: "arm64" },
      }) as Record<string, string>;
      expect(env.CSC_LINK).toBe(configured ? undefined : "alternate-certificate");
      expect(env.CSC_KEYCHAIN).toBe(configured ? keychain : undefined);
      expect(env.APPLE_KEYCHAIN).toBe(configured ? keychain : undefined);
      expect(env.APPLE_KEYCHAIN_PROFILE).toBe("profile");
    }
  });

  it("identity discovery uses the configured file rather than the search list", () => {
    for (const file of ["native-build-cache.ts", "../../../scripts/release-beta-mac.ts"]) {
      const root = source(file);
      const start = root.indexOf('"find-identity"');
      const argsExpression = balanced(root, root.lastIndexOf("[", start), "[", "]");
      for (const configured of [false, true]) {
        const args = Array.from(
          evaluate(argsExpression, {
            keychain: configured ? keychain : undefined,
            config: {},
            signingInput: () => (configured ? { keychain } : {}),
          }) as string[],
        );
        expect(args.includes(keychain)).toBe(configured);
      }
    }
  });

  it.each([
    { name: "neither", json: undefined, legacy: undefined, expected: undefined },
    { name: "legacy only", json: undefined, legacy: keychain, expected: keychain },
    { name: "JSON only", json: keychain, legacy: undefined, expected: keychain },
    { name: "both equal", json: keychain, legacy: keychain, expected: keychain },
    {
      name: "both different",
      json: keychain,
      legacy: "/other/release.keychain-db",
      expected: "reject",
    },
  ])("coordinator keychain compatibility: $name", ({ json, legacy, expected }) => {
    const root = source("../../../scripts/release-beta-mac.ts");
    const signingInput = root.match(/function signingInput\([\s\S]*?\n\}/u)![0];
    const signing = { ...fixture, ...(json === undefined ? {} : { keychain: json }) };
    const expression = `(${signingInput})(config)`;
    const context = {
      process: { env: {} },
      config: {
        signingIdentity: fixture.identity,
        ...(legacy === undefined ? {} : { keychain: legacy }),
      },
      readSigningMode: () => ({ mode: "signed", signing }),
    };
    if (expected === "reject")
      expect(() => evaluate(expression, context)).toThrow(
        /keychain.*match|conflicting.*keychain/iu,
      );
    else expect((evaluate(expression, context) as { keychain?: string }).keychain).toBe(expected);
  });

  it("all release notary calls use the validated input's keychain", () => {
    const root = source("../../../scripts/release-beta-mac.ts");
    const credentials = root.match(/function credentials\([\s\S]*?\n\}/u)![0];
    for (const configured of [false, true]) {
      const signing = {
        ...fixture,
        notarizationProfile: "profile",
        ...(configured ? { keychain } : {}),
      };
      const args = Array.from(
        evaluate(`(${credentials})({keychainProfile:'profile'})`, {
          signingInput: () => signing,
        }) as string[],
      );
      expect(args.includes("--keychain")).toBe(configured);
      if (configured) expect(args[args.indexOf("--keychain") + 1]).toBe(keychain);
      expect(args[args.indexOf("--keychain-profile") + 1]).toBe("profile");
    }
    const notary = [
      ...root.matchAll(
        /"notarytool",\s*"(?:history|submit|info)",[\s\S]*?\.\.\.credentials\(config\)/gu,
      ),
    ];
    expect(notary).toHaveLength(4);
  });
});
