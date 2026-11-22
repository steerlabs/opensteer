import { createPublicKey, randomUUID } from "node:crypto";
import type {
  BrowserPoolAgentCall,
  BrowserPoolAgentKind,
  BrowserPoolAgentStatus,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { homeKeyPair, startTestPoolAgent, testGuest, type TestPoolAgent } from "./test-support.js";

/** One slot on a fake hypervisor, its Home key, and the calls a Home would make. */
export const slotId = "slot-r";
export const open: TestPoolAgent[] = [];

export function callFor(
  status: BrowserPoolAgentStatus,
  kind: BrowserPoolAgentKind,
  extra: Partial<BrowserPoolAgentCall> = {},
): BrowserPoolAgentCall {
  return {
    id: randomUUID(),
    slotId: status.slotId,
    term: status.term,
    kind,
    expect: {
      instance: status.instance,
      epoch: status.epoch,
      phase: status.phase,
      savedStateId: status.savedState?.id ?? null,
    },
    ...(kind === "resume" ? { intent: { id: randomUUID(), sequence: 1 } } : {}),
    ...(kind === "sign"
      ? {
          control: {
            kind: "retire" as const,
            fence: {
              slot: status.slotId,
              term: status.term,
              instance: status.instance!,
              epoch: status.epoch!,
            },
            intent: { id: randomUUID(), sequence: 1 },
          },
        }
      : {}),
    ...extra,
  };
}

export async function fixture(options: Parameters<typeof startTestPoolAgent>[0] = {}) {
  const events: Record<string, unknown>[] = [];
  let agent = await startTestPoolAgent({ log: (event) => events.push({ ...event }), ...options });
  open.push(agent);
  const home = homeKeyPair();
  const summary = await agent.agent.createSlot({
    slotId,
    term: 1,
    homeKey: home.spki,
    guest: testGuest,
  });
  const controlKey = createPublicKey({
    key: Buffer.from(summary.controlKey, "base64"),
    format: "der",
    type: "spki",
  });
  return {
    get agent() {
      return agent;
    },
    get driver() {
      return agent.driver;
    },
    events,
    home,
    controlKey,
    status: () => agent.agent.status(slotId, 1),
    call: async (kind: BrowserPoolAgentKind, extra: Partial<BrowserPoolAgentCall> = {}) =>
      agent.agent.apply(callFor(await agent.agent.status(slotId, 1), kind, extra)),
    restart: async (next: Parameters<TestPoolAgent["restart"]>[0] = {}) => {
      const index = open.indexOf(agent);
      agent = await agent.restart(next);
      open.splice(index, 1, agent);
      return agent;
    },
    phase: () => agent.agent.summaries().find((entry) => entry.slotId === slotId)?.status.phase,
  };
}
