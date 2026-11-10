export function isEveryoneMember(user: {
  readonly memberKind: string;
  readonly memberState: string;
  readonly admittedAt: Date | null;
}): boolean {
  return user.memberKind === "full" && user.memberState === "active" && user.admittedAt !== null;
}
