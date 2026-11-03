// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import { useComputerAppApproval } from "./computer-app-approval.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("loads owner details only on review and clears them when the signed-in session changes", async () => {
  let owner = "owner";
  let notify = () => {};
  const rpc = vi.fn(async () => ({
    ok: true,
    data: {
      request: {
        id: "request",
        kind: "server",
        server: {
          name: "Server",
          installationTitle: "Plugin",
          launch: {
            type: "stdio",
            command: "/private/owner-program",
            env: { TOKEN: "owner-secret" },
          },
        },
      },
      app: null,
    },
  }));
  const host = {
    getSnapshot: () => ({ user: { id: owner } }),
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {};
    },
    rpc: { "integration.computer.setup.review": rpc },
    dispatch: vi.fn(),
    refresh: vi.fn(),
  } as unknown as HostClient;
  function Review() {
    const approval = useComputerAppApproval(host);
    return (
      <>
        {approval.dialog}
        <button onClick={() => void approval.ask("request")}>Review</button>
      </>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Review />));
    expect(rpc).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toContain("/private/owner-program");
    expect(container.textContent).toContain("owner-secret");
    await act(async () => {
      owner = "another-owner";
      notify();
    });
    expect(container.textContent).not.toContain("owner-secret");
    expect(container.textContent).not.toContain("/private/owner-program");
    expect(host.dispatch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
