import { freePort } from "@opensteer/shared/test-support/loopbackPort";

/** Claims distinct ports within the fixed app range, independently of the OS ephemeral range. */
export async function freeAppPorts(count: number): Promise<number[]> {
  return Promise.all(Array.from({ length: count }, () => freePort([49_152, 65_535])));
}

export async function freeAppPort(): Promise<number> {
  return freePort([49_152, 65_535]);
}
