export function getHelpText(): string {
  return `Opensteer CLI

Session:
  open <url> [--workspace <id>] [--headless] [--provider local|cloud]
  close
  status
  view [--workspace <id>] [--json]

Navigation:
  goto <url> [--capture-network <label>]

DOM:
  snapshot [action|extraction]
  click <element> [--button left|middle|right] [--persist <key>] [--capture-network <label>]
  hover <element> [--persist <key>] [--capture-network <label>]
  input <element> <text> [--press-enter] [--persist <key>] [--capture-network <label>]
  scroll <direction> <amount> [--element <n>] [--persist <key>] [--capture-network <label>]
  extract <schema> [--persist <key>]
  evaluate <script>
  init-script <script>

Tabs:
  tab list
  tab new [url]
  tab <n>
  tab close [n]

Network:
  network query [--capture <label>] [--url <pattern>] [--hostname <host>] [--path <path>] [--method <m>] [--status <code>] [--type <resourceType>] [--json] [--before <id>] [--after <id>] [--limit <n>]
    --json filters to JSON and GraphQL responses only
  network detail <recordId> [--probe]
  fetch <url> [--method <m>] [--header key=value ...] [--query key=value ...] [--body <json>] [--body-text <text>] [--transport auto|direct|matched-tls|context|page] [--cookies] [--follow-redirects]

Browser State:
  state [domain]

SDK:
  exec <expression>   Run JS with the Opensteer SDK as 'this'. Supports await.

Computer:
  computer click <x> <y> [--button left|right|middle] [--count <n>] [--modifiers Shift,Control,Alt,Meta] [--capture-network <label>]
  computer type <text> [--capture-network <label>]
  computer key <key> [--modifiers Shift,Control,Alt,Meta] [--capture-network <label>]
  computer scroll <x> <y> --dx <n> --dy <n> [--capture-network <label>]
  computer move <x> <y> [--capture-network <label>]
  computer drag <x1> <y1> <x2> <y2> [--steps <n>] [--capture-network <label>]
  computer screenshot [--format png|jpeg|webp]
  computer wait <ms>

Advanced:
  captcha solve --provider 2captcha|capsolver --api-key <key> [--type recaptcha-v2|hcaptcha|turnstile] [--site-key <key>] [--page-url <url>] [--timeout <ms>]
  scripts capture [--url-filter <pattern>] [--persist] [--inline] [--external] [--dynamic] [--workers]
  scripts beautify <artifactId> [--persist]
  scripts deobfuscate <artifactId> [--persist]
  scripts sandbox <artifactId> [--fidelity minimal|standard|full] [--timeout <ms>] [--clock real|manual] [--cookies <json>] [--globals <json>] [--ajax-routes <json>]
  interaction capture [--key <name>] [--duration <ms>] [--script <js>] [--include-storage] [--include-session-storage] [--include-indexed-db] [--global-names <list>] [--case-id <id>] [--notes <text>] [--tags <list>]
  interaction get <traceId>
  interaction replay <traceId>
  interaction diff <leftTraceId> <rightTraceId>
  artifact read <artifactId>

Options:
  --workspace <id>        Required for stateful commands (or set OPENSTEER_WORKSPACE)
  --capture-network <l>   Record network traffic during an action
  --help, --version
`;
}
