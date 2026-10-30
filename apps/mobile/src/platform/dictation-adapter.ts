import {
  DictationAvailabilitySchema,
  DictationEventSchema,
  DictationSessionIdSchema,
  type DictationPort,
} from "@opensteer/protocol/dictation";

export interface NativeDictation {
  availability(): Promise<string>;
  start(session: string): Promise<void>;
  download(session: string): Promise<void>;
  stop(session: string): Promise<void>;
  cancel(session: string): Promise<void>;
  openMicrophoneSettings(): Promise<void>;
  addListener(event: "onDictation", listener: (value: unknown) => void): { remove(): void };
}

export function createDictationPort(native: NativeDictation): DictationPort {
  let active: { session: string; seq: number } | null = null;
  // Expo async functions can enter Swift out of order. Acceptance must precede cancellation.
  let accepted: Promise<void> = Promise.resolve();
  const dispatch = (work: () => Promise<void>): Promise<void> => {
    const result = accepted.then(work);
    accepted = result.catch(() => {});
    return result;
  };
  const command = async (kind: "start" | "download", session: string): Promise<void> => {
    DictationSessionIdSchema.parse(session);
    active = { session, seq: 0 };
    await dispatch(() => native[kind](session));
  };
  return {
    availability: async () =>
      DictationAvailabilitySchema.parse(JSON.parse(await native.availability())),
    start: (session) => command("start", session),
    download: (session) => command("download", session),
    stop: async (session) => {
      const id = DictationSessionIdSchema.parse(session);
      await dispatch(() => native.stop(id));
    },
    cancel: async (session) => {
      if (active?.session === session) active = null;
      const id = DictationSessionIdSchema.parse(session);
      await dispatch(() => native.cancel(id));
    },
    openMicrophoneSettings: () => native.openMicrophoneSettings(),
    subscribe: (listener) => {
      const subscription = native.addListener("onDictation", (value) => {
        if (!active) return;
        let input: unknown;
        try {
          if (
            typeof value !== "object" ||
            value === null ||
            !("json" in value) ||
            typeof value.json !== "string"
          )
            throw new Error("Invalid dictation envelope");
          input = JSON.parse(value.json);
          if (
            typeof input === "object" &&
            input !== null &&
            "session" in input &&
            input.session !== active.session
          )
            return;
          const event = DictationEventSchema.parse(input);
          if (event.seq <= active.seq) return;
          active.seq = event.seq;
          if (event.type === "ended") active = null;
          listener(event);
        } catch {
          const session = active;
          active = null;
          if (!session) return;
          void dispatch(() => native.cancel(session.session)).catch(() => {});
          listener({
            type: "ended",
            session: session.session,
            seq: session.seq + 1,
            reason: "failed",
            error: "service-unavailable",
          });
        }
      });
      return () => {
        subscription.remove();
      };
    },
  };
}
