/**
 * Pages of a tool listing. Each tool of a page carries a copy of every definition its schemas
 * reach, which for a densely connected API, such as Stripe's, is about 630,000 characters per
 * tool, so a page ends at its JSON length as well as its count, unless its reader keeps every page
 * in its process (`ToolListOptions.unboundedPages`).
 */
import { schemaDefinitions } from "@opensteer/plugin-engine-utils/schema-definitions";
import { Effect, Schema } from "effect";
import type { Json, JsonObject } from "../contracts/shared.ts";
import { type Tool, ToolPage } from "../contracts/tools.ts";
import type { ToolListing } from "./listings.ts";

/**
 * Where the tools after `cursor` start. A listing is sorted by name, so they are the ones from the
 * first name past it.
 */
export const pageStart = (listing: ToolListing, cursor: string | undefined) => {
  if (cursor === undefined) return 0;
  let low = 0;
  let high = listing.items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (listing.items[middle]!.name > cursor) high = middle;
    else low = middle + 1;
  }
  return low;
};

/**
 * The JSON length of tools of a listing that was not kept, so has no `itemChars`, with a copy of
 * every definition their schemas hold. Each definition object is written once to count it.
 */
const counter = () => {
  const definitionLengths = new Map<object, number>();
  const definitionLength = (definition: Json) => {
    if (typeof definition !== "object" || definition === null)
      return JSON.stringify(definition).length;
    let length = definitionLengths.get(definition);
    if (length === undefined)
      definitionLengths.set(definition, (length = JSON.stringify(definition).length));
    return length;
  };
  /** A schema with its `$defs` emptied, and the length its entries add between the braces. */
  const definitionsApart = (schema: JsonObject) => {
    const own = schemaDefinitions(schema);
    if (own === undefined) return { schema, length: 0 };
    let length = 0;
    let entries = 0;
    for (const [name, definition] of Object.entries(own)) {
      length += JSON.stringify(name).length + 1 + definitionLength(definition);
      entries += 1;
    }
    return { schema: { ...schema, $defs: {} }, length: length + Math.max(0, entries - 1) };
  };
  return (tool: Tool) => {
    const input = definitionsApart(tool.inputSchema);
    const output =
      tool.outputSchema === undefined ? undefined : definitionsApart(tool.outputSchema);
    return (
      JSON.stringify({
        ...tool,
        inputSchema: input.schema,
        ...(output === undefined ? {} : { outputSchema: output.schema }),
      }).length +
      input.length +
      (output?.length ?? 0)
    );
  };
};

const encodePage = Schema.encodeEffect(ToolPage);

/**
 * The tools of one page of `listing`, from position `start`: at most `limit`, and, with `chars`, no
 * more than the page's JSON holds in that many UTF-16 code units, unless its first tool alone is
 * more. The page's other fields and its `next` cursor count too. A kept listing's tools are counted
 * by its `itemChars`; only a listing that was not kept is written to count them.
 */
export const pageTools = (
  listing: ToolListing,
  start: number,
  limit: number,
  chars: number | undefined,
) =>
  Effect.gen(function* () {
    const candidates = listing.items.slice(start, start + limit);
    const first = candidates[0];
    if (chars === undefined || first === undefined) return candidates;
    const kept = listing.itemChars;
    const count = counter();
    // A listing's tools were decoded, so encoding a page of them cannot fail.
    const pageLength = (items: ReadonlyArray<Tool>) =>
      encodePage({ ...listing.catalog, routers: listing.routers, items }).pipe(
        Effect.map((page) => JSON.stringify(page).length),
        Effect.orDie,
      );
    const { outputSchema: _output, _meta: _toolMeta, ...fields } = first;
    // A tool of the page without schemas, encoded beside the empty page.
    const sample = { ...fields, inputSchema: {} };
    let length = yield* pageLength([]);
    // What a page's encoding adds to each tool: the legacy copy of its version, which every tool
    // of a listing shares.
    const added = (yield* pageLength([sample])) - length - JSON.stringify(sample).length;
    const page: Array<Tool> = [];
    for (const [index, tool] of candidates.entries()) {
      length +=
        (index === 0 ? 0 : 1) + (kept === undefined ? count(tool) : kept[start + index]!) + added;
      // A page with tools after it names its last one: `,"next":` and the name, which JSON writes
      // in at most six characters each. Only a page near its bound writes the name to count it.
      if (
        index > 0 &&
        length + 10 + tool.name.length * 6 > chars &&
        length +
          (start + index + 1 < listing.items.length ? 8 + JSON.stringify(tool.name).length : 0) >
          chars
      )
        break;
      page.push(tool);
    }
    return page;
  });
