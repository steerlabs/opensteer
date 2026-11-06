import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
import { guestAllowed } from "./journey-isolation.js";

assert(guestAllowed(homedir()), "Use pnpm test:vm");
const out = process.env.OPENSTEER_JOURNEY_OUT;
const resources = process.env.OPENSTEER_PERSONAL_E2E_RESOURCES;
assert(out && resources, "Run through the registered VM journey harness");
const root = path.join(out, "desktop-projects");
mkdirSync(root, { recursive: true });
assert(process.env.TMPDIR, "The journey must own a temporary directory");
const state = path.join(realpathSync(process.env.TMPDIR), "desktop-projects");
mkdirSync(state, { recursive: true });
const plugin = path.join(state, "journey-plugin");
mkdirSync(plugin);
writeFileSync(
  path.join(plugin, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "journey-plugin",
  }),
);
writeFileSync(
  path.join(plugin, "specialist.json"),
  JSON.stringify({
    version: 1,
    models: [{ engine: "claude", model: "haiku" }],
  }),
);
writeFileSync(
  path.join(plugin, "INSTRUCTIONS.md"),
  "Inspect the supplied fixture. Do not start any work.",
);
const desktop = await _electron.launch({
  args: [path.resolve("dist/main.js")],
  env: {
    ...process.env,
    OPENSTEER_DESKTOP_MODE: "development",
    OPENSTEER_DESKTOP_DATA_DIR: path.join(state, "data"),
    OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR: path.join(resources, "personal-runtime"),
    OPENSTEER_DESKTOP_NATIVE_FS_HELPER: path.join(
      resources,
      "personal-runtime/bin/opensteer-native-fs",
    ),
    OPENSTEER_DESKTOP_PERSONAL_WORKSPACE_ROOT: path.join(state, "workspaces"),
  },
  timeout: 30_000,
});
const results: string[] = [];
try {
  const page = await desktop.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(root, `${name}.png`) });
    results.push(name);
  };
  try {
    await page.getByRole("button", { name: /^Set up / }).click();
    // Setup's steps each leave through Skip; the last one says "Skip for now".
    const message = page.getByRole("textbox", { name: "Message" });
    for (let step = 0; step < 3; step += 1) {
      const skip = page
        .locator(".setup-frame__foot button:not(:disabled)")
        .filter({ hasText: /^Skip( for now)?$/ })
        .first();
      await Promise.race([skip.waitFor({ timeout: 90_000 }), message.waitFor({ timeout: 90_000 })]);
      if (await message.isVisible()) break;
      await skip.click();
    }
    await message.waitFor({ timeout: 90_000 });
    await page.getByRole("button", { name: /Places and menu|:.*Menu$/ }).click();
    await page.getByRole("menuitem", { name: "Projects", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
    const projects = page
      .locator(".page")
      .filter({ has: page.getByRole("heading", { name: "Projects", exact: true }) });
    await projects
      .locator(".projects-empty")
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Sidebar fixture");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await navigation.getByRole("button", { name: "New project", exact: true }).waitFor();
    await capture("01-sidebar");
    await navigation.getByRole("button", { name: "New project", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Desktop journey");
    await capture("02-new-project");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await page.getByRole("link", { name: "Desktop journey settings", exact: true }).waitFor();
    await capture("03-project-created");
    await page.getByRole("link", { name: "Desktop journey settings", exact: true }).click();
    await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
    await capture("04-project-settings");
    await page.getByRole("button", { name: /Places and menu|:.*Menu$/ }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Plugins", exact: true }).click();
    await page.getByRole("button", { name: /^Add your own/ }).click();
    await page.getByPlaceholder("/Users/you/plugins/name").fill(plugin);
    await page.getByRole("button", { name: "Add plugin", exact: true }).click();
    const row = page.getByRole("link").filter({ hasText: "journey-plugin" });
    await row.waitFor();
    await capture("05-installed-plugin");
    await page.getByRole("button", { name: "Back to conversations", exact: true }).click();
    const project = navigation.getByRole("link", { name: /^Desktop journey(?: — .+)?$/ });
    await project.click();
    await page.getByRole("link", { name: "Desktop journey settings", exact: true }).click();
    const plugins = page.getByRole("region", { name: "Plugins", exact: true });
    const toggle = (checked: boolean) =>
      plugins.getByRole("switch", {
        name: "journey-plugin on in Desktop journey",
        exact: true,
        checked,
      });
    // The switch moves once the Host confirms the change, not on the click itself.
    await toggle(false).click();
    await toggle(true).waitFor({ timeout: 10_000 });
    await capture("06-plugin-enabled");
    await toggle(true).click();
    await toggle(false).waitFor({ timeout: 10_000 });
    await capture("07-plugin-disabled");
    await page.getByRole("button", { name: /Places and menu|:.*Menu$/ }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "Account", exact: true }).click();
    await page.getByRole("heading", { name: "Account", exact: true }).waitFor();
    await capture("08-account");
    await page.getByRole("button", { name: "Back to conversations", exact: true }).click();
    await project.click();
    await page.getByRole("link", { name: "Desktop journey settings", exact: true }).click();
    await page.getByRole("button", { name: "Delete…", exact: true }).click();
    await capture("09-delete-confirmation");
    await page.getByRole("button", { name: "Delete project", exact: true }).click();
    // A deleted Project stays restorable for a while, marked in the sidebar.
    await navigation
      .getByRole("link", { name: "Desktop journey — Scheduled for deletion", exact: true })
      .waitFor();
    await capture("10-project-deleted");
  } catch (error) {
    await capture("failure");
    throw error;
  }
} finally {
  writeFileSync(path.join(root, "steps.json"), JSON.stringify(results, null, 2));
  await desktop.close();
}
