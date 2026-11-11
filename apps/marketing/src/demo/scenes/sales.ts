import { browser } from "../apps/browser.js";
import { gmail } from "../apps/gmail.js";
import { HUBSPOT_NOTE, hubspot } from "../apps/hubspot.js";
import { linkedin } from "../apps/linkedin.js";
import type { Scene, SceneApi } from "../scene.js";

const CHROME = ["Chrome", "File", "Edit", "View", "History", "Bookmarks", "Tab"];
const SUBJECT = "Acme renewal for 2027";
const EMAIL = [
  ["gm-p1", "Hi Priya,"],
  ["gm-p2", "Congrats on growing the ops team to 120 people. Loved your post on onboarding."],
  ["gm-p3", "I've updated your 2027 renewal for all 120 seats: $48,000 a year. Quote attached."],
  ["gm-p4", "Free Thursday to walk through it?"],
  ["gm-p5", "Alex"],
] as const;
/* The cursor's move takes 720ms; a click waits for it to land, then a beat. */
const ARRIVE = 850;

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
  });
  api.at(2200, () => {
    api.flag("gm-saved");
    api.go("gm-send", 0.4, 0.5);
    api.step("Drafted the email to Priya. It's ready for you to send.");
    api.status("done");
  });
  api.restart(4600);
}

export const sales: Scene = {
  agent: "sales",
  task: "Acme's $48k renewal",
  length: 28000,
  windows: browser("left:0;top:0;width:690px;height:530px", [linkedin, hubspot, gmail]),
  menus: { linkedin: CHROME, hubspot: CHROME, gmail: CHROME },
  run(api) {
    let t = 0;
    const beat = (gap: number, run: () => void): void => {
      t += gap;
      api.at(t, run);
    };

    beat(300, () => {
      api.status("working");
      api.go("li-headline", 0.35, 0.5);
    });
    beat(1000, () => api.flag("li-down"));
    beat(900, () => api.go("li-team", 0.5, 0.6, "li-post"));
    beat(ARRIVE, () => api.flag("li-team"));
    beat(350, () => api.go("li-onboard", 0.3, 0.6, "li-post"));
    beat(ARRIVE, () => api.flag("li-onboard"));
    beat(800, () => api.go("li-tenure", 0.6, 0.5));
    beat(ARRIVE, () => {
      api.flag("li-role");
      api.step("Read Priya's LinkedIn");
    });
    beat(500, () => api.step("Team grew to 120, repriced the renewal"));

    beat(400, () => {
      api.front("hubspot");
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
    beat(450, () => {
      api.flag("hs-amt", false);
      api.flag("hs-repriced");
      api.text("hs-head-amount", "$48,000");
      api.text("hs-qty", "120");
    });
    beat(300, () => api.go("hs-stage-field", 0.5, 0.5));
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
      api.go("hs-stage-field", 0.5, 0.5, "hs-pipe");
      api.step("Updated the Acme deal: $48,000, quote prepared");
    });
    beat(800, () => api.go("hs-note-btn", 0.5, 0.25));
    beat(ARRIVE, () => {
      api.click();
      api.flag("hs-noting");
    });
    beat(350, () => {
      api.go("hs-note", 0.08, 0.2, "hs-editor");
      api.type("hs-note", HUBSPOT_NOTE);
    });
    beat(typing(HUBSPOT_NOTE) + 300, () => api.go("hs-save"));
    beat(ARRIVE, () => {
      api.click();
      api.flag("hs-noted");
      api.step("Logged a note on the deal");
    });

    beat(600, () => {
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
