import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  EnvironmentId,
  ResolvedBackgroundCandidate,
  ThreadId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  BackgroundTextAttemptIdSchema,
  backgroundTextAttemptsPerRunner,
  type BackgroundTextFailure,
} from "@opensteer/protocol";
import { parseGeneratedThreadName, threadTitlePrompt } from "@opensteer/harness";
import { backgroundCandidateKey, resolveBackgroundCandidates } from "./background-models.js";
import { readBackgroundResolutionInput } from "./background-model-settings.js";
import {
  harnessInspectionDefinition,
  inspectAndRecordInvalidatedHarnessCatalog,
} from "./harness-catalogs.js";

/** Three ranked attempts, followed by the task model if it was not already tried. */
export function namingCandidates(resolved: readonly ResolvedBackgroundCandidate[]) {
  const ranked = resolved.filter((candidate) => candidate.reason !== "task-model").slice(0, 3);
  const fallback = resolved.find((candidate) => candidate.reason === "task-model");
  const key = fallback && backgroundCandidateKey(fallback);
  if (fallback && !ranked.some((candidate) => backgroundCandidateKey(candidate) === key))
    ranked.push(fallback);
  return ranked;
}

/** Failures that suggest the stored catalog is stale, so it is refreshed before the next job. */
const staleCatalogFailures: ReadonlySet<BackgroundTextFailure> = new Set([
  "signed-out",
  "unavailable",
  "refused",
  "usage-limit",
]);

/** Why one candidate gave no name: the Runner's typed failure, or why none was sent or came back. */
type AttemptFailure = BackgroundTextFailure | "offline" | "account-changed" | "no-result";

interface ThreadNamingDependencies {
  store: OpensteerStore;
  runners: RunnerRegistry;
  publish: (event: AgentEvent) => void;
  onError: (error: unknown) => void;
}

/** Ephemeral jobs: no result survives its authenticated connection or Host boot. */
export class ThreadNaming {
  readonly #pending = new Map<ThreadId, Promise<void>>();
  readonly #inFlight = new Map<EnvironmentId, Set<Promise<unknown>>>();
  readonly #shutdown = new AbortController();
  readonly dependencies: ThreadNamingDependencies;
  constructor(dependencies: ThreadNamingDependencies) {
    this.dependencies = dependencies;
  }

  request(threadId: ThreadId): Promise<void> {
    const existing = this.#pending.get(threadId);
    if (existing) return existing;
    if (this.#shutdown.signal.aborted) return Promise.resolve();
    const job = this.#name(threadId)
      .catch(this.dependencies.onError)
      .finally(() => this.#pending.delete(threadId));
    this.#pending.set(threadId, job);
    return job;
  }

  async reconcile(): Promise<void> {
    let after: ThreadId | undefined;
    while (!this.#shutdown.signal.aborted) {
      const rows = await this.dependencies.store.listThreadNamingCandidates(100, after);
      // Bound the Host's own reads; each Runner's slots bound provider work.
      for (let index = 0; index < rows.length && !this.#shutdown.signal.aborted; index += 4)
        await Promise.all(rows.slice(index, index + 4).map((row) => this.request(row.id)));
      if (rows.length < 100) return;
      after = rows.at(-1)!.id;
    }
  }

  async stop(): Promise<void> {
    this.#shutdown.abort();
    await Promise.all(this.#pending.values());
  }

  /**
   * Sends no more attempts to one Runner than it runs at once, so an attempt's
   * deadline starts when it is sent, never while it queues behind others.
   */
  async #whenRunnerFree<T>(environmentId: EnvironmentId, attempt: () => Promise<T>): Promise<T> {
    let active = this.#inFlight.get(environmentId);
    if (!active) this.#inFlight.set(environmentId, (active = new Set()));
    while (active.size >= backgroundTextAttemptsPerRunner)
      await Promise.race(active).catch(() => undefined);
    const running = attempt();
    active.add(running);
    try {
      return await running;
    } finally {
      active.delete(running);
    }
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
    const candidates = namingCandidates(
      resolveBackgroundCandidates("light", {
        ...snapshot,
        ownProviderId: input.modelSelection.providerId,
        originatingEnvironmentId: input.environmentId,
        ...(account
          ? {
              taskModelFallback: {
                environmentId: input.environmentId,
                harnessInstanceId: input.harnessInstanceId,
                harnessRevision: account.harnessRevision,
                modelSelection: input.modelSelection,
                reason: "task-model",
              },
            }
          : {}),
      }),
    );
    const failures: AttemptFailure[] = [];
    // Content-free: the prompt, a title and credentials never reach this line.
    const unnamed = () =>
      console.warn("Thread naming found no name", {
        threadId,
        candidates: candidates.length,
        failures,
      });
    if (candidates.length === 0) return unnamed();
    // The job's deadline starts with its first attempt, not while it waits for a Runner.
    let deadline: number | undefined;
    for (const candidate of candidates) {
      if (this.#shutdown.signal.aborted) return;
      if (deadline !== undefined && Date.now() >= deadline) break;
      const identity = runners.identityForEnvironment(candidate.environmentId);
      if (!identity) {
        failures.push("offline");
        continue;
      }
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
      ) {
        failures.push("account-changed");
        continue;
      }
      const attempt = await this.#whenRunnerFree(candidate.environmentId, async () => {
        deadline ??= Date.now() + 120_000;
        const expiresAt = Math.min(deadline, Date.now() + 60_000);
        const result = await runners
          .backgroundText(
            {
              type: "host.background-text",
              attemptId: BackgroundTextAttemptIdSchema.parse(randomUUID()),
              environmentId: candidate.environmentId,
              harnessInstanceId: candidate.harnessInstanceId,
              harnessRevision: candidate.harnessRevision,
              modelSelection: candidate.modelSelection,
              prompt: threadTitlePrompt(input.request, { icon: input.icon }),
              deadline: new Date(expiresAt).toISOString(),
            },
            this.#shutdown.signal,
          )
          // A dropped connection or a Host-side deadline: the next candidate goes on.
          .catch(() => undefined);
        return { result, expiresAt };
      });
      if (this.#shutdown.signal.aborted) return;
      const { result, expiresAt } = attempt;
      if (!result?.ok) {
        failures.push(result?.failure ?? "no-result");
        // Catalog ownership remains here; generation never performs discovery.
        if (result && staleCatalogFailures.has(result.failure))
          await inspectAndRecordInvalidatedHarnessCatalog({
            catalogs: store,
            environmentId: candidate.environmentId,
            harnesses: [harnessInspectionDefinition(harness)],
            runners,
            signal: AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(30_000)]),
          }).catch(this.dependencies.onError);
        continue;
      }
      if (
        Date.now() >= expiresAt ||
        runners.identityForEnvironment(candidate.environmentId) !== identity
      )
        return;
      const name = parseGeneratedThreadName(result.text, { icon: input.icon });
      const applied = await store.applyGeneratedThreadName({
        threadId,
        ...(name.title ? { title: name.title } : {}),
        ...(name.icon ? { icon: name.icon } : {}),
        namingAuthority: { ...input, ...candidate, expiresAt },
      });
      for (const event of applied?.events ?? []) publish(event);
      return;
    }
    unnamed();
  }
}
