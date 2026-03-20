export interface TypingCadenceSample {
  readonly character: string;
  readonly delayMs: number;
}

export function generateTypingCadence(input: {
  readonly text: string;
  readonly baseDelayMs?: number;
  readonly jitterMs?: number;
  readonly hesitationProbability?: number;
}): readonly TypingCadenceSample[] {
  const baseDelayMs = input.baseDelayMs ?? 75;
  const jitterMs = input.jitterMs ?? 35;
  const hesitationProbability = input.hesitationProbability ?? 0.08;

  return [...input.text].map((character, index) => {
    const previous = input.text[index - 1];
    const punctuationPause = /[.,!?;:]/.test(previous ?? "") ? 90 : 0;
    const whitespacePause = /\s/.test(character) ? 30 : 0;
    const hesitation = Math.random() < hesitationProbability ? 120 + Math.random() * 180 : 0;
    const jitter = (Math.random() * 2 - 1) * jitterMs;
    return {
      character,
      delayMs: Math.max(10, Math.round(baseDelayMs + punctuationPause + whitespacePause + hesitation + jitter)),
    };
  });
}
