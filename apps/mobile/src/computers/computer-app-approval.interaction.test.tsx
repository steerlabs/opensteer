// @vitest-environment happy-dom
import type { HostClient } from "@opensteer/client/host";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Modal: ({ children, visible }: { children?: ReactNode; visible?: boolean }) =>
    visible ? <div>{children}</div> : null,
  Platform: { OS: "ios", Version: "26" },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Field: (props: {
    hint?: string;
    input: {
      onChangeText: (value: string) => void;
      placeholder?: string;
      secureTextEntry?: boolean;
      value: string;
    };
    label: string;
  }) => (
    <label>
      {props.label}
      <span>{props.hint}</span>
      <input
        aria-label={props.label}
        onChange={(event) => props.input.onChangeText(event.currentTarget.value)}
        placeholder={props.input.placeholder}
        type={props.input.secureTextEntry ? "password" : "text"}
        value={props.input.value}
      />
    </label>
  ),
  SecondaryButton: (props: { disabled?: boolean; label: string; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

const { useComputerAppApproval } = await import("./computer-app-approval.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("asks a phone for a server's secrets and sends what was entered", async () => {
  const review = vi.fn(async () => ({
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
              {
                description: "From the Tapo app.",
                name: "CAMERA_PASSWORD",
                title: "Camera password",
              },
            ],
          },
        },
      },
      app: null,
      savedSecrets: [],
    },
  }));
  const dispatch = vi.fn(async () => ({ type: "integration.computer.setup.respond" }));
  const host = {
    getSnapshot: () => ({ user: { id: "owner" } }),
    subscribe: () => () => {},
    rpc: { "integration.computer.setup.review": review },
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
    const field = document.querySelector<HTMLInputElement>("input")!;
    expect(field.type).toBe("password");
    expect(document.body.textContent).toContain("From the plugin: From the Tapo app.");

    await act(async () => button("Allow").click());
    expect(document.body.textContent).toContain("Enter Camera password.");
    expect(dispatch).not.toHaveBeenCalled();

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(field, "hunter2");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Allow").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        secrets: { CAMERA_PASSWORD: "hunter2" },
        type: "integration.computer.setup.respond",
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
