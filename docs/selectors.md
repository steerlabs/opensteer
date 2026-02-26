# Selectors

Selectors are stored under:

`.opensteer/selectors/<namespace>`

Each namespace contains:

- `index.json`: selector registry metadata
- `<descriptor-id>.json`: persisted descriptor records

Each descriptor stores:

- action/extraction method
- `description`
- persisted DOM path (stable attributes + fallback hints)
- metadata (`createdAt`, `updatedAt`, optional `sourceUrl`)

During replay, Opensteer resolves in this order:

1. Persisted path by `description`
2. Snapshot `element` counter
3. Explicit CSS `selector`
4. Built-in LLM resolution

When resolution succeeds through steps 2-4 and `description` is present, the
resolved path is persisted for future runs.
