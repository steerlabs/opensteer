import { randomUUID } from "node:crypto";
import type { AgentEvent, ResolvedBackgroundCandidate, ThreadId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { BackgroundTextAttemptIdSchema } from "@opensteer/protocol";
import { parseGeneratedThreadName, threadTitlePrompt } from "@opensteer/harness";
import { resolveBackgroundSelection } from "./background-models.js";
import { readBackgroundResolutionInput } from "./background-model-settings.js";
import {
  harnessInspectionDefinition,
  inspectAndRecordInvalidatedHarnessCatalog,
} from "./harness-catalogs.js";

/** Three ranked attempts, followed by the task model if it was not already tried. */
export function namingCandidates(
  candidates: readonly ResolvedBackgroundCandidate[],
  fallback: ResolvedBackgroundCandidate | undefined,
) {
  const key = (candidate: ResolvedBackgroundCandidate) =>
    JSON.stringify([
      candidate.environmentId,
      candidate.harnessInstanceId,
      candidate.modelSelection.providerId,
      candidate.modelSelection.modelId,
      Object.entries(candidate.modelSelection.options).sort(),
    ]);
  const ranked = candidates.filter((candidate) => candidate.reason !== "task-model").slice(0, 3);
  if (fallback && !ranked.some((candidate) => key(candidate) === key(fallback)))
    ranked.push(fallback);
  return ranked;
}

interface ThreadNamingDependencies {
  store: OpensteerStore;
  runners: RunnerRegistry;
  publish: (event: AgentEvent) => void;
  onError: (error: unknown) => void;
}

/** Ephemeral jobs: no result survives its authenticated connection or Host boot. */
export class ThreadNaming {
  readonly #pending = new Map<ThreadId, Promise<void>>();
  readonly #active = new Map<string, Set<Promise<unknown>>>();
  readonly #shutdown = new AbortController();
  readonly dependencies: ThreadNamingDependencies;
  constructor(dependencies: ThreadNamingDependencies) {
    this.dependencies = dependencies;
  }

  request(threadId: ThreadId): Promise<void> {
    const existing = this.#pending.get(threadId);
    if (existing) return existing;
    if (this.#shutdown.signal.aborted) return Promise.resolve();
    const job = this.#withCapacity("naming", 4, () => this.#name(threadId))
      .catch(this.dependencies.onError)
      .finally(() => this.#pending.delete(threadId));
    this.#pending.set(threadId, job);
    return job;
  }

  async reconcile(): Promise<void> {
    let after: ThreadId | undefined;
    while (!this.#shutdown.signal.aborted) {
      const rows = await this.dependencies.store.listThreadNamingCandidates(100, after);
      for (let index = 0; index < rows.length && !this.#shutdown.signal.aborted; index += 4)
        await Promise.all(rows.slice(index, index + 4).map((row) => this.request(row.id)));
      if (rows.length < 100) return;
      after = rows.at(-1)!.id;
    }
  }

  async #withCapacity<T>(
    key: string,
    limit: number,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    const active = this.#active.get(key) ?? new Set<Promise<unknown>>();
    this.#active.set(key, active);
    while (active.size >= limit) await Promise.race(active).catch(() => undefined);
    if (this.#shutdown.signal.aborted) return undefined;
    const job = operation();
    active.add(job);
    try {
      return await job;
    } finally {
      active.delete(job);
    }
  }

  async stop(): Promise<void> {
    this.#shutdown.abort();
    await Promise.all(this.#pending.values());
  }

  async #name(threadId: ThreadId) {
    const { store, runners, publish } = this.dependencies;
    const input = await store.getThreadNamingInput(threadId);
    if (!input) return;
    const snapshot = await readBackgroundResolutionInput({ store, runners }, input.requestedBy);
    const account = snapshot.accounts.find(
      (account) =>
        account.environmentId === input.environmentId &&
        account.harnessInstanceId === input.harnessInstanceId,
    );
    const taskModelFallback: ResolvedBackgroundCandidate | undefined = account
      ? {
          environmentId: input.environmentId,
          harnessInstanceId: input.harnessInstanceId,
          harnessRevision: account.harnessRevision,
          modelSelection: input.modelSelection,
          reason: "task-model",
        }
      : undefined;
    const { candidates: resolved, taskModelFallback: fallback } = resolveBackgroundSelection(
      "light",
      {
        ...snapshot,
        ownProviderId: input.modelSelection.providerId,
        originatingEnvironmentId: input.environmentId,
        ...(taskModelFallback ? { taskModelFallback } : {}),
      },
    );
    let deadline: number | undefined;
    for (const candidate of namingCandidates(resolved, fallback)) {
      if ((deadline !== undefined && Date.now() >= deadline) || this.#shutdown.signal.aborted)
        return;
      const completed = await this.#withCapacity(candidate.environmentId, 2, async () => {
        deadline ??= Date.now() + 120_000;
        if (Date.now() >= deadline) return;
        const identity = runners.identityForEnvironment(candidate.environmentId);
        if (!identity) return false;
        const current = await store.getThreadNamingInput(threadId);
        if (
          !current ||
          current.sourceMessageId !== input.sourceMessageId ||
          current.principalId !== input.principalId
        )
          return;
        const harness = await store.getHarnessInstance(candidate.harnessInstanceId);
        if (
          !harness?.enabled ||
          harness.removedAt ||
          harness.runtimeRevision !== candidate.harnessRevision ||
          !(await store.environmentIsAvailableToUser(candidate.environmentId, input.requestedBy))
        )
          return false;
        const attemptExpiresAt = Math.min(deadline, Date.now() + 60_000);
        let result;
        try {
          result = await runners.backgroundText(
            {
              type: "host.background-text",
              attemptId: BackgroundTextAttemptIdSchema.parse(randomUUID()),
              environmentId: candidate.environmentId,
              harnessInstanceId: candidate.harnessInstanceId,
              harnessRevision: candidate.harnessRevision,
              modelSelection: candidate.modelSelection,
              prompt: threadTitlePrompt(input.request, { icon: input.icon }),
              deadline: new Date(attemptExpiresAt).toISOString(),
            },
            this.#shutdown.signal,
          );
        } catch (error) {
          if (this.#shutdown.signal.aborted) return;
          this.dependencies.onError(error);
          return false;
        }
        if (!result.ok) {
          if (result.failure === "capacity") return true;
          if (["signed-out", "unavailable", "refused", "usage-limit"].includes(result.failure)) {
            await inspectAndRecordInvalidatedHarnessCatalog({
              catalogs: store,
              environmentId: candidate.environmentId,
              harnesses: [harnessInspectionDefinition(harness)],
              runners,
              signal: AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(30_000)]),
            }).catch(this.dependencies.onError);
          }
          return false;
        }
        if (
          Date.now() >= deadline ||
          runners.identityForEnvironment(candidate.environmentId) !== identity
        )
          return;
        const name = parseGeneratedThreadName(result.text, { icon: input.icon });
        const applied = await store.applyGeneratedThreadName({
          threadId,
          ...(name.title ? { title: name.title } : {}),
          ...(name.icon ? { icon: name.icon } : {}),
          namingAuthority: { ...input, ...candidate, expiresAt: attemptExpiresAt },
        });
        for (const event of applied?.events ?? []) publish(event);
        return true;
      });
      if (completed !== false) return;
    }
  }
}
