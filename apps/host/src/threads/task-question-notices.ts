import type { PersonalCommitReaction } from "@opensteer/database/personal-mutation";
import { OpensteerError, type RequestId, type ThreadId } from "@opensteer/core";
import {
  cancelSettledTaskQuestionNotice,
  deliverTaskQuestionNotice,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Kysely } from "kysely";
interface TaskQuestionNoticeOptions {
  readonly database: Kysely<DatabaseSchema>;
  readonly wake: () => void;
  readonly onError: (error: unknown) => void;
}
interface QuestionWait {
  readonly parentThreadId: ThreadId;
  readonly threadId: ThreadId;
  readonly result: Promise<string | undefined>;
  readonly finish: (requestId?: string) => void;
}
export class TaskQuestionNotices {
  readonly #waiting = new Set<QuestionWait>();
  readonly #pending = new Map<RequestId, Promise<void>>();
  readonly #options: TaskQuestionNoticeOptions;
  #closed = false;
  constructor(options: TaskQuestionNoticeOptions) {
    this.#options = options;
  }
  wait(parentThreadId: ThreadId, threadId: ThreadId): (requestId?: string) => void {
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    const entry = {
      parentThreadId,
      threadId,
      result: promise,
      finish: resolve,
    };
    this.#waiting.add(entry);
    return (requestId) => {
      this.#waiting.delete(entry);
      resolve(requestId);
    };
  }
  requestChanged(change: Extract<PersonalCommitReaction, { type: "requestChanged" }>): void {
    if (this.#closed || change.kind !== "harness.input") return;
    const waiting = [...this.#waiting].filter(({ threadId }) => threadId === change.threadId);
    this.#enqueue(change.requestId, waiting);
  }
  #enqueue(requestId: RequestId, observedWaits: readonly QuestionWait[] = []): void {
    const previous = this.#pending.get(requestId) ?? Promise.resolve();
    const pending = previous
      .then(async () => {
        const delivered = await Promise.all(
          observedWaits.map(async (entry) => ({
            parentThreadId: entry.parentThreadId,
            requestId: await entry.result,
          })),
        );
        if (this.#closed && observedWaits.some((entry) => this.#waiting.has(entry))) return;
        await deliverTaskQuestionNotice(this.#options.database, requestId, (parentThreadId) =>
          delivered.some(
            (entry) => entry.parentThreadId === parentThreadId && entry.requestId === requestId,
          ),
        );
        await cancelSettledTaskQuestionNotice(this.#options.database, requestId);
        this.#options.wake();
      })
      .catch((error: unknown) => {
        if (!(
          error instanceof OpensteerError &&
          (error.code === "conflict" || error.code === "forbidden")
        ))
          this.#options.onError(error);
      })
      .finally(() => {
        if (this.#pending.get(requestId) === pending) this.#pending.delete(requestId);
      });
    this.#pending.set(requestId, pending);
  }
  async reconcile(): Promise<void> {
    const rows = await this.#options.database
      .selectFrom("requests")
      .leftJoin("taskQuestionNotices", "taskQuestionNotices.requestId", "requests.id")
      .leftJoin("threadInputs", "threadInputs.messageId", "taskQuestionNotices.messageId")
      .select("requests.id")
      .where("requests.kind", "=", "harness.input")
      .where((expression) =>
        expression.or([
          expression.and([
            expression("requests.status", "=", "pending"),
            expression("taskQuestionNotices.requestId", "is", null),
          ]),
          expression.and([
            expression("requests.status", "!=", "pending"),
            expression("threadInputs.state", "=", "pending"),
          ]),
        ]),
      )
      .execute();
    for (const row of rows) this.#enqueue(row.id);
    await Promise.all(this.#pending.values());
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#waiting) entry.finish();
    await Promise.all(this.#pending.values());
    this.#waiting.clear();
  }
}
