import { ariba } from "../apps/ariba.js";
import { browser } from "../apps/browser.js";
import { quickbooks } from "../apps/quickbooks.js";
import { sap } from "../apps/sap.js";
import type { Scene, SceneApi } from "../scene.js";

const CHROME = ["Chrome", "File", "Edit", "View", "History", "Bookmarks", "Profiles", "Tab"];
/* The cursor's move takes 600ms; a click waits for it to land, then a beat. */
const ARRIVE = 800;

function submitted(api: SceneApi): void {
  api.click();
  api.at(250, () => {
    api.flag("ar-over-submit", false);
    api.flag("ar-done");
    api.step("Submitted invoice LUMEN-0143 for $12,675.00");
  });
  api.at(900, () => api.go("ar-done-title", 0.6, 1.6));
  api.at(2600, () =>
    api.finish(
      "Invoice LUMEN-0143 for $12,675.00 is in Brightline's portal against PO 4500018872. It's due Dec 1, and it's in QuickBooks too.",
    ),
  );
}

function saved(api: SceneApi): void {
  api.flag("ar-over-submit", false);
  api.go("ar-save");
  api.at(ARRIVE - 150, () => api.flag("ar-over-save"));
  api.at(ARRIVE + 100, () => {
    api.click();
    api.flag("ar-over-save", false);
  });
  api.at(2000, () =>
    api.finish(
      "I didn't submit it. The invoice is saved as a draft in Brightline's portal, and it's in QuickBooks.",
      "stopped",
    ),
  );
}

export const billing: Scene = {
  agent: "billing",
  task: "Bill Brightline",
  opener: {
    from: "Monthly billing",
    text: "Invoice Brightline Health for October's hours.",
  },
  beats: [
    "Your billing agent starts October's invoice on schedule.",
    "Your agent works in SAP, QuickBooks and a customer portal on your Mac.",
    "Your agent asks you before submitting $12,675.",
  ],
  length: 23500,
  windows:
    sap + quickbooks + browser("left:40px;top:44px;width:1200px;height:708px", [ariba], true),
  menus: {
    sap: ["SAP GUI for Java", "Edit", "Window", "Help"],
    quickbooks: ["QuickBooks 2024", "File", "Edit", "View", "Lists", "Company", "Customers"],
    ariba: CHROME,
  },
  run(api) {
    /* On the first play the Mac is out of frame until the push is tapped, about 2.8s in. Later loops still hold the
       first step long enough to read. */
    const lead = api.intro ? 2200 : 1300;
    let t = lead;
    const beat = (gap: number, run: () => void): void => {
      t += gap;
      api.at(t, run);
    };
    api.at(800, () => api.notify("It's billing day. I'm invoicing Brightline Health for October."));
    api.stage(1, 1500 + lead);

    /* SAP: the hours */
    beat(1500, () => {
      api.stage(2, 14500);
      api.go("sap-row", 0.5, 0.5);
    });
    beat(ARRIVE + 100, () => {
      api.click();
      api.flag("sap-pick");
    });
    beat(500, () => api.go("sap-hours", 0.3, 0.6));
    beat(1100, () => api.step("Read October hours in SAP"));

    /* QuickBooks: the invoice */
    beat(500, () => {
      api.front("quickbooks");
      api.go("qb-create", 0.4, 0.5);
    });
    beat(ARRIVE - 150, () => api.flag("qb-over-create"));
    beat(250, () => {
      api.click();
      api.flag("qb-over-create", false);
      api.flag("qb-new");
    });
    beat(300, () => api.go("qb-customer", 0.3, 0.5));
    beat(ARRIVE, () => {
      api.click();
      api.flag("qb-focus");
      api.type("qb-typed", "Brightline Health");
    });
    beat(700, () => {
      api.flag("qb-focus", false);
      api.flag("qb-cust");
      api.go("qb-line", 0.35, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("qb-line");
    });
    beat(700, () => api.go("qb-save"));
    beat(ARRIVE - 150, () => api.flag("qb-over-save"));
    beat(250, () => {
      api.click();
      api.flag("qb-over-save", false);
      api.flag("qb-saved");
      api.step("Created invoice LUMEN-0143 in QuickBooks");
    });

    /* The customer's portal: key it in */
    beat(900, () => {
      api.front("ariba");
      api.go("ar-no-field", 0.3, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("ar-at-no");
      api.type("ar-no", "LUMEN-0143");
    });
    beat(500, () => {
      api.flag("ar-at-no", false);
      api.go("ar-desc-field", 0.2, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("ar-at-desc");
      api.type("ar-desc", "Patient portal redesign, October 2026");
    });
    beat(800, () => {
      api.flag("ar-at-desc", false);
      api.go("ar-next");
    });
    beat(ARRIVE - 150, () => api.flag("ar-over-next"));
    beat(250, () => {
      api.click();
      api.flag("ar-over-next", false);
      api.flag("ar-review");
      api.step("Keyed it into Brightline's supplier portal");
    });
    beat(900, () => api.go("ar-submit", 0.5, 0.55));
    beat(ARRIVE, () => {
      api.flag("ar-over-submit");
      api.stage(3, 9000);
      api.ask({
        title: "Submit invoice LUMEN-0143 for $12,675.00 to Brightline Health?",
        body: "84.5 hours of the patient portal redesign in October, against PO 4500018872. Net 14, due Dec 1.",
        onAllow: () => submitted(api),
        onDeny: () => saved(api),
      });
    });
  },
};
