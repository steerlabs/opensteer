import type { AttachTicketVerifier } from "@opensteer/browser-runtime-core";
import { BrowserRuntimeError } from "@opensteer/browser-runtime-core";
import { browserHostMethods } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { openAgentAdmission } from "../app/agent-admission.js";
import { AgentBrowserGate, agentFrame } from "./agent-browser-gate.js";

const requestId = "6f1f1c55-8a0e-4f58-9a7e-2d8e7c1a3b44";
const origins = new Map<string, "agent" | "person">([
  ["agent-ticket", "agent"],
  ["person-ticket", "person"],
]);
const inner: AttachTicketVerifier = {
  verify: async (token) =>
    ({
      creationOrigin: origins.get(token) ?? "person",
      sessionId: `bsn_${token}`,
      identity: token === "agent-ticket" ? { kind: "fresh" } : { kind: "profile-local" },
    }) as Awaited<ReturnType<AttachTicketVerifier["verify"]>>,
};

function fixture() {
  const admission = openAgentAdmission();
  const gate = new AgentBrowserGate(admission);
  const verifier = gate.verifier(inner);
  const sink = { sendServer: vi.fn(async () => undefined) };
  const handled: string[] = [];
  const attachment = () => ({
    handle: vi.fn(async (frame: string | Buffer) => {
      handled.push(String(frame));
    }),
    close: vi.fn(async () => undefined),
  });
  /** What the runtime does inside attach: verify the ticket, then open. */
  const open = (ticket: string, opening: (signal: AbortSignal) => Promise<void> = async () => {}) =>
    gate.attach(ticket, sink, undefined, async (signal) => {
      await verifier.verify(ticket, { runtimeId: "runtime" });
      await opening(signal);
      return attachment();
    });
  return { admission, gate, handled, open, sink, verifier };
}

const agentCommand = JSON.stringify({
  type: "cdp.command",
  requestId,
  command: { method: "Input.dispatchMouseEvent", parameters: {} },
});
const viewerInput = JSON.stringify({ type: "input.text", surfaceId: "bsf_x", text: "hi" });
const hostCloseTab = JSON.stringify({
  type: "cdp.command",
  requestId,
  command: { method: browserHostMethods.closeTab, parameters: {} },
});

describe("agent frames", () => {
  it("tells an agent's commands from the person's input and the Host's tab management", () => {
    expect(agentFrame(agentCommand)).toEqual({ requestId });
    expect(agentFrame(viewerInput)).toBeNull();
    expect(agentFrame(hostCloseTab)).toBeNull();
    expect(agentFrame("not json")).toBeNull();
  });
});

describe("the person's Stop for this Mac's browsers", () => {
  it("keeps the person's session open and their input flowing, refusing only agent commands", async () => {
    const { admission, handled, open, sink } = fixture();
    const session = await open("person-ticket");
    admission.close();
    expect(session.close).not.toHaveBeenCalled();
    await session.handle(viewerInput);
    await session.handle(hostCloseTab);
    await session.handle(agentCommand);
    expect(handled).toEqual([viewerInput, hostCloseTab]);
    expect(sink.sendServer).toHaveBeenCalledWith({
      type: "cdp.error",
      requestId,
      error: expect.objectContaining({ code: "forbidden", reason: "device-stopped" }),
    });
    admission.reopen();
    await session.handle(agentCommand);
    expect(handled).toEqual([viewerInput, hostCloseTab, agentCommand]);
  });

  it("refuses an agent's new tab and an agent's tab-open authority while stopped", async () => {
    const { admission, open, verifier } = fixture();
    admission.close();
    await expect(open("agent-ticket")).rejects.toThrow(BrowserRuntimeError);
    await expect(verifier.verify("agent-ticket", { runtimeId: "runtime" })).rejects.toThrow(
      /stopped on this Mac/,
    );
    await expect(open("person-ticket")).resolves.toBeDefined();
  });

  it("cancels an agent's open that is under way when Stop begins", async () => {
    const { admission, open } = fixture();
    const opening = open(
      "agent-ticket",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          queueMicrotask(() => admission.close());
        }),
    );
    await expect(opening).rejects.toThrow(/stopped on this Mac/);
  });

  it("ends an agent's open that finished in a generation Stop already closed, even after Resume", async () => {
    const { admission, gate, open } = fixture();
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const opening = open("agent-ticket", async () => {
      started.resolve();
      await held.promise;
    });
    await started.promise;
    admission.close();
    admission.reopen();
    held.resolve();
    await expect(opening).rejects.toThrow(/stopped on this Mac/);
    expect(gate.agentTabs).toBe(0);
  });

  it("counts tabs an agent opened until they close", async () => {
    const { gate, open } = fixture();
    const changed = vi.fn();
    gate.subscribe(changed);
    const agent = await open("agent-ticket");
    await open("person-ticket");
    expect(gate.agentTabs).toBe(1);
    expect(gate.agentTabDetails()).toEqual([{ sessionId: "bsn_agent-ticket", profile: false }]);
    await agent.close();
    await agent.close();
    expect(gate.agentTabs).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
