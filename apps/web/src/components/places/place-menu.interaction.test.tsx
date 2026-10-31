// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  DeploymentAccessSnapshotSchema,
  type DeploymentAccessDeployment,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { PlaceMenuPlaces } from "./place-menu.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function mount(overrides: Partial<DeploymentAccessDeployment> = {}, expired = false) {
  const id = createId("deployment");
  const snapshot = DeploymentAccessSnapshotSchema.parse({
    account: {
      available: true,
      status: expired ? "error" : "signed-in",
      detail: expired ? "Your Opensteer Account authorization expired. Sign in again." : undefined,
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
        statusInfo: { status: "attention", reason: "This server did not answer." },
        ...overrides,
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
    selectedDeploymentId: overrides.status === "connected" ? id : null,
    unavailable: [],
  });
  const select = vi.fn(async () => undefined);
  const checkDeployments = vi.fn(async () => undefined);
  const signIn = vi.fn(async () => undefined);
  const onClose = vi.fn();
  const onAddPlace = vi.fn();
  const bridge = { select, checkDeployments, signIn } as unknown as OpensteerDesktopBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root?.render(
      <PlaceMenuPlaces
        onClose={onClose}
        places={{ bridge, snapshot, cloudDeploymentIds: new Set(), onAddPlace }}
      />,
    ),
  );
  return { id, select, checkDeployments, signIn, onClose, onAddPlace };
}
async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

it("expired Account sign-in explains authorization without calling computers offline", async () => {
  const fixture = await mount(
    {
      name: "Alex’s MacBook Pro",
      source: "account",
      kind: "personal",
      statusInfo: { status: "attention", reason: "Sign in to see this computer." },
    },
    true,
  );
  expect(document.querySelector(".place-row__name")?.textContent).toBe("Alex’s MacBook Pro");
  expect(document.body.textContent).toContain("Sign in");
  expect(document.body.textContent).not.toMatch(/offline|did not answer/i);
  await click(".place-row");
  expect(document.body.textContent).toContain("Sign in to see this computer.");
  const signIn = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Sign in again",
  );
  expect(signIn).toBeDefined();
  await act(async () => signIn!.click());
  expect(fixture.signIn).toHaveBeenCalledOnce();
});
it("an unanswered server explains itself and remains openable", async () => {
  const fixture = await mount();
  await click(".place-row");
  expect(document.querySelector(".place-row__explain p")?.textContent).toBe(
    "This server did not answer.",
  );
  expect(
    [...document.querySelectorAll(".place-row__actions button")].map(
      (button) => button.textContent,
    ),
  ).toEqual(["Open anyway", "Check again"]);
  await click(".place-row__actions button");
  expect(fixture.select).toHaveBeenCalledWith({ deploymentId: fixture.id });
  expect(fixture.onClose).toHaveBeenCalledOnce();
});
it("the current place expands its problem without closing or selecting and offers only Check again", async () => {
  const reason = "Messaging on this Mac stopped responding. Restart Opensteer to retry.";
  const fixture = await mount({
    name: "Alex’s MacBook Pro (2)",
    kind: "personal",
    status: "connected",
    source: "this-device",
    onThisComputer: true,
    statusInfo: { status: "attention", reason },
  });
  expect(document.querySelector(".place-row__name")?.textContent).toBe("Alex’s MacBook Pro (2)");
  await click(".place-row");
  expect(document.querySelector(".place-row")?.getAttribute("aria-current")).toBe("true");
  expect(document.querySelector(".place-row")?.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".place-row__explain p")?.textContent).toBe(reason);
  const actions = [...document.querySelectorAll<HTMLButtonElement>(".place-row__actions button")];
  expect(
    actions.map((button) => ({ text: button.textContent, disabled: button.disabled })),
  ).toEqual([{ text: "Check again", disabled: false }]);
  expect(fixture.select).not.toHaveBeenCalled();
  expect(fixture.onClose).not.toHaveBeenCalled();
  await click(".place-row__actions button");
  expect(fixture.checkDeployments).toHaveBeenCalledTimes(2);
});

it("adding a computer closes the chooser before opening the add screen", async () => {
  const fixture = await mount();
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Add a computer or server",
  );
  expect(add).toBeDefined();
  await act(async () => add!.click());
  expect(fixture.onClose).toHaveBeenCalledOnce();
  expect(fixture.onAddPlace).toHaveBeenCalledOnce();
  expect(fixture.onClose.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.onAddPlace.mock.invocationCallOrder[0]!,
  );
});
