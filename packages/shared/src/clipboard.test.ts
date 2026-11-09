import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reports success only once the clipboard accepts the text", async () => {
  let clipboard = "original";
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async (value: string) => {
        clipboard = value;
      },
    },
  });
  expect(await copyText("new text")).toBe(true);
  expect(clipboard).toBe("new text");
});

it("reports a rejected write without changing the clipboard", async () => {
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw new Error("Write permission denied");
      },
    },
  });
  expect(await copyText("new text")).toBe(false);
});

it("keeps plain-HTTP selection copying and cleans up even when it is refused", async () => {
  const field = {
    value: "",
    readOnly: false,
    style: { position: "", opacity: "" },
    select: vi.fn(),
    remove: vi.fn(),
  };
  const execCommand = vi.fn(() => true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", {
    activeElement: null,
    createElement: () => field,
    body: { append: vi.fn() },
    execCommand,
  });
  vi.stubGlobal("HTMLElement", class {});
  expect(await copyText("new text")).toBe(true);
  expect(field.value).toBe("new text");
  execCommand.mockImplementation(() => {
    throw new Error("Copy refused");
  });
  expect(await copyText("another text")).toBe(false);
  expect(field.remove).toHaveBeenCalledTimes(2);
});
