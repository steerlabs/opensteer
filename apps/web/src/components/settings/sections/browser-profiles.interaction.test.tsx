// @vitest-environment happy-dom

import type { HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellContext } from "../../app-shell.js";
import { lastBrowsingChoice, rememberBrowsingChoice } from "../../workspace/start-page.js";
import { settingsRail } from "../copy.js";
import { BrowserProfilesSection } from "./browser-profiles.js";

/*
 * How Settings → Browser profiles could mislead or misfire:
 * - the section is missing from what agents can use, or splits Chrome from Passwords;
 * - a profile does not say who may use it;
 * - rename or delete send the wrong command, or delete does not first say what goes with it;
 * - deleting leaves this device's new tabs and links defaulting to the deleted profile;
 * - an older Host without rename and delete is offered them anyway;
 * - "Add profile…" elsewhere lands on the page without the name field open.
 */

const roots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
});

describe("Settings → Browser profiles", () => {
  it("sits with the other browser sign-ins and says who may use each profile", async () => {
    expect(
      settingsRail("personal")
        .agents.map(({ id }) => id)
        .slice(-3),
    ).toEqual(["browser-profiles", "chrome", "passwords"]);
    const { page } = await mount();
    expect(rows(page)).toEqual(["Shopping Opensteer and Buyer", "Work Opensteer only"]);
  });

  it("keeps both pending disk erasure states visible without profile actions", async () => {
    const { page, setDeletions } = await mount({
      deletions: [
        {
          profileId: "bpr_deleted_offline",
          computerId: "computer-delete",
          state: "pending-computer",
        },
        {
          profileId: "bpr_deleted_restart",
          computerId: "computer-delete",
          state: "pending-restart",
        },
      ],
    });
    expect(page.textContent).toContain("Will be erased when Studio Mac is back online");
    expect(page.textContent).toContain("Erased after Opensteer restarts on Studio Mac");
    expect(rows(page).filter((row) => row.includes("Deleted profile"))).toHaveLength(2);
    expect(page.querySelectorAll('[aria-label^="Manage "]')).toHaveLength(2);
    await setDeletions([]);
    expect(page.textContent).not.toContain("Deleted profile");
  });

  it("renames a profile in place", async () => {
    const { dispatch, page } = await mount();
    await click(button(page, "Manage Work"));
    await click(menuItem("Rename"));
    const input = page.querySelector<HTMLInputElement>('input[aria-label="New name for Work"]')!;
    await type(input, "Office");
    await click(button(page, "Save"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Office",
        profileId: "bpr_work",
        type: "browser.profile.rename",
      }),
    );
  });

  it("says what deleting takes before it deletes, and stops defaulting to the profile", async () => {
    const { dispatch, page, scope } = await mount();
    rememberBrowsingChoice(scope, { kind: "profile", profileId: "bpr_shopping" });
    await click(button(page, "Manage Shopping"));
    await click(menuItem("Delete profile"));
    expect(dispatch).not.toHaveBeenCalled();
    expect(page.querySelector('[aria-label="Delete Shopping"]')?.textContent).toContain(
      "Its sign-ins and site data are erased from this Opensteer. Buyer loses access. This can’t be undone.",
    );
    await click(button(page, "Delete profile"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "bpr_shopping", type: "browser.profile.delete" }),
    );
    expect(lastBrowsingChoice(scope)).toEqual({ kind: "guest" });
  });

  it("offers an older Host only what it can do: specialist access", async () => {
    const { dispatch, page } = await mount({ manageable: false });
    await click(button(page, "Manage Work"));
    expect(menuItems()).toEqual(["Choose specialists…"]);
    await click(menuItem("Choose specialists…"));
    await click(button(page, "Off"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "bpr_work",
        type: "browser.profile.grant",
        workspaceId: "wsp_buyer",
      }),
    );
  });

  it("opens the name field when sent here to add a profile", async () => {
    const { page } = await mount({ path: "/settings/browser-profiles?new" });
    expect(page.querySelector('input[aria-label="New profile name"]')).not.toBeNull();
  });
});

async function mount(
  input: {
    readonly manageable?: boolean;
    readonly path?: string;
    readonly deletions?: HostSnapshot["browserProfileDeletions"];
  } = {},
) {
  const hostClient = new MockHostClient({ latencyMs: 0 });
  // Each command's effect on the snapshot is the client's, covered with its patches.
  const dispatch = vi.spyOn(hostClient, "dispatch").mockResolvedValue(undefined as never);
  const base = hostClient.getSnapshot();
  const main = base.workspaces.find((workspace) => workspace.kind === "main")!;
  const snapshot: HostSnapshot = {
    ...base,
    browserProfileManageAvailable: input.manageable ?? true,
    browserProfileDeletions: input.deletions,
    machines: [{ ...base.machines[0]!, id: "computer-delete", name: "Studio Mac" }],
    browserProfiles: [
      { id: "bpr_work", name: "Work" },
      { id: "bpr_shopping", name: "Shopping" },
    ],
    browserProfileGrants: [
      {
        access: "full-control",
        createdAt: "2026-10-30T12:00:00.000Z",
        id: "bpg_shopping_buyer",
        profileId: "bpr_shopping",
        workspaceId: "wsp_buyer",
      },
    ],
    workspaces: [
      ...base.workspaces,
      { ...main, id: "wsp_buyer", kind: "specialized", name: "Buyer" },
    ],
  };
  const context = { hostClient, snapshot } as unknown as ShellContext;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const paint = () =>
    root.render(
      <MemoryRouter initialEntries={[input.path ?? "/settings/browser-profiles"]}>
        <Routes>
          <Route element={<Outlet context={context} />}>
            <Route element={<BrowserProfilesSection />} path="settings/browser-profiles" />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  await act(async () => paint());
  return {
    async setDeletions(deletions: HostSnapshot["browserProfileDeletions"]) {
      snapshot.browserProfileDeletions = deletions;
      await act(async () => paint());
    },
    dispatch,
    page: container,
    scope: { deploymentId: snapshot.deploymentId, userId: snapshot.user?.id ?? null },
  };
}

function rows(page: HTMLElement): readonly string[] {
  return [...page.querySelectorAll(".settings-item .card__row-body")].map((row) =>
    [...row.children].map((part) => part.textContent).join(" "),
  );
}

function button(page: HTMLElement, label: string): HTMLButtonElement {
  const match = [...page.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return match;
}

function menuItems(): readonly string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "");
}

function menuItem(label: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );
  if (!match) throw new Error(`Missing menu item ${label}: ${menuItems().join(", ")}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
