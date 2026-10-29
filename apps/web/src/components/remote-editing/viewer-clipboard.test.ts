// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerClipboard } from "./viewer-clipboard.js";
const text = (value: string) => ({ type: "text/plain", bytes: new TextEncoder().encode(value) });
afterEach(() => vi.unstubAllGlobals());
describe("viewer clipboard gesture ownership", () => {
  it("visibly refuses image-only copy in gesture, direct and native paths", async () => {
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(_data: unknown) {}
      },
    );
    const write = vi.fn(async () => undefined);
    const image = [{ type: "image/png", bytes: new Uint8Array([1, 2, 3]) }];
    const errors: string[] = [];
    const clipboard = new ViewerClipboard((message) => errors.push(message), write);
    const arm = clipboard.arm("copy");
    arm.resolve(image);
    expect(await arm.done).toBe(false);
    await expect(clipboard.write(image)).rejects.toThrow("Copy Image");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Copy Image");
    expect(write).not.toHaveBeenCalled();
    clipboard.dispose();
  });
  it("arms both promised representations synchronously and resolves only after the result", async () => {
    let representations: Record<string, Promise<Blob>> = {};
    class Item {
      constructor(data: Record<string, Promise<Blob>>) {
        representations = data;
      }
    }
    const write = vi.fn(async () => {
      await Promise.all(Object.values(representations));
    });
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { clipboard: { write } });
    const errors: string[] = [];
    const clipboard = new ViewerClipboard((message) => errors.push(message));
    const armed = clipboard.arm("copy");
    expect(write).toHaveBeenCalledTimes(1);
    expect(Object.keys(representations)).toEqual(["text/plain", "text/html"]);
    armed.resolve([text("native text")]);
    expect(await armed.done).toBe(true);
    expect(await (await representations["text/plain"]!).text()).toBe("native text");
    expect(errors).toEqual([]);
    clipboard.dispose();
  });
  it("rejects an empty result without writing clipboard data and surfaces real permission failures", async () => {
    let representations: Record<string, Promise<Blob>> = {};
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(data: Record<string, Promise<Blob>>) {
          representations = data;
        }
      },
    );
    vi.stubGlobal("navigator", {
      clipboard: {
        write: vi.fn(async () => {
          await Promise.all(Object.values(representations));
        }),
      },
    });
    const errors: string[] = [];
    const clipboard = new ViewerClipboard((message) => errors.push(message));
    const armed = clipboard.arm("copy");
    armed.reject();
    expect(await armed.done).toBe(false);
    expect(errors).toEqual([]);
    Reflect.set(navigator.clipboard, "write", async () => {
      throw new Error("Permission denied");
    });
    const denied = clipboard.arm("copy");
    denied.resolve([text("a")]);
    expect(await denied.done).toBe(false);
    expect(errors).toEqual(["Permission denied"]);
    clipboard.dispose();
  });
  it("matches the latest forwarded activation and writes later attributed data directly", async () => {
    const native = vi.fn(async () => undefined);
    const clipboard = new ViewerClipboard(() => undefined, native);
    clipboard.armActivation();
    await clipboard.written([text("a")]);
    expect(native).toHaveBeenCalledTimes(1);
    await clipboard.written([text("later")]);
    expect(native).toHaveBeenCalledTimes(2);
    clipboard.dispose();
  });
});
