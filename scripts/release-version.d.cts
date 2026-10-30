export function deriveReleaseVersion(input: { repositoryRoot: string; revision: string }): string;
export function verifyReleaseWorkspace(root: string, sha: string): void;
export function stampReleaseVersion(root: string, sha: string, expected?: string): string;
