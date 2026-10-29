// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsRedirect } from "./settings-redirect.js";

const mountedRoots: Root[] = [];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
});

describe("SettingsRedirect", () => {
  it("preserves a nested computer path, query, and fragment", async () => {
    const router = await renderRedirect({
      entry: "/computers/rnr_123?panel=folders#shared",
      from: "/computers",
      route: "/computers/*",
      to: "/settings/computers",
    });

    expect(locationOf(router)).toBe("/settings/computers/rnr_123?panel=folders#shared");
  });

  it("keeps integration callback parameters on the canonical Agent tools route", async () => {
    const router = await renderRedirect({
      entry: "/settings/integrations?integrationAttempt=attempt_123#authorization",
      from: "/settings/integrations",
      route: "/settings/integrations",
      to: "/settings/apps/tools",
    });

    expect(locationOf(router)).toBe(
      "/settings/apps/tools?integrationAttempt=attempt_123#authorization",
    );
  });
});

async function renderRedirect(input: {
  readonly entry: string;
  readonly from: string;
  readonly route: string;
  readonly to: string;
}) {
  const router = createMemoryRouter(
    [
      {
        element: <SettingsRedirect from={input.from} to={input.to} />,
        path: input.route,
      },
      { element: <p>Destination</p>, path: "*" },
    ],
    { initialEntries: [input.entry] },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

function locationOf(router: Awaited<ReturnType<typeof renderRedirect>>): string {
  const { hash, pathname, search } = router.state.location;
  return `${pathname}${search}${hash}`;
}
