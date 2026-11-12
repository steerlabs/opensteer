// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { readComputerFacts } from "../../desktop/computer-facts.js";
import type { DesktopPlaces } from "../../desktop/places-context.js";
import { mount, element, click } from "./workspace.interaction.test-support.js";

vi.mock("../../desktop/computer-facts.js", () => ({ readComputerFacts: vi.fn() }));
const readFacts = vi.mocked(readComputerFacts);
let places: DesktopPlaces | null = null;
vi.mock("../../desktop/places-context.js", async (original) => ({
  ...(await original<typeof import("../../desktop/places-context.js")>()),
  useDesktopPlaces: () => places,
}));
afterEach(() => {
  places = null;
  readFacts.mockReset();
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
function desktop(expired = false) {
  const id = createId("deployment");
  const secondId = createId("deployment");
  const teamId = createId("deployment");
  const facts = { needsYou: 3, unread: false, teams: [{ id: teamId, name: "Acme", mentions: 7 }] };
  readFacts.mockImplementation(async (_bridge, computer) =>
    computer.id === id ? { ...facts } : { needsYou: 0, unread: true, teams: [] },
  );
  const select = vi.fn(async () => undefined);
  const onAddPlace = vi.fn();
  const signIn = vi.fn(async () => undefined);
  const checkDeployments = vi.fn(async () => undefined);
  places = {
    bridge: {
      select,
      checkDeployments,
      signIn,
    } as unknown as OpensteerDesktopBridge,
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
          name: "Lab Mac",
          kind: "personal",
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
        ...[
          { id: secondId, name: "Home Mac", kind: "personal", origin: "https://home.example.test" },
          { id: teamId, name: "Acme server", kind: "team", origin: "https://acme.example.test" },
        ].map(({ origin, ...row }) => ({
          ...row,
          access: "native",
          activeOrigin: origin,
          canonicalOrigin: origin,
          routes: [{ kind: "canonical", origin, selected: true }],
          lastUsedAt: null,
          onThisComputer: false,
          accountAccess: null,
          availableActions: ["select"],
          failure: null,
          source: "manual",
          status: "idle",
          statusInfo: { status: "ready", reason: null },
        })),
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
  return { id, secondId, select, onAddPlace, signIn, checkDeployments, facts };
}

it("web keeps only app pages in the menu and ? still opens shortcuts", async () => {
  await mount("/");
  await openMenu();
  expect(menuLabels()).toEqual(["Automations", "Settings"]);
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
it("desktop shows computers with team and attention facts, then closes on selection or add", async () => {
  const fixture = desktop();
  await mount("/");
  expect(readFacts).not.toHaveBeenCalled();
  await openMenu();
  expect(menuLabels()).toEqual(["Automations", "Settings"]);
  const computers = element('[aria-label="Your computers"]');
  expect([...computers.querySelectorAll(".place-row__name")].map((row) => row.textContent)).toEqual(
    ["Home Mac", "Lab Mac"],
  );
  const lab = [...computers.querySelectorAll<HTMLButtonElement>(".place-row")].find((row) =>
    row.textContent?.includes("Lab Mac"),
  )!;
  expect(lab.textContent).toContain("Acme");
  expect(lab.querySelector('[aria-label="7 mentions in Acme"]')).not.toBeNull();
  expect(lab.querySelector('[aria-label="3 requests need you"]')).not.toBeNull();
  expect(computers.querySelector('[aria-label="Unread task results"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain("Acme server");
  expect(document.body.textContent).not.toContain("Projects");
  expect(document.body.textContent).not.toContain("Switch computer…");
  expect(document.body.textContent).toContain("alex@example.test");
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(fixture.select).not.toHaveBeenCalled();

  fixture.facts.needsYou = 1;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(lab.querySelector('[aria-label="1 requests need you"]')).not.toBeNull();
  await click(lab);
  expect(fixture.select).toHaveBeenCalledWith({ deploymentId: fixture.id });
  expect(document.querySelector(".popover")).toBeNull();
  expect(document.activeElement).toBe(element(".sidebar__place"));
  await openMenu();
  const add = [...document.querySelectorAll<HTMLButtonElement>(".popover button")].find(
    (button) => button.textContent === "Add a computer or server",
  );
  expect(add).toBeDefined();
  await click(add!);
  expect(fixture.onAddPlace).toHaveBeenCalledOnce();
  expect(document.querySelector(".popover")).toBeNull();
});
it("ended sign-in keeps its footer alert and offers sign-in in the computer menu", async () => {
  const fixture = desktop(true);
  await mount("/");
  expect(document.querySelector(".sidebar__place-alert")).not.toBeNull();
  expect(element(".sidebar__place").getAttribute("aria-label")).toContain(
    "Sign in again. Places and menu",
  );
  await openMenu();
  expect(element(".popover .place-card__title").textContent).toBe("Sign in again");
  expect(document.querySelector("[role=dialog]")).toBeNull();
  const signIn = [...document.querySelectorAll<HTMLButtonElement>(".popover button")].find(
    (button) => button.textContent === "Sign in again",
  );
  await click(signIn!);
  expect(fixture.signIn).toHaveBeenCalledOnce();
  expect(fixture.select).not.toHaveBeenCalled();
});
