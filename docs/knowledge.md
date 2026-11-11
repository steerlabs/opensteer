# Knowledge

Agents read and append structured facts with one `sql` tool. It is a trial: off unless
`OPENSTEER_KNOWLEDGE` is set, refused by [configuration](../packages/config/src/config.ts) on
anything but a Personal Deployment, and advertised as `knowledge-sql-v1`. Facts live in the Host's
own database, in the `knowledge` schema ([schema](../packages/database/src/knowledge-schema.ts)).

Schema changes use new versioned ensure steps; never edit a shipped step. Enabling the trial needs
a superuser Host connection to create roles and pin restricted-login settings. Turning it off
leaves existing facts in place. The [authority lease](../packages/database/src/deployment-authority.ts)
prevents two Hosts sharing the database.

## Who holds the tool

Knowledge follows the boundary personal memory follows: a conversation other people can start never
holds the person's private things, and the Host already expresses that as Main inheritance.
[One rule](../apps/host/src/knowledge/knowledge-eligibility.ts) decides the Run's skill and tool
plan, what MCP lists and what dispatch accepts: a Run that inherits Main (reach `user`), requested by
the Personal owner, on a Runner that advertises `knowledgeSkill`. So the owner's own tasks and
chats, their direct message to their bot and a task a connected agent with user reach starts in Main
hold it, exactly where they hold memory. A shared channel conversation, a workspace- or
lineage-reach Run, and a connection or Program calling directly never do. A Runner that cannot load
the skill still starts and plans its Runs exactly as with the trial off.

## The boundary

Three layers, each covering what the others cannot:

- The [validator](../apps/host/src/knowledge/sql-gate.ts) keeps every statement to `facts`,
  `fact_history` and reviewed functions, operators and types. It alone keeps agents away from
  settings, catalogs and functions such as `set_config`.
- Grants keep the restricted login out of every application table. Each start revokes PUBLIC from
  everything in the `knowledge` schema, so default privileges the Host's user set cannot reach it.
- Row security hides fact rows outside the caller's topics.

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
other `PG*` variables. It refuses any connection whose session is not the restricted login. It does
not support TLS yet, so a Host whose connection uses TLS cannot turn the trial on. The Host gives
the role a fresh random password at each start and keeps it only in memory.

## Limits

A small query can produce a huge row or an error quoting its input. pg-protocol buffers backend
messages before application code can catch an error, so SQL result limits alone cannot protect the
Host: the socket must reject oversized messages before the driver buffers them. Keep independent
server and encoded-result bounds, reject overdeep JSON, and suppress query-bearing database logs.
[The manager](../apps/host/src/knowledge/knowledge-manager.ts) owns the bounds.

Backend time and memory remain unbounded. PostgreSQL checks statement timeouts only at interrupt
points, and `work_mem` does not cap memory allocated by one expression. Allowed expressions have
exceeded the timeout and consumed gigabytes. This limitation is accepted for the Personal trial
and must be resolved or explicitly accepted before knowledge reaches a server.

Parameters arrive as JSON. Array queries must read a JSON array, not cast a parameter to a
PostgreSQL array.

## Parser and PostgreSQL versions

The parser is `libpg-query` pinned to PostgreSQL 17's grammar, because the desktop bundles
PostgreSQL 17. Self-hosted and development databases run 18, so newer syntax is refused there and
the reviewed functions were checked against 17. The
[corpus integration test](../apps/host/src/knowledge/sql-gate-corpus.integration.test.ts) runs
every admitted statement through the real schema; rerun it against every major the Host runs before
widening either. The parser loads its WASM relative to its own module, so builds leave it unbundled
and ship its package folder beside the Host.
