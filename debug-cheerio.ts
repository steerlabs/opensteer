/**
 * Test if cheerio.load() is causing the data-opensteer-hidden to appear on <html>.
 */
import { readFileSync } from "fs";
import * as cheerio from "cheerio";

const rawHtml = readFileSync("/tmp/debug-rawHtml.html", "utf8");

console.log("Raw HTML starts with:", rawHtml.slice(0, 200));
console.log("\nRaw HTML has data-opensteer-hidden on <html>:", rawHtml.slice(0, 100).includes("data-opensteer-hidden"));

// Step 1: Just load and serialize
const $ = cheerio.load(rawHtml, { xmlMode: false });
const htmlEl = $("html");

console.log("\nAfter cheerio.load:");
console.log("  <html> attrs:", JSON.stringify(htmlEl.attr()));
console.log("  has data-opensteer-hidden:", htmlEl.attr("data-opensteer-hidden"));

// Check the serialized output
const output = $.html();
console.log("\nSerialized output starts with:", output.slice(0, 200));
console.log("Serialized has data-opensteer-hidden on first line:", output.slice(0, 200).includes("data-opensteer-hidden"));

// Let me check if the raw HTML has ANY data-opensteer-hidden and where
const positions: number[] = [];
let searchFrom = 0;
while (true) {
  const pos = rawHtml.indexOf("data-opensteer-hidden", searchFrom);
  if (pos === -1) break;
  positions.push(pos);
  searchFrom = pos + 1;
}
console.log(`\ndata-opensteer-hidden appears ${positions.length} times in raw HTML`);
for (const pos of positions.slice(0, 5)) {
  const context = rawHtml.slice(Math.max(0, pos - 80), pos + 40);
  console.log(`  At position ${pos}: ...${context}...`);
}

// Check the first occurrence - what element has it?
if (positions.length > 0) {
  // Find the enclosing tag
  const firstPos = positions[0]!;
  const beforeFirst = rawHtml.slice(Math.max(0, firstPos - 500), firstPos);
  const lastOpenTag = beforeFirst.lastIndexOf("<");
  if (lastOpenTag >= 0) {
    const tagContext = beforeFirst.slice(lastOpenTag) + rawHtml.slice(firstPos, firstPos + 50);
    console.log(`\nFirst hidden element context:\n  ${tagContext.slice(0, 300)}`);
  }
}
