import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { requestDecisionRevision } from "./client.js";
import { HttpHostClient } from "./host-session-client.js";

/*
 * The real client over the scoped wire: every value comes from protocol frames and Host reads,
 * never from the mock's own model, so a HostSnapshot field nothing fills shows up here.
 */

const open: { client: HttpHostClient; host: MockPersonalHost }[] = [];
afterEach(() => {
  for (const { client, host } of open.splice(0)) {
    client.dispose();
    host.dispose();
  }
});

async function connect(seed = new MockHostClient({ latencyMs: 0 })) {
  const host = new MockPersonalHost(seed);
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: host.fetch,
    webSocketFactory: host.connect,
    capabilities: [],
  });
  open.push({ client, host });
  await client.load();
  return { client, host };
}

it("lists the Requests this person answers, and drops one once it is answered", async () => {
  const { client, host } = await connect();
  const pending = host.client.getSnapshot().waitingRequests;
  expect(pending.length).toBeGreaterThan(0);
  await vi.waitFor(() =>
    expect(
      client
        .getSnapshot()
        .waitingRequests.map(({ request }) => request.id)
        .sort(),
    ).toEqual(pending.map(({ request }) => request.id).sort()),
  );
  const answered = pending.find(({ request }) => request.kind === "plugin.approval")!;
  const reviewed = await client.readRequest(
    answered.request.originatingThreadId,
    answered.request.id,
  );
  await client.dispatch({
    type: "request.respond",
    idempotencyKey: "answer-approval",
    requestId: answered.request.id,
    ...requestDecisionRevision(reviewed!),
    response: { kind: "external", value: { decision: "declined" } },
  });
  await vi.waitFor(() =>
    expect(
      client
        .getSnapshot()
        .waitingRequests.some(({ request }) => request.id === answered.request.id),
    ).toBe(false),
  );
});
