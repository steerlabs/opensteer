import { BrowserRuntimeError } from "@opensteer/browser-runtime-core";
import { expect, it, vi } from "vitest";
import { AgentBrowserGate } from "./agent-browser-gate.js";

const attachment = () => ({ close: vi.fn(async () => undefined) });

it("counts live attachments and forgets one its socket closed", async () => {
  const gate = new AgentBrowserGate();
  const changed = vi.fn();
  gate.subscribe(changed);
  const first = gate.admit(attachment());
  gate.admit(attachment());
  expect(gate.inUse).toBe(2);
  await first.close();
  await first.close();
  expect(gate.inUse).toBe(1);
  expect(changed).toHaveBeenCalledTimes(3);
});

it("ends every attachment on Stop and refuses new ones until resumed", async () => {
  const gate = new AgentBrowserGate();
  const live = attachment();
  const close = live.close;
  gate.admit(live);
  await gate.pause();
  expect(close).toHaveBeenCalledTimes(1);
  expect(gate.inUse).toBe(0);
  expect(() => gate.assertOpen()).toThrow(BrowserRuntimeError);

  const late = attachment();
  expect(() => gate.admit(late)).toThrow(/stopped on this Mac/);
  expect(late.close).toHaveBeenCalledTimes(1);
  expect(gate.inUse).toBe(0);

  gate.resume();
  gate.assertOpen();
  gate.admit(attachment());
  expect(gate.inUse).toBe(1);
});
