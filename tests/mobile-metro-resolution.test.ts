import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
interface ResolutionContext {
  readonly originModulePath: string;
  readonly resolveRequest: (...args: unknown[]) => unknown;
}
const {
  default: config,
}: {
  readonly default: {
    readonly resolver: {
      readonly resolveRequest: (
        context: ResolutionContext,
        moduleName: string,
        platform: string,
      ) => unknown;
    };
  };
} = await import(new URL("../apps/mobile/metro.config.js", import.meta.url).href);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(files: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), "opensteer-metro-"));
  directories.push(directory);
  for (const file of files) writeFileSync(join(directory, file), "export const value = 1;");
  const resolveRequest = vi.fn(() => ({ type: "sourceFile", filePath: "resolved-by-metro" }));
  return { originModulePath: join(directory, "entry.ts"), resolveRequest };
}

describe("mobile NodeNext resolution", () => {
  it.each(["ios", "android"])("leaves %s source selection to Metro", (platform) => {
    const context = fixture(["form.tsx", "form.ios.tsx", "form.android.tsx"]);
    config.resolver.resolveRequest(context, "./form.js", platform);
    expect(context.resolveRequest).toHaveBeenCalledWith(context, "./form", platform);
  });

  it("resolves a platform-only source without requiring a generic component", () => {
    const context = fixture(["form.ios.tsx"]);
    config.resolver.resolveRequest(context, "./form.js", "ios");
    expect(context.resolveRequest).toHaveBeenCalledWith(context, "./form", "ios");
  });

  it("supports native sources and shared TypeScript libraries", () => {
    const context = fixture(["form.native.tsx", "model.ts"]);
    config.resolver.resolveRequest(context, "./form.jsx", "android");
    config.resolver.resolveRequest(context, "./model.js", "ios");
    expect(context.resolveRequest.mock.calls).toEqual([
      [context, "./form", "android"],
      [context, "./model", "ios"],
    ]);
  });

  it("keeps actual JavaScript, package imports and missing modules unchanged", () => {
    const context = fixture(["form.js", "form.tsx"]);
    for (const specifier of ["./form.js", "@expo/ui", "./missing.js"]) {
      config.resolver.resolveRequest(context, specifier, "ios");
      expect(context.resolveRequest).toHaveBeenLastCalledWith(context, specifier, "ios");
    }
  });
});

describe("mobile mock Host entry", () => {
  const app = new URL("../apps/mobile/src/app.tsx", import.meta.url).pathname;

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, "./client/mock-host-port-disabled"],
    ["0", "./client/mock-host-port-disabled"],
    ["1", "./client/mock-host-port"],
  ])("with EXPO_PUBLIC_OPENSTEER_MOCK=%s resolves %s", (mock, expected) => {
    vi.stubEnv("EXPO_PUBLIC_OPENSTEER_MOCK", mock);
    const resolveRequest = vi.fn(() => ({ type: "sourceFile", filePath: "resolved-by-metro" }));
    const context = { originModulePath: app, resolveRequest };
    config.resolver.resolveRequest(context, "./client/mock-host-port.js", "ios");
    expect(resolveRequest).toHaveBeenCalledWith(context, expected, "ios");
  });
});
