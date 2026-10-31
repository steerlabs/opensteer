// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SiteMark } from "./site-mark.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
beforeEach(() => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(32);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function mount(favicon: string | null) {
  const style = document.createElement("style");
  style.textContent = ["browser", "workspace"]
    .map((name) => readFileSync(`apps/web/src/styles/${name}.css`, "utf8"))
    .join("\n");
  document.body.append(style);
  const container = document.createElement("div");
  container.className = "start-tile__site";
  document.body.append(container);
  root = createRoot(container);
  const render = async (next: string | null) => {
    await act(async () => root?.render(<SiteMark favicon={next} />));
  };
  await render(favicon);
  return { container, render };
}

it("holds a neutral tile mark until the image decodes, then fades it in without resizing", async () => {
  const { container, render } = await mount(null);
  const dimensions = () => {
    const style = getComputedStyle(container.querySelector(".site-mark")!);
    return [style.width, style.height, style.borderRadius];
  };
  expect(container.textContent).toBe("");
  expect(container.querySelector("img")).toBeNull();
  expect(dimensions()).toEqual(["40px", "40px", "11px"]);
  let finish!: () => void;
  const decoded = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockReturnValue(decoded);
  await render("data:image/png;base64,Ymx1ZQ==");
  const image = container.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: 32 });
  expect(container.textContent).toBe("");
  expect(image.className).toBe("site-mark__image");
  expect(getComputedStyle(image).opacity).toBe("0");
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(decode).toHaveBeenCalled();
  expect(getComputedStyle(image).opacity).toBe("0");
  await act(async () => finish());
  expect(getComputedStyle(image).opacity).toBe("1");
  expect(getComputedStyle(container.querySelector(".site-mark > svg")!).opacity).toBe("0");
  expect(dimensions()).toEqual(["40px", "40px", "11px"]);
});

it("shows a neutral globe without a letter when no icon exists", async () => {
  const { container } = await mount(null);
  expect(container.textContent).toBe("");
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".site-mark > svg")).not.toBeNull();
});

it.each(["error", "decode"])(
  "keeps the neutral globe after an image %s failure",
  async (failure) => {
    const { container, render } = await mount("data:broken");
    const image = container.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 32 });
    if (failure === "decode")
      Object.defineProperty(image, "decode", { value: () => Promise.reject(new Error("decode")) });
    await act(async () => image.dispatchEvent(new Event(failure === "decode" ? "load" : "error")));
    expect(container.textContent).toBe("");
    expect(container.querySelector("img")).toBeNull();
    await render("data:replacement");
    expect(container.textContent).toBe("");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:replacement");
  },
);

it("disables the icon fade for reduced motion", () => {
  const css = readFileSync("apps/web/src/styles/browser.css", "utf8");
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.site-mark__image\s*\{\s*transition: none;/u,
  );
});

it.each([1, 7, 8])("rejects placeholder icons below 8px (decoded width %i)", async (width) => {
  const { container } = await mount("data:icon");
  const image = container.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: width });
  await act(async () => image.dispatchEvent(new Event("load")));
  expect(container.querySelector("img")).toBe(width < 8 ? null : image);
  expect(getComputedStyle(container.querySelector(".site-mark > svg")!).opacity).toBe(
    width < 8 ? "" : "0",
  );
  if (width >= 8) expect(image.classList.contains("is-ready")).toBe(true);
});
