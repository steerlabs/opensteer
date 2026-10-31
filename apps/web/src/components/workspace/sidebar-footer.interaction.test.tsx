// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import type { DesktopPlaces } from "../../desktop/places-context.js";
import { mount, element, click } from "./workspace.interaction.test-support.js";

let places: DesktopPlaces | null = null;
vi.mock("../../desktop/places-context.js", async (original) => ({
  ...(await original<typeof import("../../desktop/places-context.js")>()),
  useDesktopPlaces: () => places,
}));
afterEach(() => {
  places = null;
});

async function openMenu() {
  const button = element<HTMLButtonElement>(".sidebar__place");
  vi.spyOn(button, "getClientRects").mockReturnValue([new DOMRect()] as unknown as DOMRectList);
  await click(button);
}
function menuLabels() {
  return [...document.querySelectorAll('.popover [role="menuitem"] .picker__label')].map(
    (row) => row.textContent,
  );
}
async function switchComputer() {
  const row = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.includes("Switch computer…"),
  );
  expect(row).toBeDefined();
  await click(row!);
  expect(document.querySelector(".popover")).toBeNull();
  expect(element("[role=dialog] .dialog__title").textContent).toBe("Switch computer");
}
function desktop(expired = false) {
  const id = createId("deployment");
  const select = vi.fn(async () => undefined);
  const onAddPlace = vi.fn();
  places = {
    bridge: {
      select,
      checkDeployments: vi.fn(async () => undefined),
    } as unknown as OpensteerDesktopBridge,
    cloudDeploymentIds: new Set(),
    onAddPlace,
    snapshot: DeploymentAccessSnapshotSchema.parse({
      account: {
        available: true,
        status: expired ? "error" : "signed-in",
        email: "alex@example.test",
      },
      deployments: [
        {
          id,
          name: "Lab server",
          kind: "self-hosted",
          access: "native",
          activeOrigin: "https://lab.example.test",
          canonicalOrigin: "https://lab.example.test",
          routes: [{ kind: "canonical", origin: "https://lab.example.test", selected: true }],
          lastUsedAt: null,
          onThisComputer: false,
          accountAccess: null,
          availableActions: ["select"],
          failure: null,
          source: "manual",
          status: "idle",
          statusInfo: { status: "ready", reason: null },
        },
      ],
      directoryFailure: null,
      personalAccountLink: {
        account: null,
        deploymentId: null,
        displayName: null,
        status: "unavailable",
        unlinkStep: null,
      },
      personalSetup: null,
      revision: 1,
      selectedDeploymentId: null,
      unavailable: [],
    }),
  };
  return { id, select, onAddPlace };
}

it("web keeps only app pages in the menu and ? still opens shortcuts", async () => {
  await mount("/");
  await openMenu();
  expect(menuLabels()).toEqual(["Specialists", "Automations", "Settings"]);
  expect(document.body.textContent).not.toContain("Switch computer…");
  expect(document.body.textContent).not.toContain("Keyboard shortcuts");
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  element<HTMLButtonElement>(".sidebar__place").focus();
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", bubbles: true }),
    ),
  );
  expect(element(".dialog__title").textContent).toBe("Keyboard shortcuts");
});
it("desktop opens places in a dialog and closes it when selecting or adding", async () => {
  const fixture = desktop();
  await mount("/");
  await openMenu();
  expect(menuLabels()).toEqual(["Specialists", "Automations", "Settings", "Switch computer…"]);
  expect(document.querySelector(".place-row")).toBeNull();
  expect(document.body.textContent).not.toContain("Add a computer or server");
  expect(document.body.textContent).toContain("alex@example.test");
  await switchComputer();
  expect(document.body.textContent).toContain("Lab server");
  await click(element(".place-row"));
  expect(fixture.select).toHaveBeenCalledWith({ deploymentId: fixture.id });
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(document.activeElement).toBe(element(".sidebar__place"));
  await openMenu();
  await switchComputer();
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Add a computer or server",
  );
  await click(add!);
  expect(fixture.onAddPlace).toHaveBeenCalledOnce();
  expect(document.querySelector("[role=dialog]")).toBeNull();
});
it("ended sign-in keeps its footer alert and points to sign-in inside the dialog", async () => {
  desktop(true);
  await mount("/");
  expect(document.querySelector(".sidebar__place-alert")).not.toBeNull();
  expect(element(".sidebar__place").getAttribute("aria-label")).toContain(
    "Sign in again. Places and menu",
  );
  await openMenu();
  expect(element(".popover .picker__detail").textContent).toBe("Sign in again");
  expect(document.querySelector(".place-card")).toBeNull();
  await switchComputer();
  expect(element(".place-card__title").textContent).toBe("Sign in again");
});
