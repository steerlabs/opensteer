// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeploymentAccessSnapshotSchema,
  type OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import { ComputerFactsStore } from "../../desktop/computer-facts.js";
import { DesktopWelcome } from "./desktop-entry.js";
import { desktopFirstScreenWords } from "./desktop-first-screen-words.js";
import { firstScreenOf, type DesktopFirstScreen } from "./desktop-first-screen.test-support.js";

/*
 * The first-run journey decides what the Mac app's first screen is with `firstScreenOf`. Here it
 * reads the real first screen in each of its three states. The signed-out welcome and the welcome
 * of a build without an account share the title "Welcome to Opensteer"; deciding by that title
 * stopped both trials of a run whose screen had Sign in on it.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const unanswered = () => new Promise<never>(() => undefined);

async function mount(account: Record<string, unknown>) {
  const snapshot = DeploymentAccessSnapshotSchema.parse({
    account,
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
    signIn: vi.fn(async () => undefined),
  } as unknown as OpensteerDesktopBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root?.render(
      <DesktopWelcome
        error={null}
        onConnect={() => undefined}
        onSetUpHere={vi.fn()}
        places={{
          bridge,
          facts: new ComputerFactsStore(unanswered),
          onAddPlace: () => undefined,
          snapshot,
        }}
      />,
    ),
  );
}

const screens: ReadonlyArray<{
  readonly name: string;
  readonly account: Record<string, unknown>;
  readonly shows: readonly string[];
  readonly is: DesktopFirstScreen;
}> = [
  {
    account: { available: true, status: "signed-out" },
    is: "sign-in",
    name: "the signed-out welcome",
    shows: ["Welcome to Opensteer", "Sign in", "Use without an account", "Other ways in"],
  },
  {
    account: {
      available: false,
      detail:
        "macOS Keychain is not accepting protected storage. In Keychain Access, lock and unlock the login keychain, then try again.",
      status: "error",
    },
    is: "keychain-refused",
    name: "the keychain screen",
    shows: ["Opensteer can’t use this Mac’s keychain", "Try again"],
  },
  {
    account: { available: false, status: "signed-out" },
    is: "no-account",
    name: "the welcome of a build without an account",
    shows: ["Welcome to Opensteer", "Connect to my Opensteer", "No account needed"],
  },
];

describe("the first-run journey's reading of the Mac app's first screen", () => {
  for (const screen of screens)
    it(`reads ${screen.name} as ${screen.is}`, async () => {
      await mount(screen.account);
      // The screen as the product renders it, so the table can't describe some other screen.
      for (const words of screen.shows) expect(document.body.textContent).toContain(words);
      expect(firstScreenOf(desktopFirstScreenWords)).toBe(screen.is);
    });

  it("reads Sign in under the shared welcome title, never as a build without an account", async () => {
    await mount({ available: true, status: "signed-out" });
    expect(document.body.textContent).toContain(desktopFirstScreenWords.welcomeTitle);
    expect(firstScreenOf(desktopFirstScreenWords)).toBe("sign-in");
  });

  it("then reads the screen signing in leads to, and its choice of this Mac", async () => {
    await mount({ available: true, email: "person@example.test", status: "signed-in" });
    expect(document.body.textContent).toContain(desktopFirstScreenWords.whereTitle);
    // The journey presses the button whose name starts with this, as a person would.
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((name) => name.startsWith(desktopFirstScreenWords.onThisMac))).toBe(true);
  });

  it("waits while no first screen is showing", () => {
    expect(firstScreenOf(desktopFirstScreenWords)).toBeNull();
  });
});
