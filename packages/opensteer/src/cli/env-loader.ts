import { loadOpensteerEnvironment } from "../env.js";

export async function loadCliEnvironment(cwd: string): Promise<void> {
  loadOpensteerEnvironment(cwd);
}
