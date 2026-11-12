import { browser } from "../apps/browser.js";
import { gmail } from "../apps/gmail.js";
import { hubspot } from "../apps/hubspot.js";
import type { Scene, SceneApi } from "../scene.js";

const CHROME = ["Chrome", "File", "Edit", "View", "History", "Bookmarks", "Profiles", "Tab"];
const SUBJECT = "Acme renewal for 2027";
const EMAIL = [
  ["gm-p1", "Hi Priya,"],
  ["gm-p2", "Here's the 2027 renewal for all 120 seats: $48,000 a year. The quote is attached."],
  ["gm-p3", "Free Thursday to walk through it?"],
  ["gm-p4", "Alex"],
] as const;
/* The cursor's move takes 600ms; a click waits for it to land, then a beat. */
const ARRIVE = 800;

const typing = (text: string): number => Math.ceil(text.length / 2) * 30;

function typeLines(api: SceneApi, lines: readonly (readonly [string, string])[], done: () => void) {
  const [first, ...rest] = lines;
  if (!first) return done();
  api.type(first[0], first[1], () => api.at(140, () => typeLines(api, rest, done)));
}

function drafted(api: SceneApi): void {
  api.at(300, () => {
    api.flag("gm-at-body", false);
    api.go("gm-clip", 0.5, 0.5);
  });
  api.at(300 + ARRIVE, () => {
    api.click();
    api.flag("gm-attached");
    api.step("Drafted the email to Priya");
  });
  api.at(2000, () => api.go("gm-send", 0.4, 0.5));
  api.at(2000 + ARRIVE, () => {
    api.flag("gm-over-send");
    api.stage(3, 6500);
    api.ask({
      title: "Send the email to Priya?",
      body: "“Acme renewal for 2027”, with the quote attached.",
      onAllow() {
        api.click();
        api.at(250, () => {
          api.flag("gm-open", false);
          api.flag("gm-sent");
          api.step("Sent the email to Priya");
        });
        api.at(2600, () =>
          api.finish(
            "Acme's renewal is now $48,000 at Quote prepared, and Priya has the quote. I asked if Thursday works to walk through it.",
          ),
        );
      },
      onDeny() {
        api.flag("gm-over-send", false);
        api.flag("gm-saved");
        api.finish("I didn't send it. The email to Priya is saved in your drafts.", "stopped");
      },
    });
  });
}

export const sales: Scene = {
  agent: "sales",
  task: "Acme's renewal",
  opener: { text: "Acme is renewing. Update the deal and draft Priya the quote." },
  beats: [
    "You ask your sales agent to prep a renewal.",
    "Your agent preps the deal and email on your Mac.",
    "Your agent asks you before sending the email.",
  ],
  length: 21000,
  windows: browser("left:40px;top:44px;width:1200px;height:708px", [hubspot, gmail]),
  menus: { hubspot: CHROME, gmail: CHROME },
  run(api) {
    let t = 0;
    const beat = (gap: number, run: () => void): void => {
      t += gap;
      api.at(t, run);
    };

    beat(500, () => {
      api.stage(2, 15500);
      api.step("Opened Acme's renewal in HubSpot");
      api.go("hs-amount-field", 0.4, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("hs-amt");
      api.flag("hs-picked");
    });
    beat(400, () => {
      api.flag("hs-picked", false);
      api.type("hs-amount", "48,000");
    });
    beat(600, () => {
      api.flag("hs-amt", false);
      api.flag("hs-repriced");
      api.text("hs-head-amount", "$48,000");
      api.text("hs-qty", "120");
      api.go("hs-stage-field", 0.5, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("hs-menu");
    });
    beat(350, () => api.go("hs-opt", 0.35, 0.5));
    beat(650, () => api.flag("hs-hover"));
    beat(250, () => {
      api.click();
      api.flag("hs-menu", false);
      api.flag("hs-hover", false);
      api.flag("hs-quote");
      api.text("hs-stage", "Quote prepared");
      api.step("Updated the deal: $48,000, Quote prepared");
    });

    beat(1300, () => {
      api.front("gmail");
      api.go("gm-compose-btn", 0.45, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("gm-open");
    });
    beat(550, () => api.go("gm-to-field", 0.3, 0.5, "gm-subject-field"));
    beat(ARRIVE, () => {
      api.click();
      api.flag("gm-at-to");
      api.type("gm-to", "priya", () => api.flag("gm-suggest"));
    });
    beat(400, () => api.flag("gm-pick"));
    beat(250, () => {
      api.flag("gm-chip");
      api.flag("gm-at-to", false);
      api.text("gm-to", "");
      api.go("gm-subject-field", 0.3, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("gm-subject");
      api.flag("gm-at-subject");
      api.type("gm-subject", SUBJECT, () => api.text("gm-title", SUBJECT));
    });
    beat(typing(SUBJECT) + 250, () => {
      api.flag("gm-at-subject", false);
      api.go("gm-body", 0.25, 0.12);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("gm-at-body");
      typeLines(api, EMAIL, () => drafted(api));
    });
  },
};
