// @vitest-environment happy-dom
import { MockHostClient } from "@opensteer/client/mock";
import { createId } from "@opensteer/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ShellContext } from "../app-shell.js";
import { DevicesSection } from "./devices-page.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.dispose();
  host = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
  window.localStorage.clear();
});

/** This browser window, signed in to the Home and bound to no device, as a person's web app is. */
const thisWindow = {
  absoluteExpiresAt: "2026-12-14T00:00:00.000Z",
  createdAt: "2026-11-25T00:00:00.000Z",
  current: true,
  deviceId: null,
  deviceLabel: "Browser on Mac",
  expiresAt: "2026-12-01T00:00:00.000Z",
  form: "computer" as const,
  id: createId("authSession"),
  lastSeenAt: "2026-11-25T00:00:00.000Z",
};

const rowButton = () =>
  [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === "Sign out This browser window",
  ) as HTMLButtonElement | undefined;
/** This window's row, once the Devices page has read where the person is signed in. */
const signedInRow = () => vi.waitFor(() => expect(rowButton()).toBeDefined());

it("keeps the sign-out confirmation through a re-read of the devices, and signs this window out when confirmed", async () => {
  host = new MockHostClient({ latencyMs: 0, sessions: [thisWindow] });
  const dispatch = vi.spyOn(host, "dispatch");
  // The page's client, counting its reads of where the person is signed in.
  let reads = 0;
  const counted = new Proxy(host, {
    get(target, property) {
      if (property === "rpc")
        return new Proxy(target.rpc, {
          get(rpc, name) {
            const value = Reflect.get(rpc, name) as unknown;
            if (name !== "sessions.list" || typeof value !== "function") return value;
            return (...args: unknown[]) => {
              reads++;
              return (value as (...input: unknown[]) => unknown)(...args);
            };
          },
        });
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    assign,
  } as Location);
  const shell = (machineRevision: number) =>
    ({
      hostClient: counted,
      snapshot: { ...host!.getSnapshot(), machineRevision },
      desktopBridge: null,
      desktopDeployment: null,
      deploymentAccess: { deployments: [] },
    }) as unknown as React.ContextType<typeof ShellContext>;
  const draw = (machineRevision: number) =>
    root!.render(
      <MemoryRouter>
        <ShellContext value={shell(machineRevision)}>
          <DevicesSection />
        </ShellContext>
      </MemoryRouter>,
    );
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => draw(1));
  await signedInRow();
  // The person asks to sign out this browser window and is asked to confirm.
  await act(async () => rowButton()!.click());
  expect(document.body.textContent).toContain("Sign out this device?");
  // Meanwhile the devices are read again, as every machine read and every reconnection does.
  const before = reads;
  await act(async () => draw(2));
  await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
  await act(async () => undefined);
  // The confirmation is still there, and confirming it signs this window out.
  expect(document.body.textContent).toContain("Sign out this device?");
  const confirm = [...document.querySelectorAll(".dialog button")].find(
    (element) => element.textContent?.trim() === "Sign out",
  ) as HTMLButtonElement | undefined;
  expect(confirm).toBeDefined();
  await act(async () => confirm!.click());
  await vi.waitFor(() => expect(assign).toHaveBeenCalled());
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "session.revoke", sessionId: thisWindow.id }),
  );
  expect(assign).toHaveBeenCalledWith("/");
  // This browser stays signed out of this Opensteer until the person chooses to sign in again.
  expect(window.localStorage.getItem("opensteer.signed-out-here")).not.toBeNull();
});

it("says in the confirmation when the sign-out did not reach the Home, and stays where it is", async () => {
  host = new MockHostClient({ latencyMs: 0, sessions: [thisWindow] });
  // The Home cannot be reached: the request never gets an answer it can read.
  vi.spyOn(host, "dispatch").mockRejectedValue(new TypeError("Failed to fetch"));
  const assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({
    ...window.location,
    assign,
  } as Location);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <ShellContext
          value={
            {
              hostClient: host,
              snapshot: host!.getSnapshot(),
              desktopBridge: null,
              desktopDeployment: null,
              deploymentAccess: { deployments: [] },
            } as unknown as React.ContextType<typeof ShellContext>
          }
        >
          <DevicesSection />
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  await signedInRow();
  await act(async () => rowButton()!.click());
  const confirm = [...document.querySelectorAll(".dialog button")].find(
    (element) => element.textContent?.trim() === "Sign out",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  // The confirmation stays, and says it, in the place the person is looking.
  await vi.waitFor(() =>
    expect(document.querySelector('.dialog [role="alert"]')?.textContent).toMatch(/sign/iu),
  );
  expect(assign).not.toHaveBeenCalled();
});
