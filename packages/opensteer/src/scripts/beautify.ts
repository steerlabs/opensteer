import * as prettier from "prettier";

const PRETTIER_SCRIPT_PARSERS = ["babel", "babel-ts", "typescript"] as const;

export async function beautifyScriptContent(content: string): Promise<string> {
  let lastError: unknown;
  for (const parser of PRETTIER_SCRIPT_PARSERS) {
    try {
      return await prettier.format(content, {
        parser,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error("failed to beautify script with available Prettier parsers", {
    cause: lastError,
  });
}
