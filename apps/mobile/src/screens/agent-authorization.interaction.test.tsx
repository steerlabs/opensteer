// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MockHostClient } from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  host: null as unknown,
  openURL: vi.fn(async () => undefined),
  goBack: vi.fn(),
}));

vi.mock("react-native", () => ({ Linking: { openURL: state.openURL } }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: state.goBack }) }));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => state.host,
}));
vi.mock("./agent-authorization-form.js", () => ({
  AgentAuthorizationForm: (props: { kind: string; title?: string; onAllow?: () => void }) =>
    props.kind === "ready" ? (
      <button onClick={props.onAllow} type="button">
        {props.title}
      </button>
    ) : null,
}));

const { AgentAuthorizationScreen } = await import("./agent-authorization.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
});

function render(requestId: string) {
  return root!.render(
    <AgentAuthorizationScreen
      route={{ params: { deploymentId: "deployment-a", requestId } } as never}
    />,
  );
}

describe("approving an agent on the phone", () => {
  it("never opens the completion of a request another request has replaced", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    state.host = host;
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(async ({ requestId }: { requestId: string }) => ({
        ok: true,
        data: {
          requestId,
          clientName: requestId[0] === "a" ? "First agent" : "Second agent",
          redirectUri: "https://agent.example/callback",
          resource: "https://mac.connect.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          workspaces: [],
        },
      })),
      configurable: true,
    });
    let finish:
      ((output: { type: "connection.authorize"; completionPath: string }) => void) | undefined;
    vi.spyOn(host, "dispatch").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => render("a".repeat(43)));
    await act(async () => container.querySelector("button")!.click());
    expect(finish).toBeTypeOf("function");
    await act(async () => render("b".repeat(43)));
    expect(container.textContent).toContain("Second agent");
    await act(async () =>
      finish!({ type: "connection.authorize", completionPath: "/oauth/mcp/complete?request=a" }),
    );
    expect(state.openURL).not.toHaveBeenCalled();
    expect(state.goBack).not.toHaveBeenCalled();
  });
});
