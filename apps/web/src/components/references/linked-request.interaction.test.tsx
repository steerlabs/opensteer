// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { Request } from "@opensteer/core";
import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { useLinkedRequest } from "./linked-request.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const threadId = "thr_00000000-0000-4000-8000-000000000003";
const requestId = "req_0192f4a1-1111-4000-8000-000000000001";

/** The seeded Request a link names, as the Host returns it before and after it is answered. */
async function seededRequest(): Promise<{ pending: Request; settled: Request }> {
  const host = new MockHostClient({ latencyMs: 0 });
  try {
    await host.load();
    const pending = (await host.readRequest(threadId, requestId))!;
    await host.dispatch({
      idempotencyKey: "settle",
      requestId,
      response: { kind: "choice", optionId: "approve" },
      type: "request.respond",
    });
    return { pending, settled: (await host.readRequest(threadId, requestId))! };
  } finally {
    host.dispose();
  }
}

function Destination(props: {
  readonly client: HostClient;
  readonly onPending: (id: string) => void;
}) {
  const shown = useLinkedRequest(props.client, threadId, props.onPending);
  const { search } = useLocation();
  return (
    <>
      <output data-search="">{search}</output>
      {shown}
    </>
  );
}

/** Opens the link, then answers its read only once the address has already been released. */
async function openLink(answer: Request) {
  let release!: (request: Request) => void;
  const readRequest = vi.fn(
    () =>
      new Promise<Request | null>((resolve) => {
        release = resolve;
      }),
  );
  const client = {
    readRequest,
    references: { unavailable: vi.fn() },
  } as unknown as HostClient;
  const onPending = vi.fn();
  const router = createMemoryRouter(
    [{ path: "*", element: <Destination client={client} onPending={onPending} /> }],
    { initialEntries: [`/tasks/${threadId}?requestId=${requestId}`] },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RouterProvider router={router} />));
  expect(container.querySelector("[data-search]")?.textContent).toBe("");
  expect(readRequest).toHaveBeenCalledOnce();
  expect(readRequest).toHaveBeenCalledWith(threadId, requestId);
  await act(async () => release(answer));
  return { onPending };
}

it("shows a settled Request's receipt once its read settles after the link is released", async () => {
  const { settled } = await seededRequest();
  const { onPending } = await openLink(settled);
  expect(document.body.querySelector(".ref-request")?.textContent).toContain(
    "Send the launch email",
  );
  expect(onPending).not.toHaveBeenCalled();
});

it("hands a pending Request to be answered where it is", async () => {
  const { pending } = await seededRequest();
  const { onPending } = await openLink(pending);
  expect(onPending).toHaveBeenCalledWith(requestId);
  expect(document.body.querySelector(".ref-request")).toBeNull();
});
