# @opensteer/protocol

Public wire schemas and versioned envelopes for Opensteer APIs.

Install this package when you need to exchange typed request, response, event,
or artifact payloads with Opensteer services and runtimes.

```bash
pnpm add @opensteer/protocol
```

Most application code should use [`opensteer`](../opensteer/README.md). Reach for
`@opensteer/protocol` directly when you need stable transport-level types without
the higher-level SDK.
