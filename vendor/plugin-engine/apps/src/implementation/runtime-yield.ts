/**
 * Let the runtime run its own tasks between long synchronous steps. In a Worker, a large OpenAPI
 * compilation that never yields leaves the garbage collector only long, full pauses; yielding
 * between steps measurably shortens it. A timer is used because a resolved promise would continue
 * without leaving the current task.
 */
export const yieldToRuntime = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
