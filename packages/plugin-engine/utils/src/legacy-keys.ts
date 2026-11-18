import { Schema, SchemaTransformation } from "effect";

type Mapping<S extends Schema.Struct<Schema.Struct.Fields>> = {
  readonly [K in keyof S["fields"]]?: string;
};

type LegacyEncoded<S extends Schema.Struct<Schema.Struct.Fields>, M extends Mapping<S>> = Omit<
  S["Encoded"],
  keyof M
> & {
  readonly [K in keyof M & keyof S["Encoded"]]?: S["Encoded"][K];
} & {
  readonly [K in keyof M as M[K] extends string ? M[K] : never]?: K extends keyof S["Encoded"]
    ? S["Encoded"][K]
    : never;
};

/** A struct whose renamed fields also travel under their former names. */
export interface withLegacyKeys<
  S extends Schema.Struct<Schema.Struct.Fields>,
  M extends Mapping<S>,
> extends Schema.decodeTo<S, Schema.Codec<LegacyEncoded<S, M>>> {}

/**
 * Keep renamed fields readable by callers that still use their former names. `{ version:
 * "deployment" }` decodes `version`, or `deployment` when `version` is absent, and encodes the
 * value under both keys. Clients, stored values and app bundles written before a rename keep
 * working, while the decoded type has only the new name.
 */
export const withLegacyKeys =
  <S extends Schema.Struct<Schema.Struct.Fields>, const M extends Mapping<S>>(mapping: M) =>
  (self: S): withLegacyKeys<S, M> => {
    const renamed = Object.entries(mapping).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    const fields: Record<string, Schema.Top> = {};
    for (const key of Object.keys(self.fields)) {
      const encoded = Schema.toEncoded(self.fields[key]!);
      const legacy = mapping[key as keyof M];
      fields[key] = typeof legacy === "string" ? Schema.optionalKey(encoded) : encoded;
      if (typeof legacy === "string") fields[legacy] = Schema.optionalKey(encoded);
    }
    return Schema.Struct(fields).pipe(
      Schema.decodeTo(
        self,
        SchemaTransformation.transform({
          decode: (input: Record<string, unknown>) => {
            const output = { ...input };
            for (const [key, legacy] of renamed) {
              if (!Object.hasOwn(output, key) && Object.hasOwn(output, legacy)) {
                output[key] = output[legacy];
              }
              delete output[legacy];
            }
            return output;
          },
          encode: (input: Record<string, unknown>) => {
            const output = { ...input };
            for (const [key, legacy] of renamed) {
              if (Object.hasOwn(output, key)) output[legacy] = output[key];
            }
            return output;
          },
        }),
      ),
    ) as unknown as withLegacyKeys<S, M>;
  };
