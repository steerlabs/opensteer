// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
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
    activatePersonalTab: async (tabId: string, options: unknown) => {
      expect(tabId).toBe("tab");
      expect(options).toEqual({ asleep: true });
      activations++;
      expect(intents).toBe(1);
      await activated.promise;
      admission = { ...original, sessionId: "readmitted" };
      return { session: { id: "readmitted" } };
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
