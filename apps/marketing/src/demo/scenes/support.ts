import { browser } from "../apps/browser.js";
import { stripe } from "../apps/stripe.js";
import { zendesk } from "../apps/zendesk.js";
import type { Scene, SceneApi } from "../scene.js";

const REPLY =
  "Hi Dana, you're right, and I'm sorry. Invoice 2291 was charged twice on Nov 3. I've refunded the extra $480.00, and it should reach your card in 5 to 10 days.";
const CHROME = ["Chrome", "File", "Edit", "View", "History", "Bookmarks", "Profiles", "Tab"];
/* The cursor's move takes 600ms; a click waits for it to land, then a beat. */
const ARRIVE = 800;

function refunded(api: SceneApi): void {
  api.click();
  api.at(250, () => {
    api.flag("modal", false);
    api.flag("over-go", false);
    api.flag("refunded");
    api.flag("toast");
    api.step("Refunded $480.00 to Visa •••• 4242");
  });
  api.at(2000, () => {
    api.front("zendesk");
    api.go("zd-reply", 0.2, 0.3);
  });
  api.at(2000 + ARRIVE, () => {
    api.click();
    api.flag("typing");
    api.type("zd-reply", REPLY);
  });
  api.at(5400, () => api.go("zd-submit"));
  api.at(5400 + ARRIVE - 150, () => api.flag("over-submit"));
  api.at(5400 + ARRIVE + 150, () => {
    api.click();
    api.flag("typing", false);
    api.flag("sent");
    api.text("zd-sent", REPLY);
    api.text("zd-reply", "");
    api.text("zd-status", "Solved");
    api.step("Replied to Dana and solved ticket #4821");
  });
  api.at(7600, () =>
    api.finish(
      "Northwind was charged twice for invoice 2291. I refunded the extra $480 and replied to Dana. Ticket #4821 is solved.",
    ),
  );
}

function denied(api: SceneApi): void {
  api.flag("over-go", false);
  api.go("st-cancel");
  api.at(ARRIVE - 150, () => api.flag("over-cancel"));
  api.at(ARRIVE + 100, () => {
    api.click();
    api.flag("modal", false);
    api.flag("over-cancel", false);
  });
  api.at(2000, () =>
    api.finish(
      "I didn't refund anything. Ticket #4821 is still open and assigned to you.",
      "stopped",
    ),
  );
}

export const support: Scene = {
  agent: "support",
  task: "Dana's double charge",
  opener: {
    from: "New Zendesk tickets",
    text: "Charged twice for November\nDana Whitfield · Northwind",
  },
  beats: [
    "Your support agent spots a double charge.",
    "Your agent checks Zendesk and Stripe on your Mac.",
    "Your agent asks you before refunding $480.",
  ],
  length: 22300,
  windows: browser("left:40px;top:44px;width:1200px;height:708px", [zendesk, stripe]),
  menus: { zendesk: CHROME, stripe: CHROME },
  run(api) {
    /* On the first play the Mac is out of frame until the push is tapped, about 2.8s in. Later loops still hold the
       first step long enough to read. */
    const lead = api.intro ? 2200 : 1300;
    const after = (ms: number, step: () => void): void => api.at(ms + lead, step);
    api.at(800, () => {
      api.flag("arrived");
      api.text("zd-count", "6");
      api.text("zd-total", "6");
      api.notify("New ticket from Dana at Northwind: charged twice. I'm looking into it.");
    });
    api.stage(1, 1500 + lead);
    after(1500, () => {
      api.stage(2, 9300);
      api.go("zd-row", 0.34, 0.5);
    });
    after(1500 + ARRIVE - 150, () => api.flag("over-row"));
    after(1500 + ARRIVE + 100, () => {
      api.click();
      api.flag("ticket");
      api.step("Opened ticket #4821 in Zendesk");
    });
    after(3000, () => api.go("zd-msg", 0.42, 0.7));
    after(5200, () => {
      api.front("stripe");
      api.step("Looked up Northwind in Stripe");
    });
    after(5800, () => {
      api.go("st-first", 0.5, 0.5);
      api.flag("over-first");
    });
    after(7000, () => {
      api.go("st-more");
      api.flag("over-first", false);
      api.flag("over-second");
    });
    after(7000 + ARRIVE + 300, () => {
      api.click();
      api.flag("menu");
    });
    after(8500, () => {
      api.go("st-refund", 0.4, 0.5);
      api.flag("over-refund");
    });
    after(8500 + ARRIVE, () => {
      api.click();
      api.flag("menu", false);
      api.flag("over-refund", false);
      api.flag("over-second", false);
      api.flag("modal");
    });
    after(10000, () => api.go("st-go", 0.5, 0.55, "st-modal"));
    after(10000 + ARRIVE, () => {
      api.flag("over-go");
      api.stage(3, 11500);
      api.ask({
        title: "Refund $480 to Northwind?",
        body: "Duplicate charge for invoice 2291 on Nov 3, Visa •••• 4242.",
        onAllow: () => refunded(api),
        onDeny: () => denied(api),
      });
    });
  },
};
