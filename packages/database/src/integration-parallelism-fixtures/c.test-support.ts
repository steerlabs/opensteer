import { it } from "vitest";

// A skipped file still needs a complete trace without depending on suite hooks.
it.skip("preserves an intentionally skipped integration journey", () => undefined);
