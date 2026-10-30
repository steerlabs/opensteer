/** Conservative inventory: unknown tool occurrences fail closed, independent of the
 * caller API. Exemptions describe credential-free calls or reviewed routing. */
export interface SigningSource {
  file: string;
  source: string;
}
const fixtureHarnesses = new Set([
  "scripts/verify-release-beta-mac.ts",
  "apps/desktop/scripts/electron-passwords-smoke.ts",
]);
export function isAuditedSigningSource(file: string): boolean {
  return (
    (/\.(?:[cm]?[jt]sx?|sh|bash|zsh|command|py|swift|go|ya?ml|c|cc|cpp|h|hpp|m|mm|rs|rb|pl|kt|kts|gradle|ps1|cmd|bat)$/iu.test(
      file,
    ) ||
      /(?:^|\/)(?:package\.json|Makefile|Dockerfile|Justfile)$/u.test(file) ||
      /(?:^|\/)(?:scripts|bin)\/[^/.]+$/u.test(file)) &&
    !/(?:^|\/)(?:docs|tests|Tests|fixtures|test-support|test-vm)\//u.test(file) &&
    !/\.test\.[^/]+$/u.test(file) &&
    !/(?:^|\/)test-[^/]+$/u.test(file) &&
    !fixtureHarnesses.has(file)
  );
}
interface Token {
  value: string;
  start: number;
  end: number;
  array?: number;
}
function invocations(
  source: string,
  shell: boolean,
  json: boolean,
): Array<{ tool: string; span: string; line: number }> {
  const tokens: Token[] = [];
  const arrays = new Map<number, number>();
  const stack: number[] = [];
  // Comments are consumed before string literals; caller names are deliberately
  // irrelevant (spawn, execFile, wrappers, Swift/Python APIs all see the same tools).
  const lexical =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|^\s*#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[[\]]/gmu;
  for (const match of source.matchAll(lexical)) {
    const raw = match[0];
    if (raw.startsWith("/*") || raw.startsWith("//") || raw.trimStart().startsWith("#")) continue;
    const index = tokens.length;
    const value = raw === "[" || raw === "]" ? raw : raw.slice(1, -1);
    tokens.push({
      value,
      start: match.index,
      end: match.index + raw.length,
      ...(stack.length ? { array: stack.at(-1)! } : {}),
    });
    if (raw === "[") stack.push(index);
    if (raw === "]") {
      const start = stack.pop();
      if (start !== undefined) arrays.set(start, index);
    }
  }
  const found: Array<{ tool: string; span: string; line: number }> = [];
  for (const [index, token] of tokens.entries()) {
    if (json && /^\s*:/u.test(source.slice(token.end))) continue;
    const tool = token.value.replace(/^\/usr\/bin\//u, "");
    const embedded = tool.match(
      /^(codesign|notarytool|productsign|security\s+find-identity)\s+(?:--?\w|submit|info|history)/u,
    );
    if (embedded) {
      found.push({
        tool: embedded[1]!.startsWith("security") ? "find-identity" : embedded[1]!,
        span: token.value,
        line: source.slice(0, token.start).split("\n").length,
      });
      continue;
    }
    if (
      !["codesign", "find-identity", "notarytool", "productsign", "electron-builder"].includes(tool)
    )
      continue;
    let start = token.array;
    const next = tokens[index + 1];
    if (
      start === undefined &&
      next?.value === "[" &&
      source[next.start] === "[" &&
      /^[\s,]*$/u.test(source.slice(token.end, next.start))
    )
      start = index + 1;
    const end = start === undefined ? undefined : arrays.get(start);
    const lineStart = source.lastIndexOf("\n", token.start) + 1;
    const lineEnd = source.indexOf("\n", token.end);
    const span =
      start !== undefined && end !== undefined
        ? source.slice(tokens[start]!.start, tokens[end]!.end)
        : source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
    found.push({ tool, span, line: source.slice(0, token.start).split("\n").length });
  }
  // Shell commands and commands embedded in exec('...') must not escape the
  // literal-token inventory. Unknown forms require an explicit review.
  if (shell)
    for (const match of source.matchAll(
      /(?:^|[\s;|&"'])(?:\/usr\/bin\/)?(codesign|notarytool|productsign|electron-builder|security[ \t]+find-identity)\b([^\n]*)/gmu,
    )) {
      const line = source.slice(0, match.index).split("\n").length;
      if (source.split("\n")[line - 1]?.trimStart().startsWith("#")) continue;
      if (!found.some((item) => item.line === line))
        found.push({
          tool: match[1]!.startsWith("security") ? "find-identity" : match[1]!,
          span: match[0],
          line,
        });
    }
  for (const match of source.matchAll(/^\s*notarize:\s*true\s*$/gmu))
    found.push({
      tool: "electron-builder",
      span: match[0].trim(),
      line: source.slice(0, match.index).split("\n").length,
    });
  return found;
}
const contributorElectronBuilderArgv =
  '["exec","electron-builder","--mac","--dir",process.arch==="arm64"?"--arm64":"--x64","--config","electron-builder.yml","-c.directories.output=release/contributor","-c.mac.identity=-","-c.mac.notarize=false","-c.mac.hardenedRuntime=false",]';
function reviewed(file: string, tool: string, span: string, source: string): boolean {
  // The auditor's tool vocabulary and result labels are data, not executions.
  // Keep these exemptions structural: a bare signer added here is still rejected.
  if (file === "scripts/signing-invocation-guard.ts") {
    if (span.includes("span.includes(") || span.trimStart().startsWith("tool: embedded[1]"))
      return true;
    if (
      span.includes('"find-identity"') &&
      span.includes('"codesign"') &&
      span.includes('"productsign"') &&
      span.includes('"notarytool"') &&
      span.includes('"electron-builder"')
    )
      return true;
    if (
      /tool === ["'](?:codesign|find-identity|notarytool|electron-builder)["']/u.test(span) &&
      !span.includes("--sign")
    )
      return true;
    if (/tool: ["']electron-builder["']/u.test(span)) return true;
  }
  // Verification/description consumes no private signing identity.
  if (
    tool === "codesign" &&
    /^\[\s*(?:["'](?:\/usr\/bin\/)?codesign["']\s*,\s*)?["'](?:--verify|-dv|-d|--display)["']/u.test(
      span,
    ) &&
    !/["'](?:--sign|-s)["']/u.test(span)
  )
    return true;
  // The same for a shell line. Its span runs to the end of the line, so a signer
  // chained after the verification is still rejected.
  if (
    tool === "codesign" &&
    /^\s*(?:\/usr\/bin\/)?codesign\s+(?:--verify|-dv|-d|--display)\s/u.test(span) &&
    !/(?:^|\s)(?:--sign|-s)(?:[\s=]|$)/u.test(span)
  )
    return true;
  if (
    tool === "codesign" &&
    span.includes("...signingKeychainArguments(") &&
    source.includes("signing-input.cjs")
  )
    return true;
  if (
    file === "scripts/public-download/eu-journey.ts" &&
    tool === "codesign" &&
    span.replace(/\s+/gu, "") === '["--force","--deep","--sign","-",badApp]'
  )
    return true;
  // Short reviewed routing list; each exception is invocation-specific, so a
  // second bare call in the same file is still rejected.
  if (file === "scripts/release-beta-mac.ts") {
    if (tool === "notarytool" && span.includes("...credentials(config)")) return true;
    if (tool === "find-identity" && span.includes("signingInput(config).keychain")) return true;
  }
  if (
    file === "apps/desktop/scripts/native-build-cache.ts" &&
    tool === "find-identity" &&
    span.includes("...(keychain ? [keychain] : [])") &&
    source.includes("readSigningMode")
  )
    return true;
  if (
    file === "apps/desktop/scripts/verify-signed-helper.py" &&
    tool === "codesign" &&
    span.includes("keychain_arguments")
  )
    return true;
  // Argument-preserving timing adapter; it never selects an identity.
  if (
    file === "apps/desktop/scripts/codesign-timing.cjs" &&
    tool === "codesign" &&
    (span.includes('options.execute("/usr/bin/codesign", args)') || span.includes("...args"))
  )
    return true;
  // The timing wrapper creates this filename, then forwards the original argv.
  if (
    file === "apps/desktop/scripts/mac-signing-timing.ts" &&
    tool === "codesign" &&
    span.includes('path.join(directory, "codesign")')
  )
    return true;
  // Other-platform packagers cannot invoke Apple's signer or notarizer.
  if (
    (file === "apps/desktop/scripts/package-linux.ts" && span.includes('"--linux"')) ||
    (file === "apps/desktop/scripts/package-windows.ts" && span.includes('"--win"'))
  )
    return tool === "electron-builder";
  if (file === "scripts/command-runner.ts" && tool === "notarytool" && span.includes('"stapler"'))
    return true;
  // electron-builder receives the keychain in the tested package environment.
  if (
    file === "apps/desktop/scripts/package-macos.ts" &&
    tool === "electron-builder" &&
    span.includes("forceCodeSigning=true") &&
    source.includes("CSC_KEYCHAIN: signingMode.signing.keychain")
  )
    return true;
  if (file === "apps/desktop/electron-builder.base.yml" && span === "notarize: true") return true;
  // Contributor packages are ad-hoc signed and never notarized. Only this exact argv is
  // reviewed, so an expression cannot keep the flags in a branch that does not run.
  if (
    file === "apps/desktop/scripts/package-contributor-macos.ts" &&
    tool === "electron-builder" &&
    span.replace(/\s+/gu, "") === contributorElectronBuilderArgv
  )
    return true;
  return false;
}
export function auditSigningInvocations(files: readonly SigningSource[]): string[] {
  return files
    .filter(({ file }) => isAuditedSigningSource(file))
    .flatMap(({ file, source }) =>
      invocations(
        source,
        /\.(?:sh|bash|zsh|command)$/u.test(file) || !file.split("/").at(-1)!.includes("."),
        file.endsWith(".json"),
      )
        .filter(({ tool, span }) => !reviewed(file, tool, span, source))
        .map(
          ({ tool, line }) =>
            `${file}:${line}: unreviewed ${tool} invocation; route through the shared keychain helper or review its explicit routing`,
        ),
    );
}
