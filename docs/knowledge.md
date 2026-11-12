# Team knowledge

Knowledge exists only on team servers. Each channel has its own topic with the channel's
access; shared topics have independent read/write/manage lists. A channel's shared memory is
its topic and searchable chat, with no channel memory files. Personal memory remains files in
`~/Opensteer`.

Attaching a shared topic to a channel grants no access. Agent SQL is scoped to the current
run ticket's channel topic and attached topics its owner may use. Either people-only switch
excludes the agent. A task's earlier team Runs confer no authority on a private follow-up.

Schema changes use new versioned ensure steps; never edit a shipped step. Each start gives the
restricted login a new password, so the
[authority lease](../packages/database/src/deployment-authority.ts) must keep two Hosts off one
database.

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

A small query can produce a huge row or an error quoting its input. pg-protocol buffers backend
messages before application code can catch an error, so SQL result limits alone cannot protect the
Host: the socket must reject oversized messages before the driver buffers them. Keep independent
server and encoded-result bounds, reject overdeep JSON, and suppress query-bearing database logs.
[The manager](../apps/host/src/knowledge/knowledge-manager.ts) owns the bounds.

Backend time and memory per query remain unbounded. PostgreSQL checks statement timeouts only at
interrupt points, and `work_mem` does not cap memory allocated by one expression, so one hostile
query can exhaust the container cap, restart PostgreSQL and briefly interrupt chat. The container
cap bounds that damage; v1 promises neither per-query isolation nor uninterrupted availability.
Managed or TLS PostgreSQL and native unbounded PostgreSQL are outside the v1 recipe.

Parameters arrive as JSON. Array queries must read a JSON array
(`jsonb_array_elements_text($n::jsonb)`), not cast a parameter to a PostgreSQL array.

## Parser and PostgreSQL versions

The parser is `libpg-query` pinned to PostgreSQL 17's grammar. The team recipe runs PostgreSQL 18,
so newer syntax stays refused until reviewed. The
[corpus integration test](../apps/host/src/knowledge/sql-gate-corpus.integration.test.ts) runs
every admitted statement through the real schema; rerun it against every major the Host runs before
widening either. The parser loads its WASM relative to its own module, so builds leave it unbundled
and ship its package folder beside the Host.
