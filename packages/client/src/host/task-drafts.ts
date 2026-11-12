import {
  DeploymentIdSchema,
  TaskFolderSchema,
  ThreadIdSchema,
  UserIdSchema,
  type TaskFolder,
} from "@opensteer/core";
import { z } from "zod";

export interface TaskDraftScope {
  readonly deploymentId: string;
  readonly userId: string;
}
export type TaskDraftTarget = { readonly threadId: string } | { readonly folder: TaskFolder };
const DraftsSchema = z
  .record(z.string(), z.string().max(16_384))
  .refine((rows) => Object.keys(rows).length <= 100);
export interface TaskDraftPort {
  load(scope: TaskDraftScope): Promise<unknown>;
  save(scope: TaskDraftScope, drafts: Readonly<Record<string, string>>): Promise<void>;
  remove(scope: TaskDraftScope): Promise<void>;
}
export function taskDraftScopeKey(scope: TaskDraftScope): string {
  return JSON.stringify([
    DeploymentIdSchema.parse(scope.deploymentId),
    UserIdSchema.parse(scope.userId),
  ]);
}
export function taskDraftKey(target: TaskDraftTarget): string {
  return "threadId" in target
    ? JSON.stringify(["task", ThreadIdSchema.parse(target.threadId)])
    : JSON.stringify(["new", TaskFolderSchema.parse(target.folder)]);
}
export class TaskDrafts {
  readonly #scope: TaskDraftScope;
  readonly #port: TaskDraftPort;
  readonly #listeners = new Set<() => void>();
  #drafts: Readonly<Record<string, string>> = {};
  #edited = new Set<string>();
  #generation = 0;
  #removed = false;
  #write = Promise.resolve();
  constructor(scope: TaskDraftScope, port: TaskDraftPort) {
    taskDraftScopeKey(scope);
    this.#scope = scope;
    this.#port = port;
  }
  readonly getSnapshot = () => this.#drafts;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #update(drafts: Readonly<Record<string, string>>): void {
    this.#drafts = drafts;
    for (const listener of this.#listeners) listener();
  }
  async load(): Promise<void> {
    const generation = ++this.#generation;
    const raw = await this.#port.load(this.#scope);
    if (generation !== this.#generation || this.#removed) return;
    const saved = DraftsSchema.parse(raw ?? {});
    const merged = { ...saved };
    for (const key of this.#edited) {
      const value = this.#drafts[key];
      if (value) merged[key] = value;
      else delete merged[key];
    }
    this.#update(merged);
  }
  async set(target: TaskDraftTarget, text: string): Promise<void> {
    if (this.#removed) return;
    const key = taskDraftKey(target),
      next = { ...this.#drafts };
    if (text) next[key] = text;
    else delete next[key];
    DraftsSchema.parse(next);
    this.#edited.add(key);
    this.#update(next);
    this.#write = this.#write
      .catch(() => undefined)
      .then(() => (this.#removed ? undefined : this.#port.save(this.#scope, next)));
    await this.#write;
  }
  async remove(): Promise<void> {
    this.#removed = true;
    this.#generation++;
    this.#update({});
    this.#edited.clear();
    await this.#write.catch(() => undefined);
    await this.#port.remove(this.#scope);
  }
}
