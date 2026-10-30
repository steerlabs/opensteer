# Opensteer Passwords failure coverage

The executable failure inventory is in [PasswordsCoreTests](PasswordsCoreTests)
and [PasswordsBrokerTests](PasswordsBrokerTests). Security and compatibility
constraints belong in the [broker contract](../README.md) and
[Passwords](../../../../../docs/passwords.md), rather than a parallel table of
test names and assertions. No runner consumes this Markdown as test input.

Keep coverage of rollback/checkpoint ordering, credential-byte preservation,
peer verification, current consent/revision checks, cancellation after waits,
secret-free output, import isolation and cross-version scope when changing tests.
`PasswordsAnywhereTests` covers protocol-4/5 consent; `WireFixtureTests` and the
TypeScript fixture consumer fence cross-language shapes.

Test procedures: [broker verification](../README.md#testing).
