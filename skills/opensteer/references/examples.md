# Opensteer Examples

## Full Workflow: CLI Exploration to Scraper Script

### Step 1: Explore and cache with CLI

```bash
export OPENSTEER_SESSION=eures-session

opensteer open https://europa.eu/eures/portal/jv-se/home --name "eures-jobs"

opensteer snapshot action
opensteer input 5 "software engineer" --pressEnter --description "the job search input"
opensteer click 12 --description "the search button"

# Wait for results, then extract job listings
opensteer snapshot extraction
opensteer extract '{"jobs":[{"title":{"element":20},"company":{"element":22},"url":{"element":20,"attribute":"href"}},{"title":{"element":35},"company":{"element":37},"url":{"element":35,"attribute":"href"}},{"title":{"element":50},"company":{"element":52},"url":{"element":50,"attribute":"href"}}]}' \
  --description "job listing with title company and url"

# Cache detail page extraction too
opensteer click 20 --description "first job link"
opensteer snapshot extraction
opensteer extract '{"title":{"element":3},"company":{"element":7},"location":{"element":12},"description":{"element":18}}' \
  --description "job detail page"

opensteer close
```

### Step 2: Generate replay script (same namespace, same descriptions)

```typescript
import { Opensteer } from "opensteer";

async function run() {
  const opensteer = new Opensteer({
    name: "eures-jobs",
    storage: { rootDir: process.cwd() },
  });

  await opensteer.launch({ headless: false });

  try {
    await opensteer.goto("https://europa.eu/eures/portal/jv-se/home");

    await opensteer.input({
      text: "software engineer",
      description: "the job search input",
    });
    await opensteer.click({ description: "the search button" });

    await opensteer.waitForText("Showing 1 to 10");

    // Extract all job listings using cached description — no schema needed
    const listings = await opensteer.extract({
      description: "job listing with title company and url",
    });

    // Visit each detail page and extract using cached description
    for (const job of listings.jobs) {
      await opensteer.goto(job.url);
      await opensteer.page.waitForSelector("h1");

      const detail = await opensteer.extract({
        description: "job detail page",
      });
      console.log(JSON.stringify(detail, null, 2));
    }
  } finally {
    await opensteer.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## API-Based Extraction

When a site has internal APIs (REST, GraphQL, Algolia), navigate first for cookies, then use `fetch()` inside `page.evaluate()`. This is the only valid use of `page.evaluate()` for data.

```typescript
import { Opensteer } from "opensteer";

async function run() {
  const opensteer = new Opensteer({
    name: "api-scraper",
    storage: { rootDir: process.cwd() },
  });

  await opensteer.launch({ headless: false });

  try {
    // Navigate first to establish session cookies
    await opensteer.goto("https://example.com");

    const data = await opensteer.page.evaluate(async () => {
      const res = await fetch("https://api.example.com/search?q=shoes&limit=100", {
        headers: { "Content-Type": "application/json" },
      });
      return res.json();
    });

    console.log(JSON.stringify(data, null, 2));
  } finally {
    await opensteer.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```
