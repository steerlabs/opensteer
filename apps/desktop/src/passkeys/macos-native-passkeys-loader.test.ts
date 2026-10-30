import { expect, test, vi } from "vitest";
import { createMacosNativePasskeys } from "./macos-native-passkeys.js";

const mocks = vi.hoisted(() => ({ requireCalls: vi.fn(), exists: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (filename: import("node:fs").PathLike) => {
      if (String(filename).replace(/\\/gu, "/").endsWith("/passkeys/opensteer-passkeys.node")) {
        mocks.exists(filename);
        return false;
      }
      return actual.existsSync(filename);
    },
  };
});
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      mocks.requireCalls(...args);
      return actual.createRequire(...args);
    },
  };
});

test("a missing addon is unavailable without attempting native loading", () => {
  const adapter = createMacosNativePasskeys({ platform: "darwin" });
  expect(adapter.available()).toBe(false);
  expect(mocks.requireCalls).not.toHaveBeenCalled();
  expect(mocks.exists).toHaveBeenCalledOnce();
});
