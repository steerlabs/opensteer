# Knowledge

Agents read and append structured facts with one `sql` tool. It is a trial: off unless
`OPENSTEER_KNOWLEDGE` is set, refused by [configuration](../packages/config/src/config.ts) on
anything but a Personal Deployment, and advertised as `knowledge-sql-v1`. Facts live in the Host's
own database, in the `knowledge` schema ([schema](../packages/database/src/knowledge-schema.ts)).

## Who holds the tool

Only Runs that inherit Main: the owner's own conversations and tasks, and an owner-linked direct
message to their bot. A shared channel conversation is denied Main inheritance and is denied this
tool for the same reason: other people can start its Runs. Programs and connected agents are not
offered it. The [filter](../packages/agent-tools/src/tools-for.ts) decides what is listed and what
dispatch accepts, and the [manager](../apps/host/src/knowledge/knowledge-manager.ts) checks again.

## The boundary

Three layers, each covering what the others cannot:

- The [validator](../apps/host/src/knowledge/sql-gate.ts) keeps every statement to `facts`,
  `fact_history` and reviewed functions, operators and types. It alone keeps agents away from
  settings, catalogs and functions such as `set_config`.
- Grants keep the restricted login out of every application table.
- Row security hides fact rows outside the caller's topics.

The login alone does not hide PostgreSQL's public catalogs: through PUBLIC grants, which cannot be
revoked for one role, it can read `pg_class`, `pg_proc`, `pg_settings` and call `set_config`. That
is why the validator is not optional.

Agent SQL runs as its own non-superuser LOGIN role with its own two-connection pool, never through
`SET ROLE` on the Host's connection. The Host's session user is a superuser, and PostgreSQL checks
`SET ROLE` and `set_config('role', …)` against the session user, so one validator slip would become
superuser and a shell through `COPY … TO PROGRAM`. The Host gives the role a fresh random password at
each start and keeps it only in memory.

## Limits

Each SELECT is wrapped so a row over 512 KB raises an error inside PostgreSQL. Counting bytes in the
Host is too late: the driver turns each row into a string as it arrives, and a short query can build
a field large enough to crash the Host process from the socket parser, where no `catch` reaches.
The manager then refuses a whole encoded result over 512 KB rather than truncating it.

Backend memory has no hard bound. `work_mem` and `temp_file_limit` do not cap one expression, and a
short accepted query can grow a PostgreSQL backend to gigabytes within its statement timeout. That
is acceptable for one person's own agents and must be decided before knowledge reaches a server.

## Parser and PostgreSQL versions

The parser is `libpg-query` pinned to PostgreSQL 17's grammar, because the desktop bundles
PostgreSQL 17. Self-hosted and development databases run 18, so newer syntax is refused there and
the reviewed functions were checked against 17. Rerun the hostile corpus against every major the
Host runs before widening either. The parser loads its WASM relative to its own module, so builds
leave it unbundled and ship its package folder beside the Host.
