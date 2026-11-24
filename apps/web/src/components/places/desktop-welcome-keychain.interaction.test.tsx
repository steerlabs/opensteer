// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  DeploymentAccessSnapshotSchema,
  desktopRefusal,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { ComputerFactsStore } from "../../desktop/computer-facts.js";
import { DesktopWelcome } from "./desktop-entry.js";

/*
 * The Mac's first screen when macOS refuses Opensteer its keychain (a locked keychain, a login
 * from another computer, a managed Mac): the account can't keep a sign-in, so it reads as
 * unavailable with an error. The screen says what is wrong and what to do, in plain words, and
 * offers to try again; it is never the welcome of a build without an account, with Sign in
 * silently gone.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const unanswered = () => new Promise<never>(() => undefined);

async function mount(signIn: () => Promise<void>, onSetUpHere = vi.fn()) {
  const snapshot = DeploymentAccessSnapshotSchema.parse({
    account: {
      available: false,
      detail:
        "macOS Keychain is not accepting protected storage. In Keychain Access, lock and unlock the login keychain, then try again.",
      status: "error",
    },
    deployments: [],
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
  });
  const bridge = {
    checkDeployments: vi.fn(async () => undefined),
    signIn: vi.fn(signIn),
  } as unknown as OpensteerDesktopBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root?.render(
      <DesktopWelcome
        error={null}
        onConnect={() => undefined}
        onSetUpHere={onSetUpHere}
        places={{
          bridge,
          facts: new ComputerFactsStore(unanswered),
          onAddPlace: () => undefined,
          snapshot,
        }}
      />,
    ),
  );
  return bridge;
}

function button(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
}

it("says Opensteer can't use this Mac's keychain, what to do, and offers to try again", async () => {
  await mount(async () => undefined);
  expect(document.querySelector("h1")?.textContent).toBe("Opensteer can’t use this Mac’s keychain");
  expect(document.body.textContent).toContain(
    "Opensteer keeps your sign-in in this Mac’s keychain, and the keychain isn’t letting it in. Unlock the login keychain in Keychain Access, or log in at the Mac itself instead of from another computer, then try again.",
  );
  // Not the welcome of a build without an account, and no words a person doesn't use.
  expect(document.body.textContent).not.toContain("Welcome to Opensteer");
  expect(document.body.textContent).not.toContain("No account needed");
  expect(document.body.textContent?.toLowerCase()).not.toContain("protected storage");
  expect(button("Try again")).toBeDefined();
});

it("tries again through the account's own sign-in", async () => {
  const bridge = await mount(async () => undefined);
  await act(async () => button("Try again")!.click());
  expect(bridge.signIn).toHaveBeenCalledOnce();
});

it("says so plainly when the keychain still refuses", async () => {
  await mount(async () =>
    Promise.reject(
      desktopRefusal(
        "Opensteer still can’t use this Mac’s keychain. Unlock the login keychain, then try again.",
      ),
    ),
  );
  await act(async () => button("Try again")!.click());
  await act(async () => undefined);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Opensteer still can’t use this Mac’s keychain. Unlock the login keychain, then try again.",
  );
});
