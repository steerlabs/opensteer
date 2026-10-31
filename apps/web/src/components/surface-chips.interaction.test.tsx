// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { SurfaceChip, type ChipSurface } from "./surface-chips.js";

vi.mock("./computer-apps/computer-use-section.js", () => ({ AppMark: () => null }));
vi.mock("./workspace/workspace-context.js", () => ({ useOptionalWorkspace: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("keeps a neutral site mark in a surface chip until its icon decodes, with the same size after failure", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("apps/web/src/styles/browser.css", "utf8");
  const container = document.createElement("div");
  document.body.append(style, container);
  root = createRoot(container);
  const surface: ChipSurface = {
    key: "page",
    title: "Example",
    site: "example.com",
    destination: null,
    ended: false,
    acting: false,
  };
  const render = async (favicon: string | null) => {
    await act(async () =>
      root?.render(
        <MemoryRouter>
          <SurfaceChip surface={{ ...surface, favicon }} />
        </MemoryRouter>,
      ),
    );
  };
  const dimensions = () => {
    const css = getComputedStyle(container.querySelector(".site-mark")!);
    return [css.width, css.height, css.borderRadius];
  };
  await render(null);
  expect(container.querySelector(".site-mark")?.textContent).toBe("");
  expect(container.querySelector(".site-mark > svg")).not.toBeNull();
  expect(dimensions()).toEqual(["18px", "18px", "5px"]);
  vi.spyOn(HTMLImageElement.prototype, "decode").mockResolvedValue();
  await render("data:icon");
  const image = container.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: 32 });
  expect(getComputedStyle(image).opacity).toBe("0");
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(getComputedStyle(image).opacity).toBe("1");
  expect(dimensions()).toEqual(["18px", "18px", "5px"]);
  await render("data:broken");
  vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(new Error("decode"));
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("load")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".site-mark")?.textContent).toBe("");
  expect(dimensions()).toEqual(["18px", "18px", "5px"]);
});
