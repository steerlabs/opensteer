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

it("asks for a server's secrets, keeps saved ones blank, and sends only what was entered", async () => {
  const rpc = vi.fn(async () => ({
    ok: true,
    data: {
      request: {
        id: "request",
        kind: "server",
        server: {
          name: "camera",
          installationTitle: "Tapo",
          launch: {
            type: "stdio",
            command: "node",
            args: [],
            cwd: "/plugin",
            env: {},
            secrets: [
              { name: "CAMERA_PASSWORD", title: "Camera password" },
              { name: "CAMERA_USER", title: "Camera user" },
            ],
          },
        },
      },
      app: null,
      savedSecrets: ["CAMERA_USER"],
    },
  }));
  const dispatch = vi.fn(async () => ({ type: "integration.computer.setup.respond" }));
  const host = {
    getSnapshot: () => ({ user: { id: "owner" } }),
    subscribe: () => () => {},
    rpc: { "integration.computer.setup.review": rpc },
    dispatch,
    refresh: vi.fn(async () => undefined),
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
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((each) => each.textContent === label)!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Review />));
    await act(async () => button("Review").click());
    const fields = [...document.querySelectorAll<HTMLInputElement>("input")];
    expect(fields.map(({ type }) => type)).toEqual(["password", "password"]);
    expect(fields[1]?.placeholder).toBe("Saved. Leave blank to keep it.");
    expect(document.body.textContent).toContain("Its program receives this as CAMERA_PASSWORD.");

    await act(async () => button("Allow").click());
    expect(document.body.textContent).toContain("Enter Camera password.");
    expect(dispatch).not.toHaveBeenCalled();

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(fields[0], "hunter2");
      fields[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Allow").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        secrets: { CAMERA_PASSWORD: "hunter2" },
        setupRequestId: "request",
        type: "integration.computer.setup.respond",
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
