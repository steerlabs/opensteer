# Operation schemas and calls

Search shows each operation's `input`, so call it directly with `operation` and `account`. Use `integration_describe` when `input` ends in `…` or you need more detail. The Host checks the current grant and account at execution.

Do not infer an empty input schema from the operation's name.

`integration_describe` returns the account (`alias`, `connectionId`, `isDefault`), the operation, and
its exact `inputSchema` and `outputSchema`, each a standalone JSON Schema whose `$ref`s point into its own `$defs`. An answer is
one JSON header line, then schema JSON. A large API's schemas span several pages: while the
header's `nextCursor` is not null, call again with the same `operation` and `path` and that `cursor`;
the pages join into one JSON document. Usually you need less. Pass `path`, a JSON Pointer into
`{inputSchema, outputSchema}`, to read one part: `/inputSchema/properties` for the arguments, or
`/inputSchema/$defs/Assistant` for the type a `$ref` of `#/$defs/Assistant` inside `inputSchema`
names.

`integration_call` sends the arguments you give; the upstream validates them and its refusal is returned. Correct arguments from the schema and error rather than retrying unchanged.

Select accounts by `connectionId`, never by repeated display names. After a Request resolves, search fresh operations for the fulfilled connection. If a call reports lost authorization, search again and create the needed Request; no Request is created on your behalf. Search again when an operation vanishes. If a write has only read access, request `read-write` for that integration and wait for fulfillment. Never switch accounts or servers to bypass a failure.
