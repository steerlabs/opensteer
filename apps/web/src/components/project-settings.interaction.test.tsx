import { ModelPolicyEntrySchema } from "@opensteer/core";
// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mutationIdempotencyKey, unwrapRpcResult, type HostSnapshot } from "@opensteer/client/host";
import { WorkspaceIdSchema, type SpecialistManifest } from "@opensteer/core";
import {
  click,
  client,
  element,
  goTo,
  mount,
  settle,
  typeInto,
} from "./workspace/workspace.interaction.test-support.js";

const researcher: SpecialistManifest = {
  version: 1,
  models: [ModelPolicyEntrySchema.parse({ engine: "claude", model: "opus" })],
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
    {
      mock: {
        specialistPlugins: plugins,
      },
    },
  );
  const project = client.getSnapshot().workspaces.find(({ kind }) => kind === "project")!;
  const workspaceId = WorkspaceIdSchema.parse(project.id);
  await act(async () => {
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
  it("loads a ready specialist without access rows and removes it after confirming", async () => {
    await openProjectSettings();
    const specialists = section("Specialists");
    expect(element(".card__row-title", specialists).textContent).toContain("researcher");
    expect(specialists.textContent).toContain("Runs on Claude Code · opus");
    expect(specialists.textContent).toContain(
      `Uses ${client.getSnapshot().user!.displayName} accounts.`,
    );
    expect(specialists.querySelector(".specialist-access")).toBeNull();
    expect(specialists.textContent).not.toContain("Reads the sites you research in");
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
    await mount("/settings/plugins/add", { mock: { specialistPlugins: plugins } });
    await settle();
    await click(element(".settings-catalog__own"));
    await typeInto(
      element<HTMLInputElement>('input[placeholder="/Users/you/plugins/name"]'),
      "/Users/me/plugins/notes",
    );
    await click(button("Add plugin"));
    await settle();
    await act(async () => {
      await goTo!("/settings/plugins");
    });
    await settle();
    const notesLink = [...document.querySelectorAll<HTMLAnchorElement>("a.card__row-body")].find(
      (link) => link.querySelector(".card__row-title")?.textContent === "notes",
    )!;
    expect(notesLink).toBeTruthy();
    await click(notesLink);
    await settle();
    const main = [...document.querySelectorAll<HTMLLabelElement>("label.card__row")].find(
      (label) => label.textContent === "Main",
    )!;
    await click(element<HTMLInputElement>("input", main));
    await settle();
    expect(element<HTMLInputElement>("input", main).checked).toBe(true);
    await click(button("Remove"));
    await settle();
    expect(element('[role="dialog"]').textContent).toContain("Remove notes?");
    expect(
      unwrapRpcResult(await client.rpc["plugin.list"]({})).plugins.some(
        (plugin) => plugin.name === "notes",
      ),
    ).toBe(true);
    await click(button("Remove plugin"));
    await settle();
    expect(
      unwrapRpcResult(await client.rpc["plugin.list"]({})).plugins.some(
        (plugin) => plugin.name === "notes",
      ),
    ).toBe(false);
  });
});
