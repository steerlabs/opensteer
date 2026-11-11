# Keeping wanted work recoverable

Recover ordinary failures within the person's authorization and the site's constraints. Choose retries and backoff from the failure and the usefulness of the work. An agent-chosen retry budget must not prevent a different repair supported by new evidence. Preserve person-requested pauses and stops.

Arrange confirmed future execution or hand unresolved recovery to the assigning Thread before ending a Run or pausing the only Trigger. Never promise a retry without a continuation that will perform it. Coordinate recovery ownership and shared state across Runs and Occurrences so concurrent checks or repairs do not duplicate effects.

Respect site blocks, rate limits and `Retry-After`. Never change identity or session to bypass them. Follow opensteer:browser for website sign-in. CAPTCHA, missing credentials and approval may require the person: explain the need once and suspend affected checks until resolved, without reloading a challenge or repeating a pending Request. Ask for decisions or access agents cannot supply; otherwise pursue a useful repair within scope.

Carry these goals and the person's criteria into delegated check tasks. Unresolved recovery returns to the assigning Thread with evidence and a next step. Reusable logic and observations belong in the owning task folder.

For an active cron schedule, `set_next_fire` accepts a future ISO `nextFireAt` to defer the next run; normal cadence resumes afterward. Pause when nothing should run, and resume when work can continue. A Trigger-dispatched worker can manage that Trigger within its own authority without a round trip through Agent home.
