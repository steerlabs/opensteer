import { Opensteer } from "./dist/index.js";

const opensteer = new Opensteer({ 
  name: "yc-scraper",
  cursor: { enabled: true }
});

try {
  await opensteer.launch();
  
  // Navigate to YCombinator
  await opensteer.goto("https://www.ycombinator.com");
  
  // Take snapshot and click on Companies link
  await opensteer.snapshot({ mode: "action" });
  await opensteer.click({ description: "Companies link" });
  
  // Wait a moment for page to load
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Take snapshot and search for AI
  await opensteer.snapshot({ mode: "action" });
  await opensteer.input({ description: "search input", text: "AI" });
  
  // Wait for search results
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Take extraction snapshot
  await opensteer.snapshot({ mode: "extraction" });
  
  // Extract companies
  const companies = await opensteer.extract({
    description: "list of AI companies",
    schema: {
      companies: [{
        name: "string",
        description: "string",
        batch: "string"
      }]
    }
  });
  
  console.log("\n=== AI Companies from YCombinator ===\n");
  console.log(JSON.stringify(companies, null, 2));
  
} finally {
  await opensteer.close();
}
