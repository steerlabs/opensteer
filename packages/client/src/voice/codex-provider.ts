import { z } from "zod";
import type { HostApiClient } from "@opensteer/protocol";
import {
  VoiceSessionIdSchema,
  voiceLeaseMs,
  voiceRenewIntervalMs,
} from "@opensteer/protocol/voice";
import {
  VoiceStartError,
  type VoiceCall,
  type VoiceEndReason,
  type VoiceMediaPort,
  type VoiceProvider,
  type VoiceStartFailure,
} from "./contract.js";
import { voiceTimers, type VoiceTimer, type VoiceTimers } from "./timers.js";

export interface CodexVoiceProviderInput extends VoiceTimers {
  readonly rpc: Pick<HostApiClient, "voice.start" | "voice.renew" | "voice.say" | "voice.stop">;
  readonly media: VoiceMediaPort;
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  /** Fresh lowercase UUID v4 for each call. */
  readonly createId: () => string;
}

const transcriptEvent = z.object({
  type: z.enum(["input_transcript.added", "output_transcript.added"]),
  item: z.object({ text: z.string() }),
});
const turnEvent = z.object({
  type: z.enum(["turn.created", "turn.done"]),
  turn: z.object({
    id: z.string().optional(),
    role: z.enum(["user", "assistant"]),
    transcript: z.string().optional(),
  }),
});
const audioStat = z.object({
  type: z.enum(["media-source", "inbound-rtp"]),
  kind: z.string().optional(),
  mediaType: z.string().optional(),
  audioLevel: z.number().finite(),
});

function startFailure(reason: string | undefined): VoiceStartFailure {
  switch (reason) {
    case "voice-runner-unsupported":
      return "update-computer";
    case "voice-engine-unsupported":
      return "update-codex";
    case "voice-account-unavailable":
      return "no-account";
    case "voice-refused":
      return "refused";
    default:
      return "connection-failed";
  }
}

