export const shellSocketCloseWaitMs = 1_000;

export function shellSentence(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return `${fallback}.`;
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}
