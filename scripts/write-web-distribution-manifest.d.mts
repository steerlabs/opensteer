export function writeWebDistributionManifest(input: {
  readonly buildId: string;
  readonly directory: string;
  readonly hostVersion: string;
}): Promise<void>;
