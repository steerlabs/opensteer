// @vitest-environment happy-dom

import { RunnerIdSchema } from "@opensteer/core";

import type { HostSnapshot } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import { lastBrowsingChoice, rememberBrowsingChoice } from "../../workspace/start-page.js";
import { settingsRail } from "../copy.js";
import { BrowserProfilesSection } from "./browser-profiles.js";

/*
 * How Settings → Browser profiles could mislead or misfire:
 * - the section is missing from what agents can use, or splits Chrome from Passwords;
 * - rename or delete send the wrong command, or delete does not first say what goes with it;
 * - deleting leaves this device's new tabs and links defaulting to the deleted profile;
 * - a Host without rename and delete is offered them anyway;
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
  it("sits with the other browser sign-ins", async () => {
    expect(
      settingsRail("personal")
        .agents.map(({ id }) => id)
        .slice(-3),
    ).toEqual(["ai", "plugins", "sign-ins"]);
    const { page } = await mount();
    expect(rows(page)).toEqual(["Shopping", "Work"]);
  });

  it("says it could not load the profiles, with Try again, instead of an empty list", async () => {
    const { page, retry } = await mount({ unreadable: true, held: false });
    expect(page.textContent).toContain("Couldn't load your browser profiles.");
    expect(page.textContent).not.toContain("No profiles yet");
    expect(rows(page)).toEqual([]);
    const again = [...page.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => again!.click());
    expect(retry).toHaveBeenCalledWith(["browser-profile"]);
  });

  it("keeps the profiles last read, with their controls, under a failed refresh", async () => {
    const { page, retry } = await mount({ unreadable: true });
    expect(page.textContent).toContain(
      "Couldn't refresh your browser profiles. Showing what was last loaded.",
    );
    expect(rows(page)).toEqual(["Shopping", "Work"]);
    const again = [...page.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => again!.click());
    expect(retry).toHaveBeenCalled();
  });

  it("keeps both pending disk erasure states visible without profile actions", async () => {
    const { page, setDeletions } = await mount({
      deletions: [
        {
          profileId: "bpr_deleted_offline",
          computerId: RunnerIdSchema.parse("rnr_88888888-8888-4888-8888-888888888888"),
          state: "pending-computer",
        },
        {
          profileId: "bpr_deleted_restart",
          computerId: RunnerIdSchema.parse("rnr_99999999-9999-4999-8999-999999999999"),
          state: "pending-restart",
        },
      ],
    });
    expect(page.textContent).toContain("Will be erased when Studio Mac is back online");
    expect(page.textContent).toContain("Erased after Opensteer restarts on Desk Mac");
    expect(rows(page).filter((row) => row.includes("Deleted profile"))).toHaveLength(2);
    expect(page.querySelectorAll('[aria-label^="Manage "]')).toHaveLength(2);
    await setDeletions([]);
    expect(page.textContent).not.toContain("Deleted profile");
  });

  it("updates the erasure row when only the browser pool wakes", async () => {
    const computerId = RunnerIdSchema.parse("rnr_88888888-8888-4888-8888-888888888888");
    const parked = {
      runnerId: computerId,
      phase: "parked" as const,
      since: "2026-11-28T00:00:00Z",
    };
    const { page, setBrowserPools } = await mount({
      pools: [parked],
      deletions: [{ profileId: "bpr_deleted", computerId, state: "pending-computer" }],
    });
    expect(page.textContent).toContain("Will be erased when the browser next starts");
    await setBrowserPools([{ ...parked, phase: "running" }]);
    expect(page.textContent).not.toContain("Will be erased when the browser next starts");
    expect(page.textContent).toContain("Not erased yet");
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
      "Its sign-ins and site data are erased from this Opensteer. This can’t be undone.",
    );
    await click(button(page, "Delete profile"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "bpr_shopping", type: "browser.profile.delete" }),
    );
    expect(lastBrowsingChoice(scope)).toEqual({ kind: "guest" });
  });

  it("offers a Host without profile management nothing to manage", async () => {
    const { page } = await mount({ manageable: false });
    expect(page.querySelector('[aria-label="Manage Work"]')).toBeNull();
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
    readonly pools?: HostSnapshot["browserPools"];
    readonly unreadable?: boolean;
    /** Whether a complete inventory of the profiles was read before the failure. */
    readonly held?: boolean;
  } = {},
) {
  const hostClient = new MockHostClient({ latencyMs: 0 });
  const retry = vi.fn();
  if (input.unreadable) {
    const held = hostClient.getSnapshot();
    vi.spyOn(hostClient, "getSnapshot").mockReturnValue({
      ...held,
      unreadableResources: ["browser-profile"],
      ...(input.held === false
        ? { loadedResources: held.loadedResources.filter((kind) => kind !== "browser-profile") }
        : {}),
    });
    Object.assign(hostClient, { retryResources: retry });
  }
  // Each command's effect on the snapshot is the client's, covered with its patches.
  const dispatch = vi.spyOn(hostClient, "dispatch").mockResolvedValue(undefined as never);
  const base = hostClient.getSnapshot();
  const snapshot = {
    ...base,
    browserProfileManageAvailable: input.manageable ?? true,
    browserProfileDeletions: input.deletions,
    browserPools: input.pools,
    machines: [
      {
        ...base.machines[0]!,
        id: "computer-delete",
        selfRunnerId: RunnerIdSchema.parse("rnr_88888888-8888-4888-8888-888888888888"),
        name: "Studio Mac",
        status: input.pools ? "online" : "offline",
      },
      {
        ...base.machines[0]!,
        id: "restart-device",
        selfRunnerId: RunnerIdSchema.parse("rnr_99999999-9999-4999-8999-999999999999"),
        name: "Desk Mac",
        status: "online",
      },
    ],
    browserProfiles: [
      { homeRunnerId: null, id: "bpr_work", name: "Work" },
      { homeRunnerId: null, id: "bpr_shopping", name: "Shopping" },
    ],
  } satisfies HostSnapshot;
  let liveSnapshot = snapshot;
  if (input.pools) vi.spyOn(hostClient, "getSnapshot").mockImplementation(() => liveSnapshot);
  const context = { hostClient, snapshot } as unknown as ShellContext;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const paint = () =>
    root.render(
      <MemoryRouter initialEntries={[input.path ?? "/settings/browser-profiles"]}>
        <Routes>
          <Route
            element={
              <ShellContext value={context}>
                <Outlet />
              </ShellContext>
            }
          >
            <Route element={<BrowserProfilesSection />} path="settings/browser-profiles" />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  await act(async () => paint());
  return {
    async setBrowserPools(browserPools: HostSnapshot["browserPools"]) {
      liveSnapshot = { ...liveSnapshot, browserPools };
      await act(async () => hostClient.setBrowserPools(browserPools));
    },
    async setDeletions(deletions: HostSnapshot["browserProfileDeletions"]) {
      snapshot.browserProfileDeletions = deletions;
      await act(async () => paint());
    },
    dispatch,
    page: container,
    retry,
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
