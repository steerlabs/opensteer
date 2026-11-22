import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Our native views' functions, called so the JavaScript thread never waits for the main thread:
 * on an iOS binary that declares `viewTagFunctions`, by the view's tag through
 * `<name>ForView(tag, …)` (a number, which Expo converts without touching the main thread),
 * never through the view's own functions, whose view argument Expo resolves on the JavaScript
 * thread with `DispatchQueue.main.sync`. Android and an older binary keep the view's functions.
 */

const platform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
const modules = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) => modules.get(name) ?? null,
}));

afterEach(() => {
  modules.clear();
  platform.OS = "ios";
  vi.resetModules();
});

async function load() {
  return import("./view-functions.js");
}

interface Calls {
  [name: string]: (...args: unknown[]) => Promise<unknown>;
  present: (...args: unknown[]) => Promise<unknown>;
  clear: (...args: unknown[]) => Promise<unknown>;
}

function view(tag: number | null) {
  return {
    nativeTag: tag,
    present: vi.fn(async (..._args: unknown[]) => "presented"),
    clear: vi.fn(async (..._args: unknown[]) => undefined),
  };
}

describe("a native view's functions", () => {
  it("are called by the view's tag where the binary offers it, never as the view's own", async () => {
    const presentForView = vi.fn(async (..._args: unknown[]) => "presented");
    const clearForView = vi.fn(async (..._args: unknown[]) => undefined);
    modules.set("PhoneDisplay", { viewTagFunctions: 1, presentForView, clearForView });
    const { viewFunctionsOf, viewTagModule } = await load();
    const instance = view(42);
    const calls = viewFunctionsOf<Calls>(
      viewTagModule("PhoneDisplay"),
      instance as unknown as Calls,
      ["present", "clear"],
    )!;
    const bytes = new Uint8Array([1]);
    await calls.present(bytes, { generation: 3 });
    await calls.clear(4);
    expect(presentForView).toHaveBeenCalledExactlyOnceWith(42, bytes, { generation: 3 });
    expect(clearForView).toHaveBeenCalledExactlyOnceWith(42, 4);
    expect(instance.present).not.toHaveBeenCalled();
    expect(instance.clear).not.toHaveBeenCalled();
  });

  it("refuse a call before the view is mounted, without calling anything native", async () => {
    const presentForView = vi.fn(async () => "presented");
    modules.set("PhoneDisplay", { viewTagFunctions: 1, presentForView });
    const { viewFunctionsOf, viewTagModule } = await load();
    const instance = view(null);
    const calls = viewFunctionsOf<Calls>(
      viewTagModule("PhoneDisplay"),
      instance as unknown as Calls,
      ["present"],
    )!;
    await expect(calls.present()).rejects.toThrow("not mounted");
    expect(presentForView).not.toHaveBeenCalled();
    expect(instance.present).not.toHaveBeenCalled();
  });

  it.each([
    ["Android, whose view functions run on the main queue", "android", { viewTagFunctions: 1 }],
    ["an older iOS binary without calls by tag", "ios", {}],
  ] as const)("stay the view's own on %s", async (_name, os, module) => {
    platform.OS = os;
    modules.set("PhoneDisplay", { ...module, presentForView: vi.fn() });
    const { viewFunctionsOf, viewTagModule } = await load();
    const instance = view(42);
    const calls = viewFunctionsOf<Calls>(
      viewTagModule("PhoneDisplay"),
      instance as unknown as Calls,
      ["present"],
    )!;
    await calls.present();
    expect(instance.present).toHaveBeenCalledOnce();
  });
});
