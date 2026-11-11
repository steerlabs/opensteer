import { browser } from "../apps/browser.js";
import { slack } from "../apps/slack.js";
import { stripe } from "../apps/stripe.js";
import { zendesk } from "../apps/zendesk.js";
import type { Scene, SceneApi } from "../scene.js";

const REPLY =
  "Hi Dana, you're right, and I'm sorry. Invoice 2291 was charged twice on Nov 3. I've refunded the extra $480.00. It should reach your card in 5 to 10 days.";
const UPDATE =
  "Northwind was charged twice for invoice 2291. Refunded the extra $480 and replied to Dana. Ticket #4821 is solved.";
const CHROME = ["Chrome", "File", "Edit", "View", "History", "Bookmarks", "Tab"];

function refunded(api: SceneApi): void {
  api.flag("modal", false);
  api.flag("held", false);
  api.flag("refunded");
  api.status("working");
  api.step("Refunded $480 to Northwind");
  api.at(1100, () => {
    api.front("zendesk");
    api.go("zd-submit");
  });
  api.at(1900, () => {
    api.click();
    api.flag("sent");
    api.text("zd-sent", REPLY);
    api.text("zd-reply", "");
    api.text("zd-status", "Solved");
    api.step("Sent the reply and solved the ticket");
  });
  api.at(3100, () => {
    api.front("slack");
    api.go("sl-compose", 0.1, 0.4);
  });
  api.at(3700, () => {
    api.click();
    api.type("sl-compose", UPDATE, () => {
      api.flag("posted");
      api.text("sl-posted", UPDATE);
      api.text("sl-compose", "");
      api.step("Posted an update in #support");
      api.status("done");
    });
  });
  api.at(7400, () =>
    api.say("Add a $50 credit for the trouble.", () => {
      api.status("working");
      api.front("stripe");
      api.go("st-credit");
      api.label("Steer it anytime", "phone:composer", 1, 0.5, "R", 46, 2000);
      api.at(900, () => {
        api.click();
        api.flag("credit");
        api.step("Added a $50 credit");
        api.status("done");
        api.restart(3800);
      });
    }),
  );
}

function denied(api: SceneApi): void {
  api.flag("modal", false);
  api.flag("held", false);
  api.step("Refund cancelled. Nothing moved.", "stop");
  api.status("stopped");
  api.at(2200, () =>
    api.say("Leave it. I'll call Dana myself.", () => {
      api.step("Kept your reply as a draft");
      api.restart(3800);
    }),
  );
}

export const support: Scene = {
  agent: "support",
  task: "Dana's double charge",
  length: 38000,
  windows: browser("left:0;top:0;width:690px;height:530px", [zendesk, stripe]) + slack,
  menus: {
    zendesk: CHROME,
    stripe: CHROME,
    slack: ["Slack", "File", "Edit", "View", "Go", "Window"],
  },
  run(api) {
    api.at(900, () => {
      api.flag("arrived");
      api.text("zd-count", "6");
      api.status("working");
      api.go("zd-row", 0.4, 0.5);
    });
    api.at(1700, () => api.notify("Dana at Northwind says she was charged twice. I'm on it."));
    api.at(2300, () =>
      api.label("It noticed before you did", "phone:banner", 1, 0.5, "R", 44, 1700),
    );
    api.at(4400, () => api.label("Live from your Mac", "phone:live", 1, 0.5, "R", 44, 2200));
    api.at(4900, () => {
      api.click();
      api.flag("ticket");
      api.step("Read Dana's ticket");
    });
    api.at(6100, () => api.front("stripe"));
    api.at(6700, () => {
      api.go("st-first", 0.3, 0.5);
      api.label("Already signed in. Nothing to set up.", "st-account", 0.5, 1, "B", 30, 2400);
    });
    api.at(7900, () => api.go("st-second", 0.5, 0.5));
    api.at(8600, () => {
      api.click();
      api.flag("dup");
      api.step("Found the same $480 charge twice");
    });
    api.at(10000, () => {
      api.front("zendesk");
      api.go("zd-reply", 0.12, 0.3);
    });
    api.at(10700, () => {
      api.click();
      api.label("Working in your real apps", "zd-reply", 0.5, 0, "T", 34, 2600);
      api.type("zd-reply", REPLY, () => api.step("Drafted a reply to Dana"));
    });
    api.at(14400, () => {
      api.front("stripe");
      api.go("st-refund");
    });
    api.at(15300, () => {
      api.click();
      api.flag("modal");
    });
    api.at(15800, () => api.go("st-go", 0.5, 0.55, "st-modal"));
    api.at(16500, () => {
      api.flag("held");
      api.ask({
        title: "Refund $480 to Northwind?",
        body: "Duplicate charge on Nov 3, Visa ••4242. Then send your reply to Dana.",
        allowed: "Allowed with Face ID",
        denied: "Not allowed. Nothing was refunded.",
        spark: "st-go",
        onAllow: () => refunded(api),
        onDeny: () => denied(api),
      });
    });
    api.at(17300, () =>
      api.label("Nothing moves until you allow it", "phone:request", 1, 0.3, "R", 46, 3000),
    );
  },
};
