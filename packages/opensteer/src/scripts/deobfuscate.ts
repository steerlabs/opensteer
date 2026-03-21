import { webcrack } from "webcrack";

export async function deobfuscateScriptContent(input: { readonly content: string }): Promise<{
  readonly content: string;
  readonly transforms: readonly string[];
}> {
  const result = await webcrack(input.content, {
    unpack: false,
    deobfuscate: true,
    unminify: true,
    jsx: true,
    mangle: false,
  });
  const content = result.code;
  return {
    content,
    transforms: inferTransforms(input.content, content),
  };
}

function inferTransforms(original: string, deobfuscated: string): readonly string[] {
  if (original === deobfuscated) {
    return [];
  }

  const inferred = new Set<string>();

  if (
    /\b_0x[a-f0-9]+\b/i.test(original) ||
    /stringArray/i.test(original) ||
    /\[\s*['"`][^'"`]+['"`]\s*(?:,\s*['"`][^'"`]+['"`]\s*)+\]/.test(original)
  ) {
    inferred.add("string-array");
  }
  if (/\bwhile\s*\([^)]*\)\s*\{\s*switch\b/s.test(original)) {
    inferred.add("control-flow");
  }
  if (/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i.test(original)) {
    inferred.add("hex-decoding");
  }
  if (/\bif\s*\(\s*(?:false|0)\s*\)/.test(original)) {
    inferred.add("dead-code");
  }
  if (/console\[['"](?:log|warn|error|debug|info)['"]\]/.test(original)) {
    inferred.add("disable-console-output");
  }
  if (/selfDefending|debugProtection|domainLock/i.test(original)) {
    inferred.add("runtime-guards");
  }

  return [...inferred];
}
