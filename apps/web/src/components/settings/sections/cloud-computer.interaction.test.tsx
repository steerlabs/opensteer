// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import {
  MockCloudComputerAccount,
  mockCloudComputerAddress,
  mockCloudComputerDeploymentId,
  mockCloudComputerId,
  mockWorkAddress,
  type MockCloudComputerScene,
} from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import { CloudComputerPage, cloudComputerPath } from "./cloud-computer.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let path = "";
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function Where() {
  path = useLocation().pathname;
  return null;
}

const cloudDeployment = mockCloudComputerDeploymentId;
const workDeployment = "dep_00000000-0000-4000-8000-0000000000dd";

function bridgeFor(account: MockCloudComputerAccount | null, listed = true) {
  return {
    ...(account
      ? {
          cloudComputerRead: vi.fn(() => account.read()),
          cloudComputerAct: vi.fn((input: Parameters<MockCloudComputerAccount["act"]>[0]) =>
            account.act(input),
          ),
        }
      : {}),
    openExternalUrl: vi.fn(async () => ({ opened: true as const })),
    select: vi.fn(async () => undefined),
    listed,
  };
}

async function mount(
  bridge: ReturnType<typeof bridgeFor> | null,
  options: { readonly portalOrigin?: string | null } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = {
    desktopBridge: bridge,
    deploymentAccess: {
      deployments: bridge?.listed
        ? [
            { id: cloudDeployment, canonicalOrigin: mockCloudComputerAddress },
            { id: workDeployment, canonicalOrigin: mockWorkAddress },
          ]
        : [],
    },
    snapshot: {
      identityConfig: {
        portalOrigin:
          options.portalOrigin === undefined
            ? "https://app.opensteer.example"
            : options.portalOrigin,
      },
    },
  } as unknown as ShellContext;
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[cloudComputerPath]}>
        <ShellContext value={context}>
          <Where />
          <Routes>
            <Route path="/settings/account/cloud-computer" element={<CloudComputerPage />} />
            <Route path="*" element={null} />
          </Routes>
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Loading…"));
  return container;
}

function button(container: HTMLElement, text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!found) throw new Error(`No button ${text} in ${container.textContent}`);
  return found;
}
const scene = (name: MockCloudComputerScene) => new MockCloudComputerAccount(name);

