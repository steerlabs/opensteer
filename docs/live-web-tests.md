# Live Web Validation Suite

This suite validates description-driven LLM resolution and extraction against live public websites with diverse structures (navigation-heavy docs, iframes, and shadow DOM).

## Why this suite exists

- Validate real internet page behavior, not only local fixtures.
- Confirm deterministic pass/fail outcomes for completed tasks.
- Optionally add a lightweight LLM judge for semantic review.

## Run locally

```bash
RUN_LIVE_WEB=1 npm run test:live-web
```

## Environment variables

- `RUN_LIVE_WEB`: Set to `1` to enable this suite.
- `LIVE_WEB_MODEL`: Resolver/extractor model. Default: `gemini-2.0-flash`.
- `LIVE_WEB_SCENARIOS`: Optional comma-separated scenario ids.
- `LIVE_WEB_JUDGE`: `1` (default) enables judge, `0` disables judge.
- `LIVE_WEB_JUDGE_MODE`: `advisory` (default) or `strict`.
- `LIVE_WEB_JUDGE_MODEL`: Optional override for judge model. Defaults to `LIVE_WEB_MODEL`.

## API keys

The required key depends on the model prefix:

- `gpt-*`, `o1-*`, `o3-*`, `o4-*` -> `OPENAI_API_KEY`
- `claude-*` -> `ANTHROPIC_API_KEY`
- `gemini-*` -> `GOOGLE_GENERATIVE_AI_API_KEY`
- `grok-*` -> `XAI_API_KEY`
- `groq/*` -> `GROQ_API_KEY`

## Example commands

Run one scenario:

```bash
RUN_LIVE_WEB=1 \
LIVE_WEB_SCENARIOS=wikipedia-search \
LIVE_WEB_MODEL=gemini-2.0-flash \
npm run test:live-web
```

Strict judge mode:

```bash
RUN_LIVE_WEB=1 \
LIVE_WEB_JUDGE_MODE=strict \
npm run test:live-web
```

## Notes

- This suite is intentionally manual/explicit and is not part of default `npm test`.
- Deterministic checks are the primary pass criteria.
- In `advisory` mode, judge failures do not fail the test.
