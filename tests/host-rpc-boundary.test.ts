import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * Production code calls a Host's typed API only through `createHttpHostApiClient`,
 * which derives the route, method, input encoding and response schemas from
 * `hostApi`. A hand-built request compiles and passes mocked tests while the
 * Host answers 404, so every other file that spells the RPC prefix is named
 * here with the reason it does not build a request of its own.
 */
const allowed: Readonly<Record<string, string>> = {
  "packages/client/src/host/host-api-client.ts": "the one encoder",
  "apps/desktop/src/connections/host-transport.ts":
    "inspects requests the typed client already built, as it relays them",
  "apps/web/src/desktop/desktop-host-transport.ts":
    "forwards the typed client's requests over the desktop bridge",
  "apps/web/src/desktop/desktop-preview-bridge.ts":
    "answers the typed client's requests in the browser preview",
  "packages/protocol/src/desktop.ts": "restricts which typed requests the bridge may carry",
  "apps/mobile/modules/phone-connection/android/src/main/java/com/opensteer/phoneconnection/PhoneConnectionRuntime.kt":
    "the native Android enrollment, which has no TypeScript client to call",
};

/** The Host serves the routes; tests, mocks and scripts may speak the wire directly. */
const outOfScope =
  /(?:^apps\/host\/|\/scripts\/|\/mock\/|\/node_modules\/|\.test\.tsx?$|\.test-support\.tsx?$|test-support\/|\/__tests__\/|\.e2e\.)/u;

function productionSources(directory: string): string[] {
  const absolute = path.join(repositoryRoot, directory);
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:tsx?|mts|kt|swift)$/u.test(entry.name))
    .map((entry) =>
      path
        .relative(repositoryRoot, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .filter((file) => !outOfScope.test(file));
}

describe("Host RPC boundary", () => {
  const sources = [
    ...readdirSync(path.join(repositoryRoot, "apps")).flatMap((app) =>
      ["src", "modules"].flatMap((folder) => {
        try {
          return productionSources(`apps/${app}/${folder}`);
        } catch {
          return [];
        }
      }),
    ),
    ...readdirSync(path.join(repositoryRoot, "packages")).flatMap((name) => {
      try {
        return productionSources(`packages/${name}/src`);
      } catch {
        return [];
      }
    }),
  ];
  const spelling = sources.filter((file) =>
    readFileSync(path.join(repositoryRoot, file), "utf8").includes("/v1/rpc/"),
  );

  it("builds Host RPC requests only through the typed client", () => {
    expect(spelling.filter((file) => !(file in allowed))).toEqual([]);
  });

  it("names no exception that no longer needs one", () => {
    expect(Object.keys(allowed).filter((file) => !spelling.includes(file))).toEqual([]);
  });
});
