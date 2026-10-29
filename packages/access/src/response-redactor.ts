export interface CredentialResponseRedactor {
  readonly maxPatternBytes: number;
  redactBuffer(value: Buffer): Buffer;
  redactText(value: string): string;
}

export function createCredentialResponseRedactor(
  secrets: readonly string[],
): CredentialResponseRedactor {
  return secrets.length === 0
    ? noOpCredentialResponseRedactor
    : new ExactCredentialRedactor(secrets);
}

export const noOpCredentialResponseRedactor: CredentialResponseRedactor = Object.freeze({
  maxPatternBytes: 0,
  redactBuffer: (value: Buffer) => value,
  redactText: (value: string) => value,
});

class ExactCredentialRedactor implements CredentialResponseRedactor {
  readonly maxPatternBytes: number;
  readonly #patterns: readonly Buffer[];

  constructor(secrets: readonly string[]) {
    const patterns = new Map<string, Buffer>();
    for (const secret of secrets) {
      for (const variant of credentialRepresentations(secret)) {
        const pattern = Buffer.from(variant, "utf8");
        if (pattern.byteLength > 0) patterns.set(pattern.toString("base64"), pattern);
      }
    }
    this.#patterns = [...patterns.values()].sort(
      (left, right) => right.byteLength - left.byteLength,
    );
    this.maxPatternBytes = this.#patterns[0]?.byteLength ?? 0;
  }

  redactBuffer(value: Buffer): Buffer {
    let output: Buffer | undefined;
    for (const pattern of this.#patterns) {
      const input = output ?? value;
      let index = input.indexOf(pattern);
      while (index >= 0) {
        if (!output) output = Buffer.from(value);
        output.fill(0x2a, index, index + pattern.byteLength);
        index = output.indexOf(pattern, index + pattern.byteLength);
      }
    }
    return output ?? value;
  }

  redactText(value: string): string {
    return this.redactBuffer(Buffer.from(value, "utf8")).toString("utf8");
  }
}

function credentialRepresentations(secret: string): readonly string[] {
  const encodedForm = new URLSearchParams([["value", secret]]).toString().slice("value=".length);
  const json = JSON.stringify(secret);
  return [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(secret).toLowerCase(),
    encodedForm,
    encodedForm.toLowerCase(),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
    json.slice(1, -1),
  ];
}
