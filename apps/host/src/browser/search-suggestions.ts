import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { z } from "zod";

const providerResponse = z.tuple([z.string(), z.array(z.string())]).rest(z.unknown());

export async function searchSuggestions(
  query: string,
  fetch: typeof globalThis.fetch,
): Promise<string[]> {
  try {
    const signal = AbortSignal.timeout(1500);
    const response = await fetch(
      `https://www.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`,
      { redirect: "error", signal },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return [];
    }
    const [, suggestions] = providerResponse.parse(
      await readBoundedJson(response, { maximumBytes: 64 * 1024, signal }),
    );
    return [
      ...new Set(
        suggestions
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 200),
      ),
    ].slice(0, 8);
  } catch {
    return [];
  }
}
