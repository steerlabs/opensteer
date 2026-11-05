import { ModelPolicyEntrySchema } from "@opensteer/core";
// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mutationIdempotencyKey, unwrapRpcResult, type HostSnapshot } from "@opensteer/client/host";
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

async function openProjectSettings({ offline = false, rebind = false, restoreAccess = true } = {}) {
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
        specialistPlugins: rebind
          ? [
              {
                ...plugins[0]!,
                manifest: { ...researcher, access: researcher.access!.slice(0, 1) },
              },
            ]
          : plugins,
      },
    },
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
  await act(async () => {
    if (rebind) {
      const result = await client.rpc["specialist.list"]({ workspaceId });
      if (!result.ok) throw new Error("Specialists unavailable");
      const specialist = result.data.specialists[0]!;
      await client.dispatch({
        type: "specialist.bind",
        workspaceId,
        specialistId: specialist.id,
        requirement: 0,
        resourceId: specialist.access[0]!.candidates[0]!.resourceId,
        idempotencyKey: mutationIdempotencyKey("bind"),
      });
      for (const grant of client
        .getSnapshot()
        .browserProfileGrants.filter((g) => g.workspaceId === workspaceId)) {
        await client.dispatch({
          type: "browser.profileGrant.revoke",
          grantId: grant.id,
          idempotencyKey: mutationIdempotencyKey("revoke"),
        });
      }
      const revoked = await client.rpc["specialist.list"]({ workspaceId });
      expect(revoked).toMatchObject({
        data: { specialists: [{ access: [{ state: "rebind", candidates: [] }] }] },
      });
      if (restoreAccess) {
        await client.dispatch({
          type: "browser.profile.grant",
          workspaceId,
          profileId: BrowserProfileIdSchema.parse(specialist.access[0]!.candidates[0]!.resourceId),
          idempotencyKey: mutationIdempotencyKey("restore"),
        });
      }
    }
  });
  await act(async () => goTo!(`/workspaces/${project.id}/settings`));
  await settle(60);
  return project;
}

describe("a Project's settings", () => {
  it("refreshes a visible specialist after its browser access is revoked", async () => {
    const project = await openProjectSettings({ rebind: true });
    await click(button("Use", section("Specialists")));
    await settle();
    expect(section("Specialists").textContent).toContain("Uses Work");
    await act(async () => {
      for (const grant of client
        .getSnapshot()
        .browserProfileGrants.filter((g) => g.workspaceId === project.id)) {
        await client.dispatch({
          type: "browser.profileGrant.revoke",
          grantId: grant.id,
          idempotencyKey: mutationIdempotencyKey("revoke-visible"),
        });
      }
    });
    await settle();
    await vi.waitFor(
      () => {
        expect(section("Specialists").textContent).toContain("Needs setup");
        expect(button("Allow access", section("Specialists"))).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("offers access setup for revoked access with no remaining candidates", async () => {
    await openProjectSettings({ rebind: true, restoreAccess: false });
    expect(button("Allow access", section("Specialists"))).toBeTruthy();
    expect(section("Specialists").querySelector("select")).toBeNull();
  });

  it("offers an explicit choice after revoked access is restored and returns to ready", async () => {
    await openProjectSettings({ rebind: true });
    const dispatch = vi.spyOn(client, "dispatch");
    expect(section("Specialists").textContent).toContain("Choose which account to use now");
    await click(button("Use", section("Specialists")));
    await settle();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "specialist.bind", requirement: 0 }),
    );
    expect(section("Specialists").textContent).toContain("Uses Work");
    expect(section("Specialists").textContent).not.toContain("Needs setup");
  });

  it("walks a specialist from a choice to its remaining access, then removes it", async () => {
    const project = await openProjectSettings();
    const specialists = section("Specialists");
    expect(element(".card__row-title", specialists).textContent).toContain("Needs setup");
    expect(specialists.textContent).toContain("Runs on Claude Code · opus");
    expect(specialists.textContent).toContain("accounts.");
    expect(specialists.textContent).toContain("Unavailable to you.");
    const [profile, github] = [...specialists.querySelectorAll<HTMLElement>(".specialist-access")];
    expect(profile!.textContent).toContain("Reads the sites you research in");
    expect(profile!.className).toContain("specialist-access--choose");
    // What it may not use yet goes to the one place that allows it, for this Project.
    expect(button("Allow access", github!).getAttribute("href")).toContain(
      `/settings/plugins?provider=github&workspace=${encodeURIComponent(project.id)}`,
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
