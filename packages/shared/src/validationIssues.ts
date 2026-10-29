/** One schema issue as a validator reports it: where in the value, and what is wrong there. */
interface ValidationIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

/**
 * Rejected input described so its sender can fix it: each issue names the field
 * it concerns, as `credential.description: Too big…`. Bounded to three issues
 * so a rejected payload cannot dictate the message length.
 */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .slice(0, 3)
    .map(({ message, path }) =>
      path.length > 0 ? `${path.map(String).join(".")}: ${message}` : message,
    )
    .join("; ");
}
