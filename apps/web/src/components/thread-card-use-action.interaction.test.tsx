// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { MockHostClient, mockCardUseRequest } from "@opensteer/client/mock";
import { CardUseRequestBody } from "./thread-card-use-action.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("allows the offered card with Return and settles through the shared Host command", async () => {
  const request = mockCardUseRequest();
  const client = new MockHostClient({ latencyMs: 0, pendingRequests: [request] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <CardUseRequestBody
          client={client}
          disabled={false}
          request={request}
          workspaceName="Main"
        />,
      ),
    );
    const radio = container.querySelector("input");
    if (!radio) throw new Error("The offered card never appeared");
    expect(document.activeElement).toBe(radio);
    await act(async () =>
      radio.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(client.getSnapshot().requests[request.originatingThreadId]).not.toContainEqual(
      expect.objectContaining({ id: request.id }),
    );
    expect(JSON.stringify(client.getSnapshot())).not.toContain("Preview card");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});
