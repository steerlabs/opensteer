// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultWorkPolicy } from "@opensteer/control-plane-protocol";
import { MockCloudComputerAccount } from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import { PlaceList } from "../../places/place-list.js";
import { ConnectionModeChoices } from "../agent-grant-editor.js";
import { HomeCloudComputerRow } from "./cloud-computer.js";
import { AccountSection } from "./account.js";
import type { PlaceRow } from "../../../desktop/places.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const workDeployment = "dep_00000000-0000-4000-8000-0000000000dd";
const assignment = "was_00000000-0000-4000-8000-0000000000a1";

async function render(
  element: React.ReactNode,
  options: { readonly at?: string; readonly home?: string } = {},
) {
  const account = new MockCloudComputerAccount("work", workDeployment);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = {
    desktopBridge: {
      cloudComputerRead: () => account.read(),
      cloudComputerAct: (input: Parameters<MockCloudComputerAccount["act"]>[0]) =>
        account.act(input),
    },
    desktopDeployment: options.home ? { id: options.home } : null,
    deploymentAccess: { deployments: [] },
    snapshot: { identityConfig: { exposure: "networked", portalOrigin: null } },
  } as unknown as ShellContext;
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[options.at ?? "/"]}>
        <ShellContext value={context}>
          <Routes>
            <Route path="/settings/account/cloud-computer/work/:assignmentId" element={element} />
            <Route path="*" element={element} />
          </Routes>
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  return container;
}

describe("what an organization can see of a work Home", () => {
  it("sends the old address of one work Home's page to where the work Homes are listed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <MemoryRouter initialEntries={[`/settings/account/cloud-computer/work/${assignment}`]}>
          <Routes>
            <Route path="/settings/account/cloud-computer" element={<p>Your work Homes</p>} />
            <Route path="/settings/account/*" element={<AccountSection />} />
            <Route path="/settings/work" element={<p>Settings → Work</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Your work Homes"));
    // Never the Work page of the Home that happens to be open, which may be another's.
    expect(container.textContent).not.toContain("Settings → Work");
    // The page that never finished loading in a browser is gone.
    expect(container.textContent).not.toContain("Loading");
  });

  it("puts the badge and the link on the work Home's own page, and nothing on another Home", async () => {
    const work = await render(<HomeCloudComputerRow />, { home: workDeployment });
    await vi.waitFor(() => expect(work.textContent).toContain("Work · Acme Robotics"));
    expect(work.querySelector("a")?.getAttribute("href")).toBe("/settings/work");
    act(() => root?.unmount());
    document.body.replaceChildren();
    const other = await render(<HomeCloudComputerRow />, {
      home: "dep_00000000-0000-4000-8000-0000000000ee",
    });
    await act(async () => undefined);
    expect(other.textContent).not.toContain("Work ·");
  });
});

describe("the work badge in the Opensteer list", () => {
  const row = (work?: string): PlaceRow => ({
    current: false,
    detail: "w3r8.cloud.opensteer.example",
    icon: "server",
    id: workDeployment,
    name: "Acme work",
    opens: true,
    removable: false,
    status: { label: "Ready", reason: null, status: "ready" },
    updatable: false,
    ...(work ? { work } : {}),
  });
  it("names the organization on its row, and only there", async () => {
    const page = await render(
      <PlaceList
        label="Places"
        onCheck={() => undefined}
        onOpen={() => undefined}
        rows={[
          row("Work · Acme Robotics"),
          { ...row(), id: "dep_00000000-0000-4000-8000-0000000000ee", name: "Mine" },
        ]}
      />,
    );
    const badges = page.querySelectorAll(".work-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Work · Acme Robotics");
  });
});

describe("a work Home's policy on the mode choices", () => {
  async function modes(workPolicy?: typeof defaultWorkPolicy) {
    const page = await render(
      <ConnectionModeChoices
        disabled={false}
        mode="approval-required"
        onChange={() => undefined}
        showSettingsNote={false}
        {...(workPolicy ? { workPolicy } : {})}
      />,
    );
    return [...page.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((input) => [
      input.value,
      input.disabled,
      input.closest("label")?.querySelector(".card__row-detail")?.textContent,
    ]);
  }
  it("offers every mode without a policy, as on every Home today", async () => {
    expect((await modes()).every(([, disabled]) => disabled === false)).toBe(true);
  });
  it("shows modes above the organization's ceiling as unavailable, with why", async () => {
    const choices = await modes(defaultWorkPolicy);
    expect(choices[0]?.[1]).toBe(false);
    for (const choice of choices.slice(1))
      expect(choice.slice(1)).toEqual([true, "Your organization doesn’t allow this"]);
  });
});
