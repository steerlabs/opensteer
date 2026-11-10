# Knowledge

Agents read and append structured facts with one `sql` tool. It is a trial: off unless
`OPENSTEER_KNOWLEDGE` is set, refused by [configuration](../packages/config/src/config.ts) on
anything but a Personal Deployment, and advertised as `knowledge-sql-v1`. Facts live in the Host's
own database, in the `knowledge` schema ([schema](../packages/database/src/knowledge-schema.ts)).

With the trial off, nothing about knowledge exists in the database. The schema, its owner role and
the restricted login come from a versioned ensure step that the manager runs at each start with the
trial on, in one transaction under an advisory lock. Add a step to change the schema; never edit
one that shipped. The Host's PostgreSQL user must be a superuser, as the desktop's is: the step
creates the schema under its owner role and pins the login's logging, which CREATEROLE alone cannot.
Otherwise turning the trial on fails at start. Each start gives the login a new password, so two
Hosts must never share a database with the trial on; the
[authority lease](../packages/database/src/deployment-authority.ts) already refuses a second Host on
a database. Turning the trial off leaves the schema and its facts in place.

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

Neither backend time nor backend memory is bounded. `statement_timeout` is only checked between
interrupt checks, and string building inside one expression does not check: with the functions
still allowed, a 2 s timeout landed after 3.9 s. `work_mem` and `temp_file_limit` do not cap one
expression: one backend reached 3.8 GB, and the pool's two together 5.9 GB (PostgreSQL 17.11 on
macOS). `lpad`, `rpad`, `format` and `repeat` are refused because one call builds any width, but
`||`, `replace`, `regexp_replace`, `to_jsonb` and `string_agg` still amplify. That is acceptable for one
person's own agents and must be decided before knowledge reaches a server.

Parameters reach PostgreSQL as JSON, so a list is a JSON array read with
`jsonb_array_elements_text($n::jsonb)`; the validator refuses `ANY($n)` and parameters cast to
arrays, which could never work.

## Parser and PostgreSQL versions

The parser is `libpg-query` pinned to PostgreSQL 17's grammar, because the desktop bundles
PostgreSQL 17. Self-hosted and development databases run 18, so newer syntax is refused there and
the reviewed functions were checked against 17. The
[corpus integration test](../apps/host/src/knowledge/sql-gate-corpus.integration.test.ts) runs
every admitted statement through the real schema; rerun it against every major the Host runs before
widening either. The parser loads its WASM relative to its own module, so builds leave it unbundled
and ship its package folder beside the Host.
