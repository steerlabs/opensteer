// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { placeList } from "@opensteer/client/host";
import { client, mount, element } from "./workspace.interaction.test-support.js";

describe("workspace tab commands", () => {
  it("lets a tab's title run to the row's edge, its close opening for a pointer, the keyboard or a finger", async () => {
    const stylesheet = (...names: string[]) =>
      names.map((name) => readFileSync(`apps/web/src/styles/${name}.css`, "utf8")).join("\n");
    await mount("/");
    const style = document.createElement("style");
    style.textContent = stylesheet("tokens", "workspace");
    document.body.append(style);
    const fixed = placeList(client.getSnapshot()).find((place) => !place.closable)!;
    const row = element(`.side-tab[data-place-key="${fixed.key}"]`);
    expect(row.querySelector(".side-tab__close-slot, .side-row-action")).toBeNull();
    const title = getComputedStyle(element(".side-tab__title", row));
    expect(title.flexGrow).toBe("1");
    expect(title.textOverflow).not.toBe("ellipsis");
    expect(title.maskImage).toContain("linear-gradient");

    // happy-dom applies neither :hover nor :focus-within, so the rendered row
    // and the real stylesheet go to Chromium.
    const closable = element(".side-tab__close").closest(".side-tab")!.outerHTML;
    const browser = await chromium.launch();
    try {
      const open = async (touch: boolean) => {
        const page = await browser.newPage({
          hasTouch: touch,
          isMobile: touch,
          reducedMotion: "reduce",
        });
        await page.setContent(`<ul style="width: 280px">${closable}</ul>`);
        await page.addStyleTag({ content: stylesheet("tokens", "base", "workspace") });
        return page;
      };
      const width = (page: Page) =>
        page.locator(".side-tab__close").evaluate((node) => node.getBoundingClientRect().width);
      const desk = await open(false);
      expect(await width(desk), "close takes room at rest").toBe(0);
      await desk.hover(".side-tab");
      await desk.click(".side-tab__close", { timeout: 2_000, trial: true });
      await desk.mouse.move(900, 600);
      expect(await width(desk), "close stays open after the pointer leaves").toBe(0);
      await desk.focus(".side-tab__main");
      expect(await width(desk), "keyboard focus never opened close").toBeGreaterThan(0);
      expect(await width(await open(true)), "close hidden without hover").toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});
