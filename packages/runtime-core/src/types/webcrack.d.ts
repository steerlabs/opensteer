declare module "webcrack" {
  export function webcrack(
    input: string,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly code: string;
  }>;
}
