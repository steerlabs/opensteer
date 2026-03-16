import { readFileSync } from "fs";
import * as cheerio from "cheerio";

const rawHtml = readFileSync("/tmp/debug-rawHtml.html", "utf8");

function hasHiddenOnHtml(html: string): boolean {
  const $ = cheerio.load(html, { xmlMode: false });
  return $("html").attr("data-opensteer-hidden") !== undefined;
}

console.log("Full HTML:", hasHiddenOnHtml(rawHtml));

// Find the body tag position
const bodyStart = rawHtml.indexOf("<body");
const bodyEnd = rawHtml.indexOf("</body>");
const htmlEnd = rawHtml.indexOf("</html>");

console.log("\nbodyStart:", bodyStart);
console.log("bodyEnd:", bodyEnd);
console.log("htmlEnd:", htmlEnd);

// Test: just html+head+body structure (no body content)
const headEnd = rawHtml.indexOf("</head>");
const justStructure = rawHtml.slice(0, headEnd + 7) + "<body></body></html>";
console.log("\nJust structure (no body content):", hasHiddenOnHtml(justStructure));

// Test: html + head + body with first half of body content
const bodyContentStart = rawHtml.indexOf(">", bodyStart) + 1;
const bodyContent = rawHtml.slice(bodyContentStart, bodyEnd);
const midBody = Math.floor(bodyContent.length / 2);

// Test with first quarter of body
for (const fraction of [0.1, 0.25, 0.5, 0.75, 1.0]) {
  const cutoff = Math.floor(bodyContent.length * fraction);
  const partial = rawHtml.slice(0, bodyContentStart) + bodyContent.slice(0, cutoff) + "</body></html>";
  const result = hasHiddenOnHtml(partial);
  if (result) {
    console.log(`\nBody content ${(fraction * 100).toFixed(0)}% (${cutoff} chars): HAS hidden on html`);

    // Narrow down further
    if (fraction <= 0.1) {
      for (const finer of [0.01, 0.02, 0.03, 0.05, 0.08]) {
        const fineCutoff = Math.floor(bodyContent.length * finer);
        const finePartial = rawHtml.slice(0, bodyContentStart) + bodyContent.slice(0, fineCutoff) + "</body></html>";
        console.log(`  Body ${(finer * 100).toFixed(1)}% (${fineCutoff} chars): ${hasHiddenOnHtml(finePartial)}`);
      }
    }
    break;
  } else {
    console.log(`Body content ${(fraction * 100).toFixed(0)}% (${cutoff} chars): no hidden`);
  }
}

// Binary search within body content
let low = 0, high = bodyContent.length;
while (high - low > 100) {
  const mid = Math.floor((low + high) / 2);
  const partial = rawHtml.slice(0, bodyContentStart) + bodyContent.slice(0, mid) + "</body></html>";
  if (hasHiddenOnHtml(partial)) {
    high = mid;
  } else {
    low = mid;
  }
}

console.log(`\nNarrowed to body content chars ${low}-${high}`);
const criticalContent = bodyContent.slice(Math.max(0, low - 200), high + 200);
console.log("Critical content around the boundary:");
console.log(criticalContent.slice(0, 1000));
