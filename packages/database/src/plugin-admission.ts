import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";

const queues = new WeakMap<object, KeyedMutationQueue>();
export function withTaskPluginAdmission<T>(
  database: object,
  thread: string,
  work: () => Promise<T>,
): Promise<T> {
  let queue = queues.get(database);
  if (!queue) {
    queue = new KeyedMutationQueue();
    queues.set(database, queue);
  }
  return queue.run(thread, work);
}
export async function acquireTaskPluginAdmission(
  database: object,
  thread: string,
): Promise<() => void> {
  const acquired = Promise.withResolvers<() => void>();
  void withTaskPluginAdmission(
    database,
    thread,
    () => new Promise<void>((release) => acquired.resolve(release)),
  );
  return acquired.promise;
}

export const pluginAdmissionKey = (owner: string, plugin: string) =>
  JSON.stringify(["plugin", owner, plugin]);
