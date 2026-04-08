# Agent Framework Analysis: How to Make Opensteer Agent-Native

## Context

An AI agent was tasked with reverse-engineering Zillow's search API using Opensteer. It executed the exploratory phase (open, snapshot, input, capture, query, detail) beautifully — then completely abandoned the framework at the probing/replay phase and fell back to raw `evaluate` calls and Playwright-level workarounds.

This analysis examines why, and proposes changes to make the framework intuitive for AI agents without heavy prompting.

---

## The Core Problem

Opensteer has **66 SDK methods, 57 semantic operations, 37 CLI flags, and a 9-phase request workflow**. An AI agent's working memory holds maybe 5-7 concepts under pressure. When things go wrong (403s, wrong flags), the agent retreats to what it knows from training — `evaluate`, raw `fetch()`, Playwright patterns — not the framework's step 4 of 9.

The Zillow session proved this precisely: the agent executed steps 1-3 beautifully (these map to universal concepts: "open browser", "type something", "look at network tab") and then abandoned the framework at step 4 (`replay`) because that concept doesn't exist anywhere in its training distribution.

---

## Why The Agent Skipped What It Skipped

| Skipped tool | Why (from agent's perspective) |
|---|---|
| `replay` | "I already have the URL/method/body from `network detail` — why would I replay it? I can just call it myself." The agent doesn't understand that `replay` tests transport portability. The word "replay" suggests "do it again identically," not "discover what transport works." |
| `cookies` / `state` | "I know it needs cookies because of PerimeterX." The agent inferred this from general knowledge and didn't see the point of confirming with a tool. |
| `inferRequestPlan` | Zero analogue in training data. No developer has ever written a blog post about "inferring a request plan from a captured network record." |
| `request.execute` | Requires a plan to already exist. The agent never created a plan, so this was unreachable. |
| `rawRequest` | The agent tried `fetch` instead (closer to its mental model of HTTP). `rawRequest` is a diagnostic probe — a concept that doesn't exist outside Opensteer. |
| Recipes / Auth recipes | Multi-step declarative workflow DSL. Agents have zero intuition for this. |

**Pattern**: Agents use tools that map to things they already understand, and skip tools that are Opensteer-specific abstractions.

---

## What Agents Naturally Understand (and Use Well)

From training data, every LLM has deep intuition for:

1. **Browser actions**: open, goto, click, type, scroll — Puppeteer/Playwright/Selenium, seen millions of times
2. **DevTools Network tab**: capture traffic, filter by hostname/method, inspect request/response — every web dev tutorial
3. **`curl`/`fetch`**: "I have a URL, method, headers, body — call it" — universal HTTP knowledge
4. **JavaScript evaluation**: "run arbitrary code in the browser" — the ultimate escape hatch
5. **Screenshots/snapshots**: "look at the page" — visual debugging

Steps 1-3 of the framework map directly to items 1-3 above. That's why they worked. Steps 4-9 have no analogue. That's why they were skipped.

---

## The Design Tension

The framework was designed for **production-grade, deterministic API integration**:
- Versioned request plans with parameter annotation
- Auth recipes with failure recovery
- Transport portability testing
- Plan -> Execute lifecycle with validation

But agents operate in **exploratory, one-shot mode**:
- "Find the API and call it"
- "Get me the data"
- "Write a script that works"

These are fundamentally different goals. The 9-phase pipeline is the right design for a human building a production integration. It's the wrong design for an agent doing a one-off reverse engineering task.

---

## Ideas — From Lightest Touch to Full Overhaul

### Idea 1: Embed Next-Step Guidance in Command Output (lightest touch)

The agent stopped following the workflow after `network detail` because nothing told it what to do next. What if every command's output included a one-line "next step"?

```
$ opensteer network detail rec_123 --workspace demo
URL: PUT https://www.zillow.com/async-create-search-page-state
Status: 200 (916KB JSON, 797 listings)
Headers: content-type: application/json, ...
...

-> Next: opensteer replay rec_123 --workspace demo
   (Tests transport portability — tells you if this API needs a browser or works standalone)
```

This is how `git status` works — it always tells you the next command. Agents follow output-embedded hints much more reliably than documentation they read once.

**Cost**: Low — just change output formatting.
**Impact**: Medium — addresses the "what do I do after detail?" gap.

---

### Idea 2: Rename `replay` to Something Self-Explanatory

"Replay" sounds like "do the same thing again." The agent thought "I can do that myself with fetch." But `replay` actually means "test which transport works for this API."

Candidates:
- `opensteer probe rec_123` — "test this API's requirements"
- `opensteer test-api rec_123` — most self-explanatory
- `opensteer try rec_123` — lightweight, implies experimentation

When an agent sees `test-api` after `network detail`, the connection is obvious: "I found the API, now let me test it." With `replay`, the connection is opaque.

**Cost**: Low — rename + alias.
**Impact**: High — directly addresses why agents skip this step.

---

### Idea 3: Make `network detail` Auto-Probe Transport

What if `network detail` didn't just show you the request — it also tested it?

```
$ opensteer network detail rec_123 --workspace demo

URL: PUT https://www.zillow.com/async-create-search-page-state
Status: 200 (916KB JSON)
...

Transport probe:
  direct-http:  X 403 Forbidden (PerimeterX blocked)
  matched-tls:  X 403 Forbidden
  page-http:    OK 200 OK (916KB, 797 listings)

-> This API requires a live browser session.
-> SDK: opensteer.fetch(url, { transport: "page", method: "PUT", body: { json: payload } })
```

Now the agent never needs to know `replay` exists. The information it needs — which transport works — is delivered as part of the inspection it already does naturally.

**Cost**: Medium — changes `network detail` semantics, adds latency.
**Impact**: Very high — eliminates the entire "step 4" problem.

---

### Idea 4: Make `fetch` Auto-Discover from Captured Traffic

The agent tried `fetch` with wrong flags and gave up. What if `fetch` was smarter?

```ts
// Agent writes this (natural instinct):
const response = await opensteer.fetch(
  "https://www.zillow.com/async-create-search-page-state",
  { method: "PUT", body: { json: searchPayload } }
);

// Opensteer internally:
// 1. Checks if this URL matches a captured network record
// 2. If yes, uses that record's headers/cookies/transport
// 3. Auto-selects transport (tries direct -> matched-tls -> page)
// 4. Returns response
```

The agent's natural instinct — "I have the URL, let me fetch it" — would just work. The framework handles transport selection, header matching, and cookie attachment transparently.

This is the **"make the naive thing work" principle**. Instead of requiring the agent to follow a 9-step pipeline to eventually reach `opensteer.fetch()` with the right transport, make the first thing they try succeed.

**Cost**: Medium-high — significant changes to fetch internals.
**Impact**: Transformative — eliminates the entire pipeline for the common case.

---

### Idea 5: Two-Tier API Surface (Agent vs. Production)

Strip the SDK down to two tiers:

**Tier 1 — Agent tier** (~15 methods, what agents naturally use):
```ts
// Browser
opensteer.open(url)
opensteer.goto(url, { capture?: "label" })
opensteer.close()

// Page
opensteer.snapshot("action" | "extraction")
opensteer.click({ element, persist? })
opensteer.input({ element, text, persist?, pressEnter? })
opensteer.scroll({ direction, amount })
opensteer.extract({ persist, schema? })
opensteer.evaluate(script)

// Network (the core of reverse engineering)
opensteer.network.query({ capture, ...filters })
opensteer.network.detail(recordId)       // auto-probes transport
opensteer.network.replay(recordId, overrides?)

// Request (just works)
opensteer.fetch(url, options?)           // auto-discovers transport

// State
opensteer.cookies(domain?)
opensteer.state(domain?)
```

**Tier 2 — Production tier** (everything else, opt-in):
```ts
// Request plans
opensteer.plans.infer(recordId, key, version)
opensteer.plans.write(key, version, payload)
opensteer.plans.execute(key, params?)

// Recipes
opensteer.recipes.write(key, steps)
opensteer.recipes.run(key, variables?)

// Auth
opensteer.auth.writeRecipe(...)
opensteer.auth.run(...)

// Advanced
opensteer.route(...)
opensteer.interceptScript(...)
opensteer.reversePackage(...)
```

The SKILL.md would only teach Tier 1. Tier 2 would be a separate "production hardening" guide that humans read, not agents.

**Cost**: High — restructure SDK, rewrite skill file.
**Impact**: Transformative — agents see 15 methods instead of 66.

---

### Idea 6: Kill the Multi-Step Pipeline, Replace with One Command

The most radical option. What if the entire reverse engineering workflow was:

```bash
# Step 1: Open and trigger the action (agent already does this naturally)
opensteer open https://www.zillow.com --workspace zillow
opensteer goto https://www.zillow.com/san-francisco-ca/ --workspace zillow --capture-network search

# Step 2: ONE command that does everything
opensteer discover --capture search --workspace zillow
```

Where `discover` does:
1. Queries captured traffic
2. Identifies the most likely API endpoint (largest JSON response, first-party hostname)
3. Probes transport (direct -> matched-tls -> page)
4. Returns a complete summary:

```
Discovered: PUT /async-create-search-page-state
Transport: page-http (direct blocked by PerimeterX)
Response: 200 OK, 916KB JSON
  Shape: { cat1: { searchResults: { listResults: [...797 items] } } }
  Key fields: zpid, address, price, beds, baths, sqft

Variable parameters detected:
  body.searchQueryState.regionSelection[0].regionId  (currently: 20330)
  body.searchQueryState.mapBounds                    (currently: SF coordinates)
  body.searchQueryState.pagination                   (currently: {})

SDK template:
  const response = await opensteer.fetch(
    "https://www.zillow.com/async-create-search-page-state",
    { transport: "page", method: "PUT", body: { json: { ... } } }
  );
```

The agent's entire job becomes: open -> trigger action -> `discover` -> copy the SDK template into their script. Three commands. Zero framework-specific concepts to learn.

**Cost**: Very high — new command with significant intelligence.
**Impact**: Would fundamentally change agent success rate.

---

### Idea 7: Align with `evaluate` Instead of Fighting It

The agent used `evaluate` 9+ times because it's the tool it trusts most. Instead of treating this as a failure, what if you made `evaluate` the *primary* API testing tool?

```bash
# Instead of teaching agents about replay/fetch/transport...
opensteer evaluate "await opensteer.testApi('rec_123')" --workspace demo
```

Or inject an `opensteer` helper object into the page context:
```bash
opensteer evaluate "
  const api = await __opensteer__.replayRequest('rec_123');
  return { status: api.status, transport: api.transport, data: api.json() };
" --workspace demo
```

This feels unorthodox, but it meets the agent where it is. The agent wants to run JS in the browser. Let it — but give it framework-powered helpers inside that JS context.

**Cost**: Medium — inject helper into page.
**Impact**: Medium — works with agent instincts but still requires learning the helper API.

---

## Recommendation: Layered Approach

Do ideas **1 + 2 + 3 + 5** together:

1. **Embed next-step hints in output** (Idea 1) — costs almost nothing, immediately helps
2. **Rename `replay` to `probe` or `test-api`** (Idea 2) — makes the tool self-explanatory
3. **Auto-probe transport in `network detail`** (Idea 3) — eliminates the step agents skip most
4. **Two-tier API surface** (Idea 5) — reduces cognitive load from 66 methods to 15

Together, these changes mean the agent workflow becomes:

```
open -> goto (capture) -> network query -> network detail (auto-probes!) -> write SDK with fetch
```

That's 5 steps that all map to concepts agents already understand. No plans, no recipes, no transport selection, no auth validation. Those stay available for production hardening but are invisible to the default agent workflow.

---

## Key Principle

**Don't add tools to compensate for agent behavior — remove tools that fight agent instincts.**

The agent that reverse-engineered Zillow proved that `open` / `goto` / `snapshot` / `input` / `capture` / `query` / `detail` is a workflow agents can execute. Everything after that is where they fall off. So make "everything after that" automatic, not manual.
