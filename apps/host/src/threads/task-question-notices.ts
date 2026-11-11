import {
  OpensteerError,
  RequestIdSchema,
  type AgentEvent,
  type RequestId,
  type ThreadId,
} from "@opensteer/core";
import {
  cancelSettledTaskQuestionNotice,
  deliverTaskQuestionNotice,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Kysely } from "kysely";

interface TaskQuestionNoticeOptions {
  readonly database: Kysely<DatabaseSchema>;
  readonly publish: (event: AgentEvent) => void;
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
    const entry = { parentThreadId, threadId, result: promise, finish: resolve };
    this.#waiting.add(entry);
    return (requestId) => {
      this.#waiting.delete(entry);
      resolve(requestId);
    };
  }

  observe(event: AgentEvent): void {
    if (this.#closed || !event.type.startsWith("request.")) return;
    const id =
      "request" in event.data
        ? event.data.request.id
        : "requestId" in event.data
          ? event.data.requestId
          : undefined;
    const parsed = RequestIdSchema.safeParse(id);
    if (!parsed.success) return;
    const waiting = [...this.#waiting].filter(({ threadId }) => threadId === event.threadId);
    this.#enqueue(parsed.data, waiting);
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
        const events = await deliverTaskQuestionNotice(
          this.#options.database,
          requestId,
          (parentThreadId) =>
            delivered.some(
              (entry) => entry.parentThreadId === parentThreadId && entry.requestId === requestId,
            ),
        );
        for (const event of events) this.#options.publish(event);
        for (const event of await cancelSettledTaskQuestionNotice(
          this.#options.database,
          requestId,
        ))
          this.#options.publish(event);
        if (events.length) this.#options.wake();
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