describe("Opensteer Cloud Computer on desktop", () => {
  it("says what it is, its price from the Account's plan, and what changes", async () => {
    const page = await mount(bridgeFor(scene("none")));
    expect(page.textContent).toContain("Your Opensteer, always on in the cloud.");
    expect(page.textContent).toContain("Works while your Mac sleeps");
    expect(page.querySelector(".cloud-computer__price .card__row-title")?.textContent).toBe(
      "$20.00 a month",
    );
    expect(page.textContent).toContain(
      "It starts as a new Home. Connected agents connect again to its new address. You sign in to your sites again in its browser. Your Mac can be added to it as a device.",
    );
  });

  it("opens checkout on the Opensteer website and watches for the computer it creates", async () => {
    const account = scene("checkout");
    const bridge = bridgeFor(account);
    const page = await mount(bridge);
    await act(async () => button(page, "Continue to checkout").click());
    expect(bridge.openExternalUrl).toHaveBeenCalledWith({
      url: "https://app.opensteer.example/cloud-computer/checkout",
    });
    await vi.waitFor(() => expect(page.textContent).toContain("Finish checkout in your browser"));
    expect(button(page, "Open checkout again")).toBeTruthy();
    // Coming back to the app reads the status again; no redirect carries state.
    await act(async () => window.dispatchEvent(new Event("focus")));
    await vi.waitFor(() => expect(page.textContent).toContain("Preparing your Cloud Computer"));
  });

  it("shows the Account's own setup steps while preparing", async () => {
    const page = await mount(bridgeFor(scene("preparing")));
    expect(
      [...page.querySelectorAll(".connected-agent__steps li")].map((li) => [
        li.textContent,
        li.getAttribute("data-state"),
      ]),
    ).toEqual([
      ["Payment confirmed", "done"],
      ["Setting up your computer", "current"],
      ["Starting Opensteer", "pending"],
      ["Linking it to your account", "pending"],
    ]);
    expect(page.textContent).toContain("What changes");
  });

  it("shows one honest step while preparing when the Account reports none", async () => {
    const account = scene("preparing");
    const bridge = bridgeFor(account);
    bridge.cloudComputerRead = vi.fn(async () => {
      const result = await account.read();
      if (!result.ok) return result;
      return {
        ...result,
        data: {
          ...result.data,
          computers: [
            { id: mockCloudComputerId, egress: "pending" as const, status: "preparing" as const },
          ],
        },
      };
    });
    const page = await mount(bridge);
    expect(
      [...page.querySelectorAll(".connected-agent__steps li")].map((li) => [
        li.textContent,
        li.getAttribute("data-state"),
      ]),
    ).toEqual([
      ["Setting up your computer", "current"],
      ["Ready", "pending"],
    ]);
  });

  it("is ready: opens the Home, its Connected agents, and this Mac's setup on it", async () => {
    const bridge = bridgeFor(scene("ready"));
    const page = await mount(bridge);
    expect(page.textContent).toContain("Cloud Computer is ready");
    expect(page.textContent).toContain("Running");
    expect(page.textContent).toContain(mockCloudComputerAddress);
    expect(page.textContent).toContain("Browser IP · Assigned");
    expect(page.textContent).toContain("Browser IP203.0.113.24");
    expect(page.textContent).toContain("RegionAshburn, Virginia");
    expect(page.textContent).toContain("Renews Dec 20, 2026");
    await act(async () => button(page, "Open it").click());
    expect(bridge.select).toHaveBeenLastCalledWith({ deploymentId: cloudDeployment });
    const starts = () =>
      [...page.querySelectorAll("button")].filter((candidate) => candidate.textContent === "Start");
    await act(async () => starts()[0]!.click());
    expect(path).toBe("/settings/external-agents");
    act(() => root?.unmount());
    const again = await mount(bridge);
    const mac = [...again.querySelectorAll("button")].filter(
      (candidate) => candidate.textContent === "Start",
    )[1]!;
    await act(async () => mac.click());
    expect(path).toBe("/settings/devices");
    expect(bridge.select).toHaveBeenCalledTimes(3);
  });

  it("says when the Account hasn't listed it yet, and opens nothing", async () => {
    const bridge = bridgeFor(scene("ready"), false);
    const page = await mount(bridge);
    expect(page.textContent).toContain("It isn’t in your Opensteer list yet.");
    expect(button(page, "Open it").disabled).toBe(true);
  });

  it("opens billing on the Opensteer website", async () => {
    const bridge = bridgeFor(scene("ready"));
    const page = await mount(bridge);
    await act(async () => button(page, "Manage billing").click());
    expect(bridge.openExternalUrl).toHaveBeenLastCalledWith({
      url: "https://app.opensteer.example/cloud-computer/billing",
    });
  });

  it("suspends after confirming, then resumes", async () => {
    const bridge = bridgeFor(scene("ready"));
    const page = await mount(bridge);
    await act(async () => button(page, "Suspend").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Suspend Cloud Computer?",
    );
    expect(bridge.cloudComputerAct).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (candidate) => candidate.textContent === "Suspend",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(bridge.cloudComputerAct).toHaveBeenCalledWith({
      action: "suspend",
      id: mockCloudComputerId,
    });
    await vi.waitFor(() => expect(page.textContent).toContain("Suspended by you."));
    await act(async () => button(page, "Resume").click());
    expect(bridge.cloudComputerAct).toHaveBeenLastCalledWith({
      action: "resume",
      id: mockCloudComputerId,
    });
  });

  it("deletes only once the word is typed", async () => {
    const bridge = bridgeFor(scene("ready"));
    const page = await mount(bridge);
    await act(async () => button(page, "Delete Cloud Computer").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const confirm = [...dialog.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Delete",
    )!;
    expect(confirm.disabled).toBe(true);
    const input = dialog.querySelector("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "delete");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());
    expect(bridge.cloudComputerAct).toHaveBeenCalledWith({
      action: "delete",
      id: mockCloudComputerId,
      confirmation: `DELETE:${mockCloudComputerId}`,
    });
    await vi.waitFor(() => expect(page.textContent).toContain("Your Cloud Computer was deleted."));
  });

  it("shows the Account's refusal as it is", async () => {
    const page = await mount(bridgeFor(scene("refused")));
    await act(async () => button(page, "Suspend").click());
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (candidate) => candidate.textContent === "Suspend",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    await vi.waitFor(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toBe(
        "Cloud Computers can’t be changed right now. Try again later.",
      ),
    );
  });

  it("shows needs attention with the Account's reason, and suspended with Resume", async () => {
    const attention = await mount(bridgeFor(scene("attention")));
    expect(attention.textContent).toContain("Needs attention");
    expect(attention.textContent).toContain("The computer didn’t start in time.");
    expect(attention.textContent).toContain("Browsing unavailable");
    expect(attention.textContent).not.toContain("Cloud Computer is ready");
  });

  it("says signed out with the way to sign in, and unreachable with Try again", async () => {
    const signedOut = await mount(bridgeFor(scene("signed-out")));
    expect(signedOut.querySelector('[role="alert"]')?.textContent).toContain(
      "Sign in to your Opensteer account",
    );
    expect(signedOut.querySelector('[role="alert"] a[href="/settings/account"]')?.textContent).toBe(
      "Sign in",
    );
    act(() => root?.unmount());
    const account = scene("unreachable");
    const bridge = bridgeFor(account);
    const unreachable = await mount(bridge);
    expect(unreachable.textContent).toContain("We couldn’t reach Opensteer.");
    await act(async () => button(unreachable, "Try again").click());
    expect(bridge.cloudComputerRead).toHaveBeenCalledTimes(2);
  });

  it("sends a browser tab, which holds no Account credential, to the Opensteer website", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const page = await mount(null);
    expect(page.textContent).toContain(
      "Sign in to your Opensteer account on the website to set up and manage your Cloud Computer.",
    );
    await act(async () => button(page, "Open the Opensteer website").click());
    expect(open).toHaveBeenCalledWith(
      "https://app.opensteer.example/cloud-computer",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("offers no checkout without a website to open it on", async () => {
    const page = await mount(bridgeFor(scene("none")), { portalOrigin: null });
    expect(button(page, "Continue to checkout").disabled).toBe(true);
  });
});

describe("work Homes on the Cloud Computer screen", () => {
  it("shows a work Home as its own card, with no billing, suspend or delete", async () => {
    const page = await mount(bridgeFor(new MockCloudComputerAccount("work", workDeployment)));
    const card = page.querySelector(".work-home");
    expect(card?.querySelector("h2")?.textContent).toBe("Acme Robotics · Work Home");
    expect(card?.textContent).toContain("Running");
    expect(card?.textContent).toContain(mockWorkAddress);
    expect(card?.textContent).toContain(
      "Managed by Acme Robotics: they pay for it and can suspend or delete it.",
    );
    expect(card?.textContent).toContain("Most a connected agent may do on its own: Supervised");
    expect(card?.textContent).toContain("Agents may run tasks: Allowed");
    for (const word of ["Manage billing", "Suspend", "Delete Cloud Computer"])
      expect(card?.textContent).not.toContain(word);
    // No personal one yet: the offer still shows beside it.
    expect(page.querySelector(".cloud-computer__price")).not.toBeNull();
  });

  it("opens a work Home by the Home the Account pinned", async () => {
    const bridge = bridgeFor(new MockCloudComputerAccount("work", workDeployment));
    const page = await mount(bridge);
    const open = page.querySelector<HTMLButtonElement>(".work-home button");
    expect(open?.textContent).toBe("Open it");
    await act(async () => open!.click());
    expect(bridge.select).toHaveBeenLastCalledWith({ deploymentId: workDeployment });
  });

  it("shows both a personal Cloud Computer and a work Home", async () => {
    const page = await mount(bridgeFor(new MockCloudComputerAccount("both", workDeployment)));
    expect(page.querySelectorAll(".work-home")).toHaveLength(1);
    expect(page.textContent).toContain("Cloud Computer is ready");
    expect(button(page, "Manage billing")).toBeTruthy();
  });

  it("shows none when the person has no work Home", async () => {
    const page = await mount(bridgeFor(scene("ready")));
    expect(page.querySelectorAll(".work-home")).toHaveLength(0);
  });

  it("links to what the organization can see, read from the record schema", async () => {
    const page = await mount(bridgeFor(new MockCloudComputerAccount("work", workDeployment)));
    const link = [...page.querySelectorAll("a")].find((a) => a.textContent === "Open");
    await act(async () => link!.click());
    expect(path).toBe(
      "/settings/account/cloud-computer/work/was_00000000-0000-4000-8000-0000000000a1",
    );
  });
});
