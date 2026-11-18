// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { ClientOperationError } from "@opensteer/client/connections";
import type { HostClient } from "@opensteer/client/host";
import { controlledClientSession } from "@opensteer/client/test-support";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";
import type { PagePresence } from "../ui/page-presence.js";
import { LocalPhoneTab } from "./local-tab.js";

vi.mock("../browser/browser-stream.js", () => ({
  useBrowserFeedState: () => ({ admitted: true }),
}));
vi.mock("./tab-host.js", () => ({
  PhoneBrowserTabHost: ({ admission }: { admission: PhonePresentationAdmission }) => (
    <div>Presented {admission.sessionId}</div>
  ),
}));

test("a returning local screen holds its intent across Host activation and never admits the retired session", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const original: PhonePresentationAdmission = {
    sessionId: "retired",
    surfaceId: "tab",
    bindingId: "binding",
    runtimeId: "runtime",
    targetControl: 1,
  };
  let admission = original;
  let intents = 0;
  const activated = Promise.withResolvers<void>();
  const manager = {
    markLocalPresentation: () => {
      intents++;
      return () => {
        intents--;
      };
    },
    localPresentation: () => admission,
  } as unknown as PhoneBrowserManager;
  let viewers = 0;
  let releasedAdmissions = 0;
  let activations = 0;
  const hostClient = {
    connection: controlledClientSession().connection,
    activateTab: async (tabId: string) => {
      expect(tabId).toBe("tab");
      activations++;
      expect(intents).toBe(1);
      await activated.promise;
      admission = { ...original, sessionId: "readmitted" };
      return { kind: "page", sessionId: "readmitted", surfaceId: "tab" };
    },
    retainBrowserViewer: (sessionId: string, surfaceId: string, options: unknown) => {
      expect(sessionId).toBe("readmitted");
      expect(surfaceId).toBe("tab");
      expect(options).toEqual({ picture: false, asleep: true });
      expect(intents).toBe(1);
      viewers++;
      return () => {
        viewers--;
        releasedAdmissions++;
      };
    },
  } as unknown as HostClient;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (
    available: boolean,
    liveSession = false,
    presence: PagePresence = { interactive: true, shown: true, held: true },
  ) => (
    <LocalPhoneTab
      presence={presence}
      available={available}
      deploymentId="deployment"
      hostClient={hostClient}
      manager={manager}
      admission={original}
      liveSession={liveSession}
      status={(message) => <div>{message}</div>}
    />
  );
  try {
    act(() => root.render(render(false)));
    expect(intents).toBe(1);
    expect(activations).toBe(0);
    act(() => root.render(render(true)));
    expect(activations).toBe(1);
    expect(container.textContent).toBe("Opening…");
    expect(viewers).toBe(0);
    await act(async () => activated.resolve());
    expect(container.textContent).toBe("Presented readmitted");
    expect(viewers).toBe(1);
    await act(async () => root.render(render(true, true)));
    expect(releasedAdmissions).toBe(0);
    expect(viewers).toBe(1);
    // Off screen the page gives up the visible slot's claim, wakes nothing, and keeps its viewer and page.
    await act(async () =>
      root.render(render(true, false, { interactive: false, shown: false, held: true })),
    );
    expect(intents).toBe(0);
    expect(activations).toBe(1);
    expect(viewers).toBe(1);
    expect(container.textContent).toBe("Presented readmitted");
    await act(async () => root.render(render(true, true)));
    expect(intents).toBe(1);
    expect(releasedAdmissions).toBe(0);
    expect(container.textContent).toBe("Presented readmitted");
  } finally {
    act(() => root.unmount());
  }
  expect(intents).toBe(0);
  expect(viewers).toBe(0);
});

test("a lost activation waits quietly and asks again on recovery; only the tab's own failure is said", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const admission: PhonePresentationAdmission = {
    sessionId: "session",
    surfaceId: "tab",
    bindingId: "binding",
    runtimeId: "runtime",
    targetControl: 1,
  };
  const manager = {
    markLocalPresentation: () => () => {},
    localPresentation: () => admission,
  } as unknown as PhoneBrowserManager;
  const session = controlledClientSession();
  const failures: Error[] = [
    new ClientOperationError("socket closed while activating", "transient", {
      kind: "transport",
      provenance: "transport",
      reason: "connection-lost",
      retryable: true,
    }),
  ];
  const activateTab = vi.fn(async () => {
    const failure = failures.shift();
    if (failure) throw failure;
  });
  const hostClient = {
    connection: session.connection,
    activateTab,
    retainBrowserViewer: () => () => {},
  } as unknown as HostClient;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => (
    <LocalPhoneTab
      presence={{ interactive: true, shown: true, held: true }}
      available
      deploymentId="deployment"
      hostClient={hostClient}
      manager={manager}
      admission={admission}
      liveSession={false}
      status={(message) => <div>{message}</div>}
    />
  );
  try {
    await act(async () => root.render(render()));
    expect(activateTab).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("Opening…");
    expect(container.textContent).not.toContain("socket closed");

    failures.push(new Error("The tab's page was closed on the Host."));
    await act(async () => session.change({ readyRevision: 2 }));
    expect(activateTab).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("This tab could not open.");

    // A later recovery without a lost activation asks nothing more.
    await act(async () => session.change({ readyRevision: 3 }));
    expect(activateTab).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
