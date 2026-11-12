# Team knowledge

Knowledge exists only on team servers. Each channel has its own topic with the channel's
access; shared topics have independent read/write/manage lists. A channel's shared memory is
its topic and searchable chat, with no channel memory files. Personal memory remains files in
`~/Opensteer`.

Attaching a shared topic to a channel grants no access. Agent SQL is scoped to the current
run ticket's channel topic and attached topics its owner may use. Either people-only switch
excludes the agent. A task's earlier team Runs confer no authority on a private follow-up.

Knowledge writes hold the team access share lock and recheck authority while the restricted
executor writes and commits. Only then may the main-pool fence release. Buffered answers
recheck the access revision at handoff and discard the whole result on access loss, rather than
returning partial rows. See [Teams](teams.md#access-and-removal).

## The boundary

Three layers, each covering what the others cannot:

- The [validator](../apps/host/src/knowledge/sql-gate.ts) keeps every statement to `facts`,
  `fact_history` and reviewed functions, operators and types. It alone keeps agents away from
  settings, catalogs and functions such as `set_config`.
- Grants keep the restricted login out of every application table. Each start revokes PUBLIC from
  everything in the `knowledge` schema, so default privileges the Host's user set cannot reach it.
- Forced row-level security hides fact rows outside the server-set topic arrays.

The login alone does not hide PostgreSQL's public catalogs: through PUBLIC grants, which cannot be
revoked for one role, it can read `pg_class`, `pg_proc`, `pg_settings` and call `set_config`. That
is why the validator is not optional, and why the server must read a statement exactly as the
validator did. `libpg-query` always lexes with `standard_conforming_strings` on, so the login and
every transaction pin it, `backslash_quote` and `client_encoding`. Under the legacy string setting,
one admitted statement could otherwise hide a `set_config` call that forges its topic scope.

Agent SQL runs as its own non-superuser LOGIN role with its own two-connection pool, never through
`SET ROLE` on the Host's connection. The Host's session user is a superuser, and PostgreSQL checks
`SET ROLE` and `set_config('role', …)` against the session user, so one validator slip would become
superuser and a shell through `COPY … TO PROGRAM`. The pool reaches the server and database that pg
resolves for the Host's own connection, environment included, but its startup carries only the
login, database and name: no options, replication or timeouts from the query string, `PGOPTIONS` or
other `PG*` variables. It refuses any connection whose session is not the restricted login. It refuses TLS; the restricted login uses the recipe's private database network, which must have no published PostgreSQL port. The Host gives
the role a fresh random password at each start and keeps it only in memory.

## Resource limits and availability

The Host allows two restricted connections, eight waiting callers, a two-second statement
timeout and a 250 ms lock timeout; excess callers get `knowledge-busy`. The
[Compose recipe](../deploy/team/compose.yaml) caps PostgreSQL at 2 GiB including swap and two
CPUs, on a private database network without a published port. The Host database user must be a
superuser to prepare the restricted role; role preparation or restricted-login verification
failure refuses team startup. Personal Hosts never initialize this executor.

The Host never receives more than it can safely parse. pg-protocol turns each backend message into
a string as it arrives, and a short query can make PostgreSQL send hundreds of megabytes, as a row
or as an error that quotes a failing input, crashing the Host from the socket parser where no
`catch` reaches. So:

- The socket under each knowledge connection reads every message header and drops the connection
  on a message over 1 MB, before the driver buffers it. The statement fails; the process does not.
- Inside PostgreSQL, a row over 512 KB (the whole row's text, whatever its columns are named)
  raises, and so does a result whose running total passes 1 MB. At most 200 rows are returned.
- The manager then refuses a whole encoded result over 512 KB rather than truncating it, and
  counts a result it cannot encode as over that. `JSON.stringify` overflows near 8,000 levels of
  nesting, so a stored fact value nests at most 64 arrays and objects.
- The login logs only FATAL messages, so such error text never reaches the server log.

Also bounded: temp files at 32 MB; statement text at 16 KiB; at most 64 parameters, each bounded
only by the size of the MCP request; a write at 25 facts, each value at 64 KB.

Timeouts are checked at PostgreSQL interrupt points, not continuously, and `work_mem` does
not bound expression allocation. One hostile query can exhaust the container cap, restart
PostgreSQL and briefly interrupt chat. These limits protect the Host parser and bound the
container; they do not promise per-query memory isolation or uninterrupted team availability.
External managed/TLS PostgreSQL and native unbounded PostgreSQL are outside the v1 recipe.

Parameters arrive as JSON; use `jsonb_array_elements_text($n::jsonb)` for a list. The validator
refuses array casts and `ANY($n)`. The parser uses PostgreSQL 17 grammar; newer syntax stays
refused on PostgreSQL 18 until reviewed. The
[corpus integration test](../apps/host/src/knowledge/sql-gate-corpus.integration.test.ts) must
prove admitted syntax against each supported PostgreSQL major before widening the boundary.
The parser's WASM loads relative to its package, so builds ship it unbundled beside the Host.
