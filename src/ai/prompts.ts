export function buildResolveSystemPrompt(): string {
    return `You identify interactive HTML elements in a page snapshot. Each element is annotated with a counter attribute c="N". Your job is to find the element that best matches the user's description for a given action.

Respond with a JSON object:
- "element": the counter number (integer) of the matching element, or -1 if no match
- "confidence": a number from 0 to 1 indicating how confident you are
- "reasoning": a brief explanation of why you chose this element

Only select elements that are interactive and relevant to the action described.`
}

export function buildResolveUserPrompt(args: {
    action: string
    description: string
    url: string | null
    html: string
}): string {
    const parts = [`Action: ${args.action}`, `Description: ${args.description}`]
    if (args.url) {
        parts.push(`URL: ${args.url}`)
    }
    parts.push('', 'Page HTML:', args.html)
    return parts.join('\n')
}

export function buildExtractSystemPrompt(): string {
    return `You extract structured data from HTML page snapshots. Each element is annotated with a counter attribute c="N".

You will receive a schema describing the fields to extract. For each leaf field in the schema, return a value descriptor that identifies both the source element and, when needed, the specific attribute.

Respond with ONLY a JSON object (no markdown, no explanation):
- "contains_data": boolean indicating whether the page contains the requested data
- "data": an object matching the schema structure where each leaf value is one of:
  - integer counter N -> extract textContent from element c="N"
  - object { "$c": N, "$a": "attributeName" } -> extract that attribute from element c="N"
  - string "CURRENT_URL" -> use the current page URL
  - null -> field not found

Rules:
- Use integer counters for text extraction
- Use { "$c": N, "$a": "..." } only when the value must come from an attribute (e.g. href, src, value, content)
- When a field expects a single image URL and both src and srcset exist, prefer "$a": "src" over "$a": "srcset"
- Use "CURRENT_URL" only when the field explicitly asks for the current page URL
- If a field's data is not found on the page, return null
- For array fields, expand to include ALL matching items on the page
- Do not infer URL/image/input behavior from field names; encode it explicitly with "$a" when needed`
}

export function buildExtractUserPrompt(args: {
    schema: unknown
    description?: string
    prompt?: string
    url: string | null
    html: string
}): string {
    const parts: string[] = []

    if (args.description) {
        parts.push(`Description: ${args.description}`)
    }
    if (args.prompt) {
        parts.push(`Instructions: ${args.prompt}`)
    }
    if (args.url) {
        parts.push(`URL: ${args.url}`)
    }
    parts.push(
        '',
        'Schema:',
        JSON.stringify(args.schema, null, 2),
        '',
        'Page HTML:',
        args.html
    )
    return parts.join('\n')
}