/** Codex V3 only receives on oai-events: an unsupported outbound event ends the call. */
export function createCodexVoiceProvider(input: CodexVoiceProviderInput): VoiceProvider {
  const timers = voiceTimers(input);
  return {
    async open({ signal, onEvent }): Promise<VoiceCall> {
      const unavailable = input.media.unavailableReason();
      if (unavailable)
        throw new VoiceStartError(
          unavailable === "insecure-context" ? unavailable : "connection-failed",
        );
      const sessionId = VoiceSessionIdSchema.parse(input.createId());
      const address = {
        environmentId: input.environmentId,
        harnessInstanceId: input.harnessInstanceId,
        sessionId,
      };
      let local: MediaStream | null = null;
      let pc: RTCPeerConnection | null = null;
      let channel: RTCDataChannel | null = null;
      let playback: (() => void) | null = null;
      let renewTimer: VoiceTimer | null = null;
      let levelTimer: VoiceTimer | null = null;
      let ended = false;
      let opened = false;
      let hostMayHoldCall = false;
      let stopPromise: Promise<void> | null = null;
      let rejectClosed!: (error: VoiceStartError) => void;
      const closed = new Promise<never>((_, reject) => {
        rejectClosed = reject;
      });
      void closed.catch(() => {});
      // Microphone permission and native WebRTC promises may settle after cancellation.
      const pending = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, closed]);
      let hearing = "";
      let speaking = "";
      let renewedAt = timers.now();
      let nextTurn = 0;
      const finishedTurns = new Set<string>();
      const stopHost = (): Promise<void> => {
        if (!hostMayHoldCall) return Promise.resolve();
        stopPromise ??= input.rpc["voice.stop"](address).then(
          () => {},
          () => {},
        );
        return stopPromise;
      };
      const finish = (reason: VoiceEndReason): Promise<void> => {
        if (ended) return stopHost();
        ended = true;
        signal.removeEventListener("abort", abort);
        timers.clear(renewTimer);
        timers.clear(levelTimer);
        if (channel) channel.onmessage = null;
        if (pc) {
          pc.ontrack = null;
          pc.onconnectionstatechange = null;
        }
        // One native release failing must not retain the other media resources.
        for (const release of [
          () => channel?.close(),
          () => pc?.close(),
          () => {
            if (local) input.media.releaseStream(local);
          },
          () => playback?.(),
        ]) {
          try {
            release();
          } catch {
            /* Continue releasing the call. */
          }
        }
        rejectClosed(new VoiceStartError("connection-failed"));
        if (opened) onEvent({ type: "closed", reason });
        return stopHost();
      };
      const abort = () => {
        hostMayHoldCall = true;
        void finish("stopped");
      };
      signal.addEventListener("abort", abort, { once: true });
      // Also handle a signal that was already aborted before open.
      if (signal.aborted) abort();
      const receive = (event: MessageEvent) => {
        if (ended) return;
        let value: unknown;
        try {
          value = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const chunk = transcriptEvent.safeParse(value);
        if (chunk.success) {
          if (chunk.data.type === "input_transcript.added") {
            hearing += chunk.data.item.text;
            onEvent({ type: "hearing", text: hearing });
          } else {
            speaking += chunk.data.item.text;
            onEvent({ type: "speaking", text: speaking });
          }
          return;
        }
        const parsed = turnEvent.safeParse(value);
        if (!parsed.success) return;
        const { type, turn } = parsed.data;
        if (type === "turn.created") {
          if (turn.role === "user") hearing = "";
          else {
            speaking = "";
            onEvent({ type: "speaking", text: "" });
          }
          return;
        }
        if (turn.id) {
          if (finishedTurns.has(turn.id)) return;
          finishedTurns.add(turn.id);
        }
        if (turn.role === "user") {
          onEvent({
            type: "heard",
            turnId: `turn:${++nextTurn}`,
            text: turn.transcript ?? hearing,
          });
          hearing = "";
        } else {
          if (turn.transcript) onEvent({ type: "speaking", text: turn.transcript });
          onEvent({ type: "spoke" });
          speaking = "";
        }
      };
      const renew = async () => {
        try {
          const result = await input.rpc["voice.renew"](address);
          if (ended) return;
          if (!result.ok) {
            await finish(
              result.error.reason === "voice-ended"
                ? timers.now() - renewedAt >= voiceLeaseMs
                  ? "expired"
                  : "replaced"
                : "refused",
            );
            return;
          }
          renewedAt = timers.now();
        } catch {
          // A missed renewal has an unknown outcome; the Runner's lease is the backstop.
        }
        if (!ended)
          renewTimer = timers.set(() => {
            void renew();
          }, voiceRenewIntervalMs);
      };
      const levels = async () => {
        if (ended || !pc) return;
        try {
          const stats = await pc.getStats();
          if (ended) return;
          let mic = 0;
          let output = 0;
          stats.forEach((value: unknown) => {
            const stat = audioStat.safeParse(value);
            if (!stat.success || (stat.data.kind ?? stat.data.mediaType ?? "audio") !== "audio")
              return;
            const level = Math.max(0, Math.min(1, stat.data.audioLevel));
            if (stat.data.type === "media-source") mic = Math.max(mic, level);
            else output = Math.max(output, level);
          });
          onEvent({ type: "level", input: mic, output });
        } catch {
          /* Metering cannot end a healthy call. */
        }
        if (!ended)
          levelTimer = timers.set(() => {
            void levels();
          }, 100);
      };
      try {
        if (ended) throw new VoiceStartError("connection-failed");
        const microphone = input.media.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        void microphone.then(
          (stream) => {
            if (ended) input.media.releaseStream(stream);
          },
          () => {},
        );
        try {
          local = await pending(microphone);
        } catch (error) {
          const name = error instanceof Error ? error.name : "";
          throw new VoiceStartError(
            name === "NotAllowedError"
              ? "permission-denied"
              : name === "NotFoundError" || name === "NotReadableError"
                ? "microphone-unavailable"
                : "connection-failed",
          );
        }
        if (ended) {
          input.media.releaseStream(local);
          throw new VoiceStartError("connection-failed");
        }
        pc = input.media.createPeerConnection();
        const track = local.getAudioTracks()[0];
        if (!track) throw new VoiceStartError("microphone-unavailable");
        pc.addTransceiver(track, { direction: "sendrecv", streams: [local] });
        channel = pc.createDataChannel("oai-events", { ordered: true });
        channel.onmessage = receive;
        pc.ontrack = (event) => {
          if (ended || !event.streams[0]) return;
          try {
            playback?.();
            playback = input.media.playRemote(event.streams[0]);
          } catch {
            void finish("failed");
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc?.connectionState === "failed" || pc?.connectionState === "closed")
            void finish("connection-lost");
        };
        const offer = await pending(pc.createOffer());
        await pending(pc.setLocalDescription(offer));
        await pending(
          new Promise<void>((resolve) => {
            const peer = pc!;
            const done = () => {
              peer.removeEventListener("icegatheringstatechange", changed);
              signal.removeEventListener("abort", done);
              timers.clear(timer);
              resolve();
            };
            const changed = () => {
              if (peer.iceGatheringState === "complete") done();
            };
            const timer = timers.set(done, 3_000);
            peer.addEventListener("icegatheringstatechange", changed);
            signal.addEventListener("abort", done, { once: true });
            if (peer.iceGatheringState === "complete" || ended) done();
            void closed.catch(done);
          }),
        );
        if (ended) throw new VoiceStartError("connection-failed");
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new VoiceStartError("connection-failed");
        hostMayHoldCall = true;
        const starting = input.rpc["voice.start"]({ ...address, offer: sdp }, { signal });
        // Stop once more after a late admission, in case the first stop overtook start.
        const stopLateStart = () => {
          if (ended) void input.rpc["voice.stop"](address).catch(() => {});
        };
        void starting.then(stopLateStart, stopLateStart);
        const result = await pending(starting);
        if (!result.ok) throw new VoiceStartError(startFailure(result.error.reason));
        await pending(pc.setRemoteDescription({ type: "answer", sdp: result.data.answer }));
        if (ended) throw new VoiceStartError("connection-failed");
        renewedAt = timers.now();
        opened = true;
        renewTimer = timers.set(() => {
          void renew();
        }, voiceRenewIntervalMs);
        levelTimer = timers.set(() => {
          void levels();
        }, 100);
        return {
          async say(text) {
            if (ended) throw new VoiceStartError("connection-failed");
            const result = await input.rpc["voice.say"]({ ...address, text });
            if (!result.ok) {
              void finish(result.error.reason === "voice-ended" ? "replaced" : "refused");
              throw new VoiceStartError(startFailure(result.error.reason));
            }
          },
          setMuted(muted) {
            if (!ended)
              local?.getAudioTracks().forEach((track) => {
                track.enabled = !muted;
              });
          },
          close: () => finish("stopped"),
        };
      } catch (error) {
        void finish("failed");
        throw error instanceof VoiceStartError ? error : new VoiceStartError("connection-failed");
      }
    },
  };
}
