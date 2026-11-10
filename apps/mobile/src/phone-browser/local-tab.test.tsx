// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import type { PhoneBrowserManager, PhonePresentationAdmission } from "./manager.js";
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
    activateWorkspaceTab: async () => {
      activations++;
      expect(intents).toBe(1);
      await activated.promise;
      admission = { ...original, sessionId: "readmitted" };
      return { session: { id: "readmitted" } };
    },
    retainBrowserViewer: (sessionId: string) => {
      expect(sessionId).toBe("readmitted");
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
  const render = (available: boolean, liveSession = false) => (
    <LocalPhoneTab
      active
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
  } finally {
    act(() => root.unmount());
  }
  expect(intents).toBe(0);
  expect(viewers).toBe(0);
});
