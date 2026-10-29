export const runnerExternals = [
  // Retain SDK JavaScript; distributions exclude its optional Claude executables.
  "@anthropic-ai/claude-agent-sdk",
  // Peer of that SDK; both must see the same module instance.
  "@modelcontextprotocol/sdk",
  // Native image decoder selects platform binaries at runtime.
  "sharp",
  // CJS with dynamic requires of Node builtins; bundling breaks at load.
  "ws",
  // One schema registry per process: bundled copies fail instanceof checks.
  "zod",
] as const;
