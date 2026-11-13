import { browser } from "../apps/browser.js";
import { cmecf } from "../apps/cmecf.js";
import { finder } from "../apps/finder.js";
import type { Scene, SceneApi } from "../scene.js";

const CHROME = ["Chrome", "File", "Edit", "View", "History", "Bookmarks", "Profiles", "Tab"];
/* The cursor's move takes 600ms; a click waits for it to land, then a beat. */
const ARRIVE = 800;

function downloaded(api: SceneApi): void {
  api.click();
  api.at(250, () => {
    api.flag("ecf-over-accept", false);
    api.step("Bought docket 41 to 43 from PACER for $3.00");
  });
  api.at(1100, () => {
    api.front("finder");
    api.flag("fd-new");
    api.step("Filed them in the Ardent case folder", "pencil", "Documents/Legal/Lumen v. Ardent");
  });
  /* After the window's opening transition, so the cursor lands on the file and not where it was mid-scale. */
  api.at(1700, () => api.go("fd-first", 0.3, 0.5));
  api.at(3400, () =>
    api.finish(
      "Ardent moved to dismiss on Nov 12, with a supporting declaration, and filed its ADR certification on Nov 16. Our opposition is due Nov 26; the hearing is Dec 17. All three are in the case folder.",
    ),
  );
}

function declined(api: SceneApi): void {
  api.flag("ecf-over-accept", false);
  api.go("br-back");
  api.at(ARRIVE + 100, () => {
    api.click();
    api.flag("ecf-bill", false);
  });
  api.at(2000, () =>
    api.finish(
      "I didn't buy anything. The three new filings are docket 41 to 43, a motion to dismiss with its declaration and an ADR certification. They're $3.00 whenever you want them.",
      "stopped",
    ),
  );
}

export const legal: Scene = {
  agent: "legal",
  task: "New filings in Ardent",
  opener: { text: "Pull the new filings in the Ardent case." },
  beats: [
    "You ask your legal agent for the latest filings.",
    "Your agent checks the court docket in PACER on your Mac.",
    "Your agent asks you before spending $3.00.",
  ],
  length: 20000,
  windows: browser("left:40px;top:44px;width:1200px;height:708px", [cmecf]) + finder,
  menus: {
    cmecf: CHROME,
    finder: ["Finder", "File", "Edit", "View", "Go", "Window", "Help"],
  },
  run(api) {
    let t = 0;
    const beat = (gap: number, run: () => void): void => {
      t += gap;
      api.at(t, run);
    };
    beat(600, () => {
      api.stage(2, 11400);
      api.go("ecf-case-field", 0.3, 0.5);
    });
    beat(ARRIVE, () => {
      api.click();
      api.flag("ecf-at-case");
      api.type("ecf-case", "3:26-cv-04417");
    });
    beat(500, () => {
      api.flag("ecf-at-case", false);
      api.go("ecf-run");
    });
    beat(ARRIVE - 150, () => api.flag("ecf-over-run"));
    beat(250, () => {
      api.click();
      api.flag("ecf-over-run", false);
      api.flag("ecf-menu");
      api.step("Opened Lumen v. Ardent in PACER");
    });
    beat(500, () => api.go("ecf-docket-link", 0.4, 0.5));
    beat(ARRIVE - 150, () => api.flag("ecf-over-docket"));
    beat(250, () => {
      api.click();
      api.flag("ecf-over-docket", false);
      api.flag("ecf-docket");
    });
    beat(900, () => api.flag("ecf-scroll"));
    beat(900, () => {
      api.step("Found 3 new filings since Nov 10");
      api.go("ecf-box-41");
    });
    for (const number of ["41", "42", "43"]) {
      if (number !== "41") beat(450, () => api.go(`ecf-box-${number}`));
      beat(number === "41" ? ARRIVE : 650, () => {
        api.click();
        api.flag(`ecf-c${number}`);
      });
    }
    beat(400, () => api.go("ecf-download"));
    beat(ARRIVE - 150, () => api.flag("ecf-over-download"));
    beat(250, () => {
      api.click();
      api.flag("ecf-over-download", false);
      api.flag("ecf-bill");
    });
    beat(900, () => api.go("ecf-accept", 0.5, 0.55));
    beat(ARRIVE, () => {
      api.flag("ecf-over-accept");
      api.stage(3, 7500);
      api.ask({
        title: "Download 3 documents from PACER for $3.00?",
        body: "Docket 41 to 43 in Lumen Studio v. Ardent Media: 30 pages at $0.10 a page.",
        onAllow: () => downloaded(api),
        onDeny: () => declined(api),
      });
    });
  },
};
