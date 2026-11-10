import {
  RunnerAuxiliaryChallengeSchema,
  type RunnerAuxiliaryModule,
  type RunnerBootId,
} from "@opensteer/protocol";
import { createRunnerAuxiliarySignature } from "@opensteer/runner-auth";
import type { KeyObject } from "node:crypto";
import type { RunnerId } from "@opensteer/core";

export interface RunnerAuxiliaryHandshakeInput {
  readonly bootId: RunnerBootId;
  readonly module: RunnerAuxiliaryModule;
  readonly privateKey: KeyObject;
  readonly runnerId: RunnerId;
  /** The one-use credential the primary connection asked the Host for. */
  readonly ticket: string;
}

/**
 * Answers the Host's challenge on a freshly opened auxiliary socket.
 *
 * The ticket alone would be a bearer credential, so this signs the challenge
 * together with the ticket's digest using the Runner's own key. Whoever
 * intercepted the ticket still cannot open the stream.
 */
export function answerAuxiliaryChallenge(
  input: RunnerAuxiliaryHandshakeInput,
  challenge: unknown,
): {
  readonly bootId: RunnerBootId;
  readonly challengeId: string;
  readonly module: RunnerAuxiliaryModule;
  readonly runnerId: RunnerId;
  readonly signature: string;
  readonly ticket: string;
  readonly type: "runner.auxiliary.authenticate";
} {
  const parsed = RunnerAuxiliaryChallengeSchema.parse(challenge);
  if (parsed.module !== input.module) {
    throw new Error("The Host challenged a different Runner module");
  }
  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    throw new Error("The Host auxiliary challenge is expired");
  }
  return {
    bootId: input.bootId,
    challengeId: parsed.challengeId,
    module: input.module,
    runnerId: input.runnerId,
    signature: createRunnerAuxiliarySignature(input.privateKey, {
      bootId: input.bootId,
      challenge: parsed,
      module: input.module,
      runnerId: input.runnerId,
      ticket: input.ticket,
    }),
    ticket: input.ticket,
    type: "runner.auxiliary.authenticate",
  };
}

import { RunnerAuxiliaryFenceLedger as PortableFenceLedger } from "./auxiliary-fence.js";
export class RunnerAuxiliaryFenceLedger extends PortableFenceLedger {
  constructor(options: { readonly now?: () => number } = {}) {
    super({
      ...options,
      clock: {
        now: options.now ?? Date.now,
        schedule: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref();
          return () => clearTimeout(timer);
        },
      },
    });
  }
}
