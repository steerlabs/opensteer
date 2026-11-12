import { browser } from "../apps/browser.js";
import { github } from "../apps/github.js";
import { shop } from "../apps/shop.js";
import { terminal } from "../apps/terminal.js";
import type { Scene, SceneApi } from "../scene.js";

const CHROME = ["Chrome", "File", "Edit", "View", "History", "Bookmarks", "Profiles", "Tab"];
/* The cursor's move takes 600ms; a click waits for it to land, then a beat. */
const ARRIVE = 800;

/** Clicks Pay: the button spins while the order posts, then `landed` runs. */
function pay(api: SceneApi, landed: () => void): void {
  api.go("shop-pay");
  api.at(ARRIVE - 150, () => api.flag("over-pay"));
  api.at(ARRIVE + 100, () => {
    api.click();
    api.flag("paying");
  });
  api.at(ARRIVE + 900, () => {
    api.flag("paying", false);
    api.flag("over-pay", false);
    landed();
  });
}

function pushed(api: SceneApi): void {
  api.step("Ran git push", "terminal", "git push origin main");
  api.at(1200, () => {
    api.front("github");
    api.go("gh-title", 0.5, 2.2);
  });
  api.at(3400, () =>
    api.finish(
      "Checkout was sending the order total in dollars, and the payment API wants cents. I fixed it in checkout.ts, placed a test order to confirm, and pushed to main.",
    ),
  );
}

export const engineer: Scene = {
  agent: "engineer",
  task: "Fix checkout",
  opener: { text: "Checkout's failing on the shop. Can you fix it?" },
  beats: [
    "You ask your engineering agent to fix checkout.",
    "Your agent fixes the bug on your Mac.",
    "Your agent asks you before shipping the fix.",
  ],
  length: 16000,
  windows: browser("left:24px;top:44px;width:852px;height:708px", [shop, github]) + terminal,
  menus: { shop: CHROME, github: CHROME },
  run(api) {
    api.at(600, () => {
      api.stage(2, 10000);
      api.step("Opened localhost:3000/checkout");
      pay(api, () => {
        api.flag("failed");
        api.flag("t-fail");
      });
    });
    api.at(3000, () => api.go("shop-error", 0.6, 0.5));
    api.at(5600, () => {
      api.step("Edited checkout.ts", "pencil", "lib/checkout.ts");
      api.flag("t-built");
    });
    api.at(6400, () => {
      api.go("br-reload");
    });
    api.at(6400 + ARRIVE, () => {
      api.click();
      api.flag("failed", false);
      api.flag("t-again");
    });
    api.at(7800, () =>
      pay(api, () => {
        api.flag("confirmed");
        api.flag("t-paid");
        api.text("shop-path", "/orders/1048");
        api.step("Placed a test order");
      }),
    );
    api.at(10600, () => {
      api.go("shop-done", 0.5, 0.3);
      api.stage(3, 7300);
      api.ask({
        title: "Push the fix to main?",
        body: "1 commit: Send checkout totals in cents",
        onAllow: () => pushed(api),
        onDeny() {
          api.finish(
            "I didn't push. The fix is committed on your Mac and ready whenever you are.",
            "stopped",
          );
        },
      });
    });
  },
};
