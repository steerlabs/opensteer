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
2. If persisted path fails with `TARGET_NOT_FOUND`, one-shot AI self-heal from `description`, then cache refresh + retry
3. Snapshot `element` counter
4. Explicit CSS `selector`
5. Built-in LLM resolution

When resolution succeeds through steps 2-5 and `description` is present, the
resolved path is persisted for future runs.

This replay/self-heal flow applies to local runtime selector cache behavior.
