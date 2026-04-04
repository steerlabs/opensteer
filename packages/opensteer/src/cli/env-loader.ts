import { loadEnvironment } from "../env.js";

export async function loadCliEnvironment(cwd: string): Promise<void> {
  loadEnvironment(cwd);
}
