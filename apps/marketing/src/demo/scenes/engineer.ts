import { pos } from "../apps/pos.js";
import { qa } from "../apps/qa.js";
import type { Scene, SceneApi } from "../scene.js";

/* Till 2.4 at 9.5% tax: $48.00 + $34.50 + $18.50 = $101.00, 10% off is $10.10, so $90.90 is taxed.
   9.5% of $90.90 is $8.6355: $8.64 to the nearest cent, but build 411's checkout rounds it down to $8.63. */
const CART = [
  { count: "1 item", sub: "$48.00", tax: "$4.56", total: "$52.56" },
  { count: "2 items", sub: "$82.50", tax: "$7.84", total: "$90.34" },
  { count: "3 items", sub: "$101.00", tax: "$9.60", total: "$110.60" },
  { count: "3 items", sub: "$101.00", tax: "$8.64", total: "$99.54" },
] as const;

function cart(api: SceneApi, step: (typeof CART)[number]): void {
  api.text("pos-count", step.count);
  api.text("pos-sub", step.sub);
  api.text("pos-tax", step.tax);
  api.text("pos-total", step.total);
  api.text("pos-charge-amt", `Charge ${step.total}`);
}

function pass(api: SceneApi, check: number): void {
  api.flag(`q${check}`);
  if (check < 6) api.flag(`r${check + 1}`);
}

function add(api: SceneApi, at: number, product: string, line: number): void {
  const step = CART[line - 1];
  if (!step) return;
  api.at(at, () => api.go(`pos-${product}`, 0.5, 0.45, "pos-body"));
  api.at(at + 900, () => {
    api.click();
    api.flag(`i${line}`);
    cart(api, step);
  });
}

export const engineer: Scene = {
  agent: "engineer",
  task: "Test checkout before 2.4 ships",
  length: 24000,
  windows: pos + qa,
  menus: {
    pos: ["Till", "File", "Edit", "Order", "View", "Window", "Help"],
    qa: ["Test Run", "File", "Edit", "Run", "Window", "Help"],
  },
  run(api) {
    api.at(500, () => {
      api.status("working");
      api.go("qa-go");
    });
    api.at(1400, () => {
      api.click();
      api.flag("run");
      api.flag("r1");
    });
    api.at(1700, () => api.front("pos"));
    api.at(2300, () => {
      pass(api, 1);
      api.step("Opened Till 2.4");
      api.go("pos-new");
    });
    api.at(3200, () => {
      api.click();
      api.flag("order");
      api.text("pos-open", "5");
    });
    api.at(3500, () => pass(api, 2));

    add(api, 3700, "kettle", 1);
    add(api, 5000, "scale", 2);
    add(api, 6300, "blend", 3);
    api.at(7500, () => {
      pass(api, 3);
      api.step("Added 3 items to an order");
    });

    api.at(7700, () => api.go("pos-disc"));
    api.at(8600, () => {
      api.click();
      api.flag("pop");
    });
    api.at(8900, () => api.go("pos-d10"));
    api.at(9700, () => {
      api.click();
      api.flag("pop", false);
      api.flag("disc");
      const discounted = CART[3];
      if (discounted) cart(api, discounted);
    });
    api.at(10000, () => pass(api, 4));

    api.at(10200, () => api.go("pos-charge"));
    api.at(11100, () => {
      api.click();
      api.flag("sheet");
    });
    api.at(11600, () => api.go("pos-s-tax", -0.4, 0.6, "pos-sheet"));
    api.at(12400, () => {
      api.flag("x5");
      api.step("Tax is 1 cent off at checkout");
    });
    api.at(12900, () => api.go("qa-fail", 0.92, 0.2));
    api.at(13600, () => {
      api.flag("fixing");
      api.type("qa-fix", "Fixed rounding in Tax.swift, rebuilt 2.4 (412)", () => api.flag("fixed"));
    });

    api.at(14700, () => {
      api.step("Fixed the rounding, rebuilt");
      api.flag("relaunch");
      api.flag("sheet", false);
      for (let check = 1; check <= 5; check++) {
        api.flag(`q${check}`, false);
        api.flag(`r${check}`, false);
      }
      api.flag("x5", false);
      api.flag("r1");
      api.text("qa-run", "Run 2 · build 412");
      api.text("qa-c1", "Launch 2.4 (412)");
      api.text("pos-build", "2.4 (412)");
      api.text("pos-s-due", "$99.54");
      api.text("pos-s-tax", "$8.64");
      api.text("pos-s-total", "$99.54");
    });
    api.at(15400, () => api.flag("relaunch", false));
    api.at(15900, () => pass(api, 1));
    api.at(16200, () => pass(api, 2));
    api.at(16500, () => pass(api, 3));
    api.at(16800, () => {
      pass(api, 4);
      api.go("pos-charge");
    });
    api.at(17700, () => {
      api.click();
      api.flag("sheet");
    });
    api.at(18200, () => api.go("pos-s-tax", -0.4, 0.6, "pos-sheet"));
    api.at(18800, () => pass(api, 5));
    api.at(19100, () => api.go("pos-take"));
    api.at(20000, () => {
      api.click();
      api.flag("paid");
    });
    api.at(20600, () => pass(api, 6));
    api.at(21000, () => {
      api.flag("run", false);
      api.flag("ship");
      api.go("qa-ship", 0.5, 0.5, "qa-fix");
      api.step("Checkout passes. 2.4 is ready");
      api.status("done");
      api.restart(3000);
    });
  },
};
