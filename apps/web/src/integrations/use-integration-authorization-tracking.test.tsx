// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { createIntegrationId } from "@opensteer/integration-core";
import {
  useIntegrationAuthorizationTracking,
  type IntegrationAuthorizationTracking,
} from "./use-integration-authorization-tracking.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("integration authorization route tracking", () => {
  it("remembers a started attempt on the live route without losing query, hash, or state", async () => {
    const rendered = renderTracking();
    const attemptId = createIntegrationId("oauthAttempt");

    await act(async () => rendered.tracking.started(attemptId, false));

    expect(rendered.router.state.location).toMatchObject({
      hash: "#request-9",
      pathname: "/tasks/thread_123",
      search: `?panel=apps&integrationAttempt=${attemptId}`,
      state: { routeKey: "same-entry" },
    });
    expect(rendered.router.state.location.search).not.toContain("ticket");
  });

  it("remembers each attempt's return, still after it finishes", async () => {
    const { tracking } = renderTracking();
    const automatic = createIntegrationId("oauthAttempt");
    const button = createIntegrationId("oauthAttempt");
    await act(async () => tracking.started(automatic, true));
    await act(async () => tracking.started(button, false));
    await act(async () => tracking.finished(automatic));
    await act(async () => tracking.finished(button));
    expect(tracking.returnsByItself(automatic)).toBe(true);
    expect(tracking.returnsByItself(button)).toBe(false);
  });

  it("does not navigate after its owning page unmounts", async () => {
    const rendered = renderTracking();
    const attemptId = createIntegrationId("oauthAttempt");
    await act(async () => rendered.tracking.started(attemptId, false));
    act(() => rendered.unmount());
    await rendered.router.navigate("/settings");
    rendered.tracking.finished(attemptId);
    rendered.tracking.started(createIntegrationId("oauthAttempt"), false);
    expect(rendered.router.state.location.pathname).toBe("/settings");
    expect(rendered.router.state.location.search).toBe("");
  });

  it("lets an old saved callback clear only its matching attempt from the latest route", async () => {
    const rendered = renderTracking();
    const saved = rendered.tracking;
    const first = createIntegrationId("oauthAttempt");
    const newer = createIntegrationId("oauthAttempt");

    await act(async () => saved.started(first, false));
    await act(async () => saved.started(newer, false));
    await act(async () => saved.finished(first));

    expect(rendered.router.state.location).toMatchObject({
      hash: "#request-9",
      search: `?panel=apps&integrationAttempt=${newer}`,
      state: { routeKey: "same-entry" },
    });

    await act(async () => saved.finished(newer));

    expect(rendered.router.state.location).toMatchObject({
      hash: "#request-9",
      pathname: "/tasks/thread_123",
      search: "?panel=apps",
      state: { routeKey: "same-entry" },
    });
  });
});

function renderTracking(): {
  readonly router: ReturnType<typeof createMemoryRouter>;
  readonly tracking: IntegrationAuthorizationTracking;
  readonly unmount: () => void;
} {
  let tracking: IntegrationAuthorizationTracking | null = null;
  function Probe() {
    tracking = useIntegrationAuthorizationTracking();
    return null;
  }
  const router = createMemoryRouter([{ element: <Probe />, path: "*" }], {
    initialEntries: [
      {
        hash: "#request-9",
        pathname: "/tasks/thread_123",
        search: "?panel=apps",
        state: { routeKey: "same-entry" },
      },
    ],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<RouterProvider router={router} />));
  if (tracking === null) throw new Error("Tracking probe did not render");
  return {
    router,
    tracking,
    unmount: () => {
      root.unmount();
      roots.splice(roots.indexOf(root), 1);
    },
  };
}
