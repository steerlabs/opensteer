import { placeholder } from "../apps/placeholder.js";
import type { Scene } from "../scene.js";

export const engineer: Scene = {
  agent: "engineer",
  task: "Test checkout before 2.4 ships",
  length: 12000,
  windows: placeholder("qa", "Test run"),
  menus: { qa: ["Test run", "File", "Edit", "View", "Window"] },
  run(api) {
    api.status("working");
    api.go("qa-line", 0.2, 0.5);
    api.at(1500, () => {
      api.type("qa-line", "Launching the 2.4 build and walking through checkout.");
      api.step("Launched the 2.4 build");
    });
    api.at(6000, () => api.step("Checkout walked end to end"));
    api.restart(12000);
  },
};
