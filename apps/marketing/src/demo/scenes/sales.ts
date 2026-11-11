import { placeholder } from "../apps/placeholder.js";
import type { Scene } from "../scene.js";

export const sales: Scene = {
  agent: "sales",
  task: "Acme's $48k renewal",
  length: 12000,
  windows: placeholder("deal", "Acme renewal"),
  menus: { deal: ["Acme renewal", "File", "Edit", "View", "Window"] },
  run(api) {
    api.status("working");
    api.go("deal-line", 0.2, 0.5);
    api.at(1500, () => {
      api.type("deal-line", "Reading Priya's profile and updating the Acme deal.");
      api.step("Read the buyer's profile");
    });
    api.at(6000, () => api.step("Updated the deal to $48,000"));
    api.restart(12000);
  },
};
