// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
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
    const reviewed = await client.readRequest(request.originatingThreadId, request.id);
    if (!reviewed) throw new Error("The offered card request never appeared");
    await act(async () =>
      root.render(<CardUseRequestBody client={client} disabled={false} request={reviewed} />),
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

it("says a card use the Home ended is no longer running, never beside the time it expires in", async () => {
  const request = mockCardUseRequest();
  const client = new MockHostClient({ latencyMs: 0, pendingRequests: [request] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const reviewed = await client.readRequest(request.originatingThreadId, request.id);
    if (!reviewed) throw new Error("The card request never appeared");
    client.cardUseMockStates.set(request.id, "gone");
    await act(async () =>
      root.render(<CardUseRequestBody client={client} disabled={false} request={reviewed} />),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("This card use is no longer running."),
    );
    expect(container.textContent).not.toMatch(/Expires in/u);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});
