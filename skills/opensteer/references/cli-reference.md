# Opensteer CLI Command Reference

All commands output JSON. Set session once per shell:

```bash
export OPENSTEER_SESSION=my-session
# Or for non-interactive runners:
export OPENSTEER_CLIENT_ID=agent-1
```

Global flags: `--session <id>`, `--name <namespace>`, `--headless`, `--description <text>`.

## Navigation

```bash
opensteer open <url>                                # Open browser, navigate to URL
opensteer open <url> --name "my-scraper"            # Set selector cache namespace
opensteer open <url> --headless                     # Headless mode
opensteer open --connect-url http://localhost:9222   # Connect to running browser
opensteer navigate <url>                            # Navigate with visual stability wait
opensteer navigate <url> --timeout 60000            # Custom timeout (default 30s)
opensteer back                                      # Go back in history
opensteer forward                                   # Go forward in history
opensteer reload                                    # Reload page
opensteer close                                     # Close browser and stop server
opensteer close --all                               # Close all active sessions
opensteer sessions                                  # List active sessions
opensteer status                                    # Show resolved session/name state
```

`open` does raw `page.goto()` (no stability wait). `navigate` includes `waitForVisualStability`. Use `open` once to start, then `navigate` for subsequent pages.

## Observation

```bash
opensteer snapshot action           # Same as above (explicit)
opensteer snapshot extraction       # Flattened HTML for data scraping
opensteer snapshot clickable        # Only clickable elements
opensteer snapshot scrollable       # Only scrollable containers
opensteer snapshot full             # Minimal cleaning, full HTML
opensteer state                     # URL + title + cleaned HTML
opensteer screenshot                # Save screenshot to screenshot.png
opensteer screenshot output.png     # Save to specific file
opensteer screenshot --fullPage     # Full page screenshot
```

## Actions

First positional argument is element counter (`c="N"` from snapshot).

```bash
opensteer click 5                                   # Click by counter
opensteer click --description "the submit button"   # By cached description
opensteer click 5 --button right                    # Right-click
opensteer click 5 --clickCount 2                    # Double-click
opensteer hover 4                                   # Hover over element
opensteer hover --description "the user menu"       # Hover by description
```

## Input

```bash
opensteer input 3 "Hello"                           # Type into element (clears first)
opensteer input 3 "Hello" --clear false             # Append text
opensteer input 3 "query" --pressEnter              # Type and press Enter
opensteer input --description "the search input" --text "query" --pressEnter
```

## Select / Scroll

```bash
opensteer select 9 --label "Option A"              # Select by visible label
opensteer select 9 --value "opt-a"                  # Select by value attribute
opensteer select 9 --index 2                        # Select by index
opensteer scroll                                    # Scroll page down (default)
opensteer scroll --direction up                     # Scroll up
opensteer scroll --direction down --amount 1000
opensteer scroll 12                                 # Scroll within container element
```

## Keyboard

```bash
opensteer press Enter
opensteer press Tab
opensteer press Escape
opensteer press "Control+a"
opensteer type "Hello World"                        # Type into focused element
```

## Element Info

```bash
opensteer get-text 5                                # Get element text content
opensteer get-text --description "the heading"
opensteer get-value 3                               # Get input/textarea value
opensteer get-attrs 5                               # Get all HTML attributes
opensteer get-html                                  # Full page HTML
opensteer get-html "main"                           # HTML of element matching selector
```

## Tabs

```bash
opensteer tabs                                      # List open tabs with indices
opensteer tab-new                                   # Open new blank tab
opensteer tab-new https://example.com               # Open URL in new tab
opensteer tab-switch 0                              # Switch to tab by index
opensteer tab-close                                 # Close current tab
opensteer tab-close 2                               # Close specific tab
```

## Cookies

```bash
opensteer cookies                                   # Get all cookies
opensteer cookies --url https://example.com         # Cookies for specific URL
opensteer cookie-set --name token --value abc123
opensteer cookies-clear                             # Clear all cookies
opensteer cookies-export /tmp/cookies.json          # Export to file
opensteer cookies-import /tmp/cookies.json          # Import from file
```

## Utility

```bash
opensteer eval "document.title"                     # Execute JS in page
opensteer wait-for "Success"                        # Wait for text to appear
opensteer wait-for "Success" --timeout 5000
opensteer wait-selector "h1"                        # Wait for selector to appear
```

## Data Extraction

### Counter-based (preferred)

```bash
opensteer snapshot extraction
# `schema-json` describes the output shape. It can use explicit bindings or semantic placeholders.

# Explicit field bindings from observed counters/attributes:
opensteer extract '{"title":{"element":3},"price":{"element":7}}'
opensteer extract '{"url":{"element":5,"attribute":"href"}}'
opensteer extract '{"pageUrl":{"source":"current_url"},"title":{"element":3}}'

# Explicit array bindings: include multiple items to identify the repeating pattern
opensteer extract '{"results":[{"title":{"element":11},"url":{"element":10,"attribute":"href"}},{"title":{"element":16},"url":{"element":15,"attribute":"href"}}]}'

# Semantic extraction: use the output shape plus description/prompt
opensteer extract '{"title":"string","price":"string"}' --description "product details"
opensteer extract '{"images":[{"imageUrl":"string","alt":"string","caption":"string","credit":"string"}]}' \
  --description "article images with captions and credits" \
  --prompt "For each image, return the image URL, alt text, caption, and credit. Prefer caption and credit from the same figure. If missing, look at sibling text, then parent/container text, then nearby alt/data-* attributes."
```

Use explicit bindings when you need deterministic element-to-field mappings. Use semantic extraction when the fields require relationship inference or fallback rules. `--prompt` is the place to describe those rules.
