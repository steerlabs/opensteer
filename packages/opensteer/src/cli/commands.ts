import type { OpensteerSemanticOperationName } from "@opensteer/protocol";

const OPERATION_ALIASES = new Map<string, OpensteerSemanticOperationName>([
  ["open", "session.open"],
  ["close", "session.close"],
  ["goto", "page.goto"],
  ["snapshot", "page.snapshot"],
  ["evaluate", "page.evaluate"],
  ["init-script", "page.add-init-script"],
  ["click", "dom.click"],
  ["hover", "dom.hover"],
  ["input", "dom.input"],
  ["scroll", "dom.scroll"],
  ["extract", "dom.extract"],
  ["tab", "page.activate"],
  ["tab list", "page.list"],
  ["tab new", "page.new"],
  ["tab close", "page.close"],
  ["network query", "network.query"],
  ["network detail", "network.detail"],
  ["fetch", "session.fetch"],
  ["state", "session.state"],
  ["computer click", "computer.execute"],
  ["computer type", "computer.execute"],
  ["computer key", "computer.execute"],
  ["computer scroll", "computer.execute"],
  ["computer move", "computer.execute"],
  ["computer drag", "computer.execute"],
  ["computer screenshot", "computer.execute"],
  ["computer wait", "computer.execute"],
  ["captcha solve", "captcha.solve"],
  ["scripts capture", "scripts.capture"],
  ["scripts beautify", "scripts.beautify"],
  ["scripts deobfuscate", "scripts.deobfuscate"],
  ["scripts sandbox", "scripts.sandbox"],
  ["interaction capture", "interaction.capture"],
  ["interaction get", "interaction.get"],
  ["interaction diff", "interaction.diff"],
  ["interaction replay", "interaction.replay"],
  ["artifact read", "artifact.read"],
]);

export function resolveOperation(
  command: readonly string[],
): OpensteerSemanticOperationName | undefined {
  for (let length = Math.min(3, command.length); length >= 1; length -= 1) {
    const key = command.slice(0, length).join(" ");
    const operation = OPERATION_ALIASES.get(key);
    if (operation) {
      return operation;
    }
  }
  return undefined;
}

export function resolveCommandLength(tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  if (tokens[0] === "browser") {
    return Math.min(tokens.length, 2);
  }
  if (tokens[0] === "skills") {
    return Math.min(tokens.length, 2);
  }
  if (tokens[0] === "status" || tokens[0] === "record" || tokens[0] === "exec") {
    return 1;
  }
  for (let length = Math.min(3, tokens.length); length >= 1; length -= 1) {
    if (OPERATION_ALIASES.has(tokens.slice(0, length).join(" "))) {
      return length;
    }
  }
  return Math.min(tokens.length, 1);
}
