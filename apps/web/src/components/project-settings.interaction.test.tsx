// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mutationIdempotencyKey, type HostSnapshot } from "@opensteer/client/host";
import {
  BrowserProfileIdSchema,
  WorkspaceIdSchema,
  type SpecialistManifest,
} from "@opensteer/core";
import {
  click,
  client,
  element,
  goTo,
  history,
  mount,
  settle,
  typeInto,
} from "./workspace/workspace.interaction.test-support.js";

const researcher: SpecialistManifest = {
  version: 1,
  models: [{ engine: "claude", model: "opus" }],
  fallback: "caller",
  access: [
    { type: "browser-profile", level: "read", reason: "Reads the sites you research in" },
    { type: "integration", service: "github", level: "read", reason: "Files what it finds" },
  ],
};
const plugins = [{ id: "plg_researcher", name: "researcher", manifest: researcher }];

const button = (text: string, scope: ParentNode = document) => {
  const match = [...scope.querySelectorAll<HTMLElement>("button, a")].find(
    (node) => node.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Missing ${text}`);
  return match;
};
const section = (title: string) => {
  const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === title);
  if (!heading) throw new Error(`Missing section ${title}`);
  return heading.closest("section")!;
};

async function openProjectSettings({ offline = false } = {}) {
  await mount(
    (source) => {
      // Every snapshot the Host publishes reads as a lost connection.
      if (offline) {
        const read = source.getSnapshot.bind(source);
        const held = new WeakMap<HostSnapshot, HostSnapshot>();
        vi.spyOn(source, "getSnapshot").mockImplementation(() => {
          const snapshot = read();
          const view = held.get(snapshot) ?? { ...snapshot, connection: "offline" };
          held.set(snapshot, view);
          return view;
        });
      }
      return "/projects";
    },
    { mock: { specialistPlugins: plugins } },
  );
  const project = client.getSnapshot().workspaces.find(({ kind }) => kind === "project")!;
  const workspaceId = WorkspaceIdSchema.parse(project.id);
  await act(async () => {
    for (const name of ["Work", "Personal"]) {
      const created = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey("profile"),
        input: { name },
        type: "browser.profile.create",
      });
      if (created.type !== "browser.profile.create") throw new Error("Profile not created");
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey("grant"),
        profileId: BrowserProfileIdSchema.parse(created.profile.id),
        type: "browser.profile.grant",
        workspaceId,
      });
    }
    await client.dispatch({
      idempotencyKey: mutationIdempotencyKey("specialist"),
      pluginId: "plg_researcher",
      type: "specialist.add",
      workspaceId,
    });
  });
  await act(async () => goTo!(`/workspaces/${project.id}/settings`));
  await settle(60);
  return project;
}

describe("a Project's settings", () => {
  it("walks a specialist from a choice to its remaining access, then removes it", async () => {
    const project = await openProjectSettings();
    const specialists = section("Specialists");
    expect(element(".card__row-title", specialists).textContent).toContain("Needs setup");
    expect(specialists.textContent).toContain("Runs on Claude Code · opus");
    const [profile, github] = [...specialists.querySelectorAll<HTMLElement>(".specialist-access")];
    expect(profile!.textContent).toContain("Reads the sites you research in");
    expect(profile!.className).toContain("specialist-access--choose");
    // What it may not use yet goes to the one place that allows it, for this Project.
    expect(button("Allow access", github!).getAttribute("href")).toContain(
      `/settings/apps/tools?provider=github&workspace=${encodeURIComponent(project.id)}`,
    );

    await click(button("Use", profile!));
    await settle();
    const bound = element(".specialist-access", section("Specialists"));
    expect(bound.className).toContain("specialist-access--bound");
    expect(bound.textContent).toMatch(/Uses /u);
    // GitHub is still not allowed here, so it is still not ready.
    expect(section("Specialists").textContent).toContain("Needs setup");

    await click(button("Remove", section("Specialists")));
    expect(element('[role="dialog"]').textContent).toContain("Remove researcher?");
    await click(button("Remove specialist"));
    await settle();
    expect([...document.querySelectorAll("h2")].some((h) => h.textContent === "Specialists")).toBe(
      false,
    );
  });

  it("turns a plugin off here without touching anywhere else", async () => {
    const project = await openProjectSettings();
    const toggle = element<HTMLInputElement>(
      `input[aria-label="researcher on in ${project.name}"]`,
      section("Plugins"),
    );
    expect(toggle.checked).toBe(true);
    await click(toggle);
    await settle();
    expect(
      element<HTMLInputElement>(`input[aria-label="researcher on in ${project.name}"]`).checked,
    ).toBe(false);
  });

  it("says when Opensteer can't be reached, and holds changes until it is", async () => {
    const project = await openProjectSettings({ offline: true });
    expect(document.body.textContent).toContain("Opensteer can’t be reached right now");
    expect(
      element<HTMLInputElement>(`input[aria-label="researcher on in ${project.name}"]`).disabled,
    ).toBe(true);
  });
});

describe("Settings → Plugins", () => {
  it("installs from a folder, turns a plugin on in Main, and removes it after confirming", async () => {
    await mount("/settings/plugins", { mock: { specialistPlugins: plugins } });
    await settle();
    const installed = () => section("Installed");
    expect(installed().textContent).toContain("researcher");
    expect(installed().textContent).toContain("Version 1.0.0");
    expect(installed().textContent).toContain("Off everywhere");

    await typeInto(
      element<HTMLInputElement>('input[placeholder="/Users/you/plugins/tinycrm"]'),
      "/Users/me/plugins/notes",
    );
    await click(button("Install plugin"));
    await settle();
    expect(installed().textContent).toContain("notes");

    const notes = [...installed().querySelectorAll<HTMLElement>(".plugin-row")].find((row) =>
      row.textContent?.includes("notes"),
    )!;
    expect(element(".plugin-row__where", notes).textContent).toContain("Off everywhere");
    await click(element(".plugin-row__where", notes));
    await click(element<HTMLInputElement>('input[aria-label="notes on in Main"]', notes));
    await settle();
    expect(installed().textContent).toContain("On in Main");

    await click(button("Remove", notes));
    expect(element('[role="dialog"]').textContent).toContain("It turns off in Main.");
    await click(button("Remove plugin"));
    await settle();
    expect(installed().textContent).not.toContain("notes");
    expect(history.at(-1)!.path).toBe("/settings/plugins");
  });
});
