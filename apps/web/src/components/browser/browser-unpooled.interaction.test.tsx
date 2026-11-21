// @vitest-environment happy-dom
import { placeList } from "@opensteer/client/host";
import { expect, it } from "vitest";
import {
  click,
  element,
  isMockPage,
  mount,
  pageTab,
  settle,
  tabSearch,
  until,
} from "../workspace/workspace.interaction.test-support.js";

/**
 * A browser on a person's own Mac or a self-hosted Home has no pool: what its page shows is
 * pinned here byte for byte, so the Cloud Computer's sleep and wake add nothing to it. The
 * snapshot was written on the commit before any of that existed and must never be rewritten.
 */

/** The page as drawn, without the per-render ids React and the mock mint. */
function drawn(node: Element): string {
  return node.outerHTML.replace(/\b(id|for|aria-controls|aria-labelledby)="[^"]*"/gu, '$1=""');
}

async function shownPage(width: number) {
  await mount((source) => `/${tabSearch(pageTab(source))}`, { width });
  const view = await until("The page was never shown", () => element(".browser-view"));
  await settle(80);
  return view;
}

it("draws a running page on a wide screen exactly as before", async () => {
  expect(drawn(await shownPage(1440))).toMatchSnapshot();
});

it("draws a running page on a phone-wide screen exactly as before", async () => {
  expect(drawn(await shownPage(390))).toMatchSnapshot();
});

it("offers exactly the same browser options as before", async () => {
  await shownPage(1440);
  await click(element('.place [aria-label="Browser options"]'));
  const items = await until("The browser's options never opened", () => {
    const listed = [...document.querySelectorAll(".popover [role=menuitem]")].map((item) =>
      item.textContent?.trim(),
    );
    expect(listed.length).toBeGreaterThan(0);
    return listed;
  });
  expect(items).toMatchSnapshot();
});

it("draws a tab that sleeps on its own computer exactly as before", async () => {
  await mount(
    (source) => {
      const asleep = placeList(source.getSnapshot()).find(
        (item) => item.kind === "page" && !isMockPage(item),
      );
      if (!asleep) throw new Error("The mock world has no sleeping tab");
      return `/${tabSearch(asleep)}`;
    },
    { mock: { world: "busy" } },
  );
  const view = await until("The sleeping tab was never shown", () => element(".browser-view"));
  await settle(80);
  expect(drawn(view)).toMatchSnapshot();
});
