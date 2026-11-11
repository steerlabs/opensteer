import {
  MANAGED_MEMORY_WAKE_SKIPPED,
  type TriggerProgram,
  type TriggerSystemRole,
} from "@opensteer/triggers";

/** Admission owns liveness and deduplication; the program makes one direct call. */
export function memoryPassProgram(role: TriggerSystemRole): TriggerProgram {
  const label = role === "memory-light" ? "Light" : "Nightly";
  const reference = role === "memory-light" ? "light-pass" : "nightly";
  return {
    language: "typescript",
    toolContractVersion: 3,
    source: `export default async function ({ event, opensteer }) {
  try {
    await opensteer.callTool("thread_send", {
      delivery: "queue",
      threadId: event.trigger.anchorThreadId,
      message: ${JSON.stringify(`${label} pass due (`)} + (event.source.scheduledFor ?? event.receivedAt) + ${JSON.stringify(`). Load opensteer:memory and follow its ${reference} reference.`)},
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ${JSON.stringify(MANAGED_MEMORY_WAKE_SKIPPED)}) throw error;
  }
}`,
  };
}
