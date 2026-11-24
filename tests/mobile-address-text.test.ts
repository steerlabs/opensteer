import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

/*
 * How the phone draws an email address, a host or a URL (`apps/mobile/src/ui/address-text.tsx`),
 * held over every file of the app by two rules.
 *
 * 1. The drawn form never leaves the component that draws it. `addressWords` makes characters that
 *    are not the address (word joiners and zero-width spaces); only the drawing components may call
 *    it, and none of them hands its result to a screen reader. Everything else carries the plain
 *    value, so a selection, a copy, an accessibility label, an announcement or an alert gets the
 *    address exactly.
 * 2. No address is drawn raw. In a screen: a value whose name says it is an address (`email`,
 *    `origin`, `host`, `url`, `site`, `domain`, `username`, …), or one an origin helper returned,
 *    put in a text's children, in a prop a row draws, or in an alert. In a model (`.ts`): such a
 *    value in a native row's text, or joined into a sentence's string, where it belongs in parts
 *    (`sentence-parts.ts`).
 *
 * 3. A one-line host (`HostLine`) is only where no one decides anything about the site: it may give up
 *    labels from its left. Where a person decides something about a site (a page's dialog, a
 *    consent, a sign-in), the whole origin is drawn (`AddressText`, `AddressSentence`).
 *    `hostLineFiles` names each file that may use it, and why it is not a decision.
 * 4. A sentence assembled elsewhere from data is made of parts where it is said. The sentences the
 *    phone draws are often built in `packages/client` and reach it as `text`, a name that says
 *    nothing: build 9's walk saw the GitHub plugin's consent hyphenated inside its hosts. So in
 *    `packages/client`, drawn words (`text`, `title`, `label`, …) that join an address are made
 *    with `sentence` (`said.ts`), the address a slot known as one; a plain template joining one is a
 *    failure. `knownJoinedSentences` lists those still drawn raw, each with why it may be.
 * 5. No address is found by searching words. A sentence's parts are what they were made as; a
 *    search of finished words for an address (an `indexOf`, a split, a pattern) can take a name
 *    that holds a host for the address, as the re-check after build 9 showed. In the app and in
 *    `packages/client`, nothing searches for an address in words.
 *
 * What it reads is names: a value built elsewhere under a name that says nothing is not seen.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const mobileSource = path.join(repositoryRoot, "apps/mobile/src");

/** The only files that may call `addressWords`, each because it draws what it decorates. */
export const drawingFiles: Readonly<Record<string, string>> = {
  "apps/mobile/src/ui/address-text.tsx":
    "React Native: AddressText and AddressSentence draw an address, alone or inline in a sentence",
  "apps/mobile/src/screens/settings-form-primitives.ios.tsx":
    "SwiftUI: Lines draws the line a row marks as an address (`addressIn`)",
  "apps/mobile/src/screens/native-settings-page.ios.tsx":
    "SwiftUI: a status row draws its address detail, with Copy of the plain value in its menu",
  "apps/mobile/src/screens/settings-form-primitives.android.tsx":
    "Compose: a row draws the line marked as an address, its spoken words the plain value",
};

/** The only files that may draw a one-line host, each with why no one decides there. */
export const hostLineFiles: Readonly<Record<string, string>> = {
  "apps/mobile/src/browser/address-bar.tsx":
    "the bar names the page shown, and a press opens the field with the whole address; the switch-to-tab suggestion goes to a tab already open",
  "apps/mobile/src/tabs/tab-list.tsx":
    "a tab's row names its site beside its title; opening the tab decides nothing about the site",
  "apps/mobile/src/thread/live-place.tsx":
    "the cover of a page still loading names its site; nothing is asked of the person",
  "apps/mobile/src/thread/surface-chips.tsx":
    "a thread's chip names the page or app an agent works in; a press opens it, nothing more",
};

/** A name that says the value is an address, a host or a URL: whole, or as its camelCase end. */
const addressName =
  /^(?:email|url|uri|href|origin|host|hostname|domain|site|endpoint|address|issuer|signedInAs|username)$|(?:Email|Url|Uri|Href|Origin|Host|Hostname|Domain|Site|Endpoint|Address|Issuer|Username)$/u;
/** Word tables (`welcomeCopy.address`) hold a label about addresses, not one. */
const copyTable = /Copy$|Words$/u;
/** Helpers whose result is an address or a host. */
const addressHelpers = new Set([
  "hostOf",
  "pageSite",
  "pageSiteLabel",
  "browserSiteLabel",
  "browserSiteDomain",
  "browserSiteForTab",
  "tabSiteLabel",
  "originOf",
  "agentWhoOriginLine",
  "cloudComputerWebsite",
]);
/** Props a row, a card or a notice draws as text. */
const drawnProps = new Set([
  "title",
  "detail",
  "subtitle",
  "label",
  "description",
  "message",
  "body",
  "caption",
  "heading",
  "words",
  "line",
]);
/** What a screen reader is handed: never the drawn form. */
const spoken = new Set(["accessibilityLabel", "accessibilityValue", "semantics"]);

/**
 * Places that put an address somewhere other than through the drawing components, on purpose.
 * Keep this short; every entry says why.
 */
export const allowed: readonly {
  readonly file: string;
  readonly snippet: string;
  readonly reason: string;
}[] = [
  {
    file: "apps/mobile/src/ui/address-text.tsx",
    snippet: "{`${before}${host}${after}`}",
    reason:
      "HostLine's unseen copy of its own line, which only measures the room it may fill: never seen, never heard",
  },
  {
    file: "apps/mobile/src/markdown/reference-link.tsx",
    snippet: "const link = { href: url, label: url };",
    reason:
      "what a long press on a message's link copies or opens: the exact address, not drawn text",
  },
  {
    file: "apps/mobile/src/markdown/reference-link.tsx",
    snippet: 'Alert.alert("Link could not be opened", url)',
    reason:
      "a system alert, which draws plain text: it carries the plain value (rule 1); not covered: " +
      "the address may wrap there as words do. A message's own links and emails stay raw too: " +
      "they are selectable text, and a copy must be exact",
  },
  {
    file: "apps/mobile/src/thread/conversation-links.tsx",
    snippet: 'Alert.alert("Link could not be opened", url)',
    reason: "a system alert, which draws plain text: it carries the plain value (rule 1)",
  },
  {
    file: "apps/mobile/src/report-mail.ts",
    snippet: 'Alert.alert("Contact support", supportEmail, [',
    reason: "a system alert, which draws plain text: it carries the plain value (rule 1)",
  },
  {
    file: "apps/mobile/src/screens/deployments.tsx",
    snippet: "`${row.kindLabel}\\n${row.origin}${",
    reason: "a system alert, which draws plain text: it carries the plain value (rule 1)",
  },
  {
    file: "apps/mobile/src/screens/browser-history.tsx",
    snippet: "title={title === address ? title : `${title}, ${address}`}",
    reason: "the title of a native menu, which the system draws: it carries the plain value",
  },
  {
    file: "apps/mobile/src/browser/browser-page.tsx",
    snippet: "Share.share({ message: pageUrl, url: pageUrl })",
    reason: "what the share sheet hands another app: the exact address, not drawn text",
  },
  {
    file: "apps/mobile/src/screens/settings-computer-enrollment.tsx",
    snippet: "{commands.bareHost}",
    reason: "a shell command to copy and run, selectable, not an address",
  },
  {
    file: "apps/mobile/src/screens/chrome.tsx",
    snippet: "label: `remove ${domain}`,",
    reason:
      "an action's words, which the action line says in its own sentences; not covered: the " +
      "site may wrap there as words do",
  },
];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

type Node = {
  readonly type: string;
  readonly loc?: { readonly start: { readonly line: number } };
} & Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function nameOf(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "Identifier") return node["name"] as string;
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression")
    return nameOf(node["property"] as Node);
  return undefined;
}

/** Whether `node` mentions the named identifier anywhere inside it. */
function mentions(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => mentions(child, name));
  if (!isNode(node)) return false;
  if (node.type === "Identifier" && node["name"] === name) return true;
  return Object.entries(node).some(
    ([key, value]) => key !== "loc" && typeof value === "object" && mentions(value, name),
  );
}

/** An address inside an expression drawn as text, as it is (not the drawn form). */
function rawAddress(expression: Node): Node | null {
  switch (expression.type) {
    case "Identifier":
      return addressName.test(expression["name"] as string) ? expression : null;
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const property = expression["property"] as Node;
      if (expression["computed"] || property.type !== "Identifier") return null;
      const owner = nameOf(expression["object"] as Node);
      if (owner !== undefined && copyTable.test(owner)) return null;
      return addressName.test(property["name"] as string) ? expression : null;
    }
    case "CallExpression":
    case "OptionalCallExpression": {
      const name = nameOf(expression["callee"] as Node);
      if (name === "addressWords") return null;
      return name !== undefined && addressHelpers.has(name) ? expression : null;
    }
    case "TemplateLiteral":
      for (const part of expression["expressions"] as Node[]) {
        const found = rawAddress(part);
        if (found) return found;
      }
      return null;
    case "ConditionalExpression":
      return (
        rawAddress(expression["consequent"] as Node) ?? rawAddress(expression["alternate"] as Node)
      );
    case "LogicalExpression":
    case "BinaryExpression":
      if (!["??", "||", "+"].includes(expression["operator"] as string)) return null;
      return rawAddress(expression["left"] as Node) ?? rawAddress(expression["right"] as Node);
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return rawAddress(expression["expression"] as Node);
    default:
      return null;
  }
}

/** A sentence's string with an address joined into it: `${single.name} is signed in to ${domain}`. */
function joinedSentence(expression: Node): Node | null {
  if (expression.type !== "TemplateLiteral") return null;
  const quasis = (expression["quasis"] as Node[])
    .map((quasi) => (quasi["value"] as { raw: string }).raw)
    .join("");
  return quasis.trim() === "" ? null : rawAddress(expression);
}

function elementName(opening: Node): string {
  const name = opening["name"] as Node;
  return name.type === "JSXIdentifier"
    ? (name["name"] as string)
    : name.type === "JSXMemberExpression"
      ? ((name["property"] as Node)["name"] as string)
      : "";
}

/** Whether an object or a JSX element says which of its texts is an address (`addressIn`). */
function marksAddress(members: readonly Node[]): boolean {
  return members.some(
    (member) =>
      (member.type === "JSXAttribute" && (member["name"] as Node)["name"] === "addressIn") ||
      mentions(member, "addressIn") ||
      mentions(member, "addressDetail"),
  );
}

function parseSource(source: string, file: string) {
  return parse(source, {
    plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    sourceType: "module",
  });
}

/** Rule 1: every use of `addressWords` in a file that does not draw what it decorates. */
export function drawnFormLeaks(file: string, source: string): Finding[] {
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const report = (node: Node) => {
    const line = node.loc?.start.line ?? 0;
    findings.push({ file, line, snippet: (lines[line - 1] ?? "").trim() });
  };
  // Where it is made, and where it is drawn.
  if (file === "apps/mobile/src/ui/address-words.ts") return [];
  const drawing = file in drawingFiles;
  const visit = (node: unknown, speaking: boolean): void => {
    if (Array.isArray(node)) return node.forEach((child) => visit(child, speaking));
    if (!isNode(node)) return;
    if (node.type === "Identifier" && node["name"] === "addressWords") {
      // Outside a drawing file, any mention; inside one, any that reaches a screen reader.
      if (!drawing || speaking) report(node);
      return;
    }
    const speaks =
      (node.type === "JSXAttribute" &&
        spoken.has(((node["name"] as Node)["name"] as string) ?? "")) ||
      ((node.type === "CallExpression" || node.type === "ObjectProperty") &&
        (spoken.has(nameOf(node["callee"] as Node) ?? "") ||
          spoken.has(nameOf(node["key"] as Node) ?? "") ||
          nameOf(node["callee"] as Node) === "announceForAccessibility" ||
          nameOf(node["key"] as Node) === "contentDescription"));
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && typeof value === "object") visit(value, speaking || speaks);
  };
  visit(parseSource(source, file).program, false);
  return findings;
}

/** Rule 2: every address a file draws raw. */
export function rawAddressesIn(file: string, source: string): Finding[] {
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const report = (node: Node) => {
    const line = node.loc?.start.line ?? 0;
    findings.push({ file, line, snippet: (lines[line - 1] ?? "").trim() });
  };
  const model = file.endsWith(".ts");
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === "JSXElement") {
      const opening = node["openingElement"] as Node;
      const attributes = opening["attributes"] as Node[];
      const name = elementName(opening);
      // The drawing components take the plain value: what they draw is theirs.
      const drawsAddress =
        name === "AddressText" ||
        name === "CopyableAddressText" ||
        name === "HostLine" ||
        marksAddress(attributes);
      for (const attribute of attributes) {
        if (attribute.type !== "JSXAttribute") continue;
        const value = attribute["value"] as Node | null;
        const attributeName = (attribute["name"] as Node)["name"] as string;
        if (
          !drawsAddress &&
          value?.type === "JSXExpressionContainer" &&
          drawnProps.has(attributeName)
        ) {
          const found = rawAddress(value["expression"] as Node);
          if (found) report(found);
        }
      }
      for (const child of node["children"] as Node[])
        if (child.type === "JSXExpressionContainer") {
          const found = rawAddress(child["expression"] as Node);
          if (found) report(found);
        }
    }
    if (node.type === "CallExpression" && nameOf(node["callee"] as Node) === "alert") {
      for (const argument of node["arguments"] as Node[]) {
        const found = rawAddress(argument);
        if (found) report(found);
      }
    }
    if (node.type === "ObjectExpression") {
      const properties = node["properties"] as Node[];
      // A native row (it has a kind) draws its label and detail; a row that marks its address
      // draws that one as an address.
      const row = properties.some((property) => nameOf(property["key"] as Node) === "kind");
      const marked = marksAddress(properties);
      for (const property of properties) {
        if (property.type !== "ObjectProperty" || property["computed"]) continue;
        const key = nameOf(property["key"] as Node);
        if (key === undefined || !drawnProps.has(key)) continue;
        const value = property["value"] as Node;
        // A model's own field may carry the plain value: only a joined sentence is drawn wrong.
        const found = marked || (model && !row) ? joinedSentence(value) : rawAddress(value);
        if (found) report(found);
      }
    }
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && typeof value === "object") visit(value);
  };
  visit(parseSource(source, file).program);
  return findings;
}

/** Rule 3: every one-line host a file draws. */
export function hostLinesIn(file: string, source: string): Finding[] {
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === "JSXOpeningElement" && elementName(node) === "HostLine") {
      const line = node.loc?.start.line ?? 0;
      findings.push({ file, line, snippet: (lines[line - 1] ?? "").trim() });
    }
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && typeof value === "object") visit(value);
  };
  visit(parseSource(source, file).program);
  return findings;
}

/** Words a client draws from a shared model's object. */
const drawnWords = new Set([
  "activeLabel",
  "body",
  "description",
  "detail",
  "fix",
  "label",
  "message",
  "reason",
  "summary",
  "text",
  "title",
]);
/** A name that says a value is an address, or a list of them (`sites`). */
const addressesName = (name: string) =>
  addressName.test(name) || addressName.test(name.replace(/s$/u, ""));
function holdsAddress(expression: Node): boolean {
  switch (expression.type) {
    case "Identifier":
      return addressesName(expression["name"] as string);
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const property = expression["property"] as Node;
      return (
        !expression["computed"] &&
        property.type === "Identifier" &&
        addressesName(property["name"] as string)
      );
    }
    // `listText(sites)`, `hostOf(url)`: what it is given is what it says.
    case "CallExpression":
    case "OptionalCallExpression":
      return (
        addressHelpers.has(nameOf(expression["callee"] as Node) ?? "") ||
        (expression["arguments"] as Node[]).some(holdsAddress)
      );
    case "ConditionalExpression":
      return (
        holdsAddress(expression["consequent"] as Node) ||
        holdsAddress(expression["alternate"] as Node)
      );
    default:
      return false;
  }
}
/** A sentence's string, or any of its branches, with an address joined into its words. */
function joinsAddress(expression: Node): boolean {
  if (expression.type === "ConditionalExpression")
    return (
      joinsAddress(expression["consequent"] as Node) ||
      joinsAddress(expression["alternate"] as Node)
    );
  if (expression.type !== "TemplateLiteral") return false;
  const words = (expression["quasis"] as Node[])
    .map((quasi) => (quasi["value"] as { raw: string }).raw)
    .join("");
  return words.trim() !== "" && (expression["expressions"] as Node[]).some(holdsAddress);
}

/** Rule 4: drawn words in a shared model that join an address and do not say which. */
export function joinedSentencesIn(file: string, source: string): Finding[] {
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === "ObjectExpression") {
      const properties = (node["properties"] as Node[]).filter(
        (property) => property.type === "ObjectProperty",
      );
      for (const property of properties) {
        const key = nameOf(property["key"] as Node) ?? "";
        if (!drawnWords.has(key) || !joinsAddress(property["value"] as Node)) continue;
        const line = (property["value"] as Node).loc?.start.line ?? 0;
        findings.push({ file, line, snippet: `${key}: ${(lines[line - 1] ?? "").trim()}` });
      }
    }
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && typeof value === "object") visit(value);
  };
  visit(parseSource(source, file).program);
  return findings;
}

/**
 * The joined sentences rule 4 found in `packages/client` that are still drawn raw, each with why
 * it may be for now: none is a decision about a site. A new one is a failure; one made parts must
 * leave this list. Signing in and saving a password, decisions, were made parts (F14).
 */
export const knownJoinedSentences: Readonly<Record<string, string>> = {
  "packages/client/src/host/agent-activity-model.ts: activeLabel":
    "a transcript's activity line naming the site an agent is working on: a record, not a decision",
  "packages/client/src/host/agent-activity-model.ts: label":
    "a transcript's activity line naming the site an agent worked on: a record, not a decision",
};
/** Searches of text, by what they search with. */
const searches = new Set(["indexOf", "lastIndexOf", "search", "split", "match", "matchAll"]);
/** Searches that read as text only on a value named as words. */
const wordSearches = new Set(["includes", "replace", "replaceAll", "startsWith", "endsWith"]);
const wordsName = /(?:^|[a-z])(?:text|words|sentence|label|title|detail|message|line)s?$/iu;

/** Rule 5: a search of words for an address. */
export function addressSearchesIn(file: string, source: string): Finding[] {
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const report = (node: Node) => {
    const line = node.loc?.start.line ?? 0;
    findings.push({ file, line, snippet: (lines[line - 1] ?? "").trim() });
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = node["callee"] as Node;
      const [first] = node["arguments"] as Node[];
      if (
        (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
        first !== undefined &&
        holdsAddress(first)
      ) {
        const method = nameOf(callee["property"] as Node) ?? "";
        const target = nameOf(callee["object"] as Node) ?? "";
        if (searches.has(method) || (wordSearches.has(method) && wordsName.test(target)))
          report(node);
      }
    }
    if (
      node.type === "NewExpression" &&
      nameOf(node["callee"] as Node) === "RegExp" &&
      (node["arguments"] as Node[]).some(holdsAddress)
    )
      report(node);
    for (const [key, value] of Object.entries(node))
      if (key !== "loc" && typeof value === "object") visit(value);
  };
  visit(parseSource(source, file).program);
  return findings;
}

function appFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !/\.(test|test-support|fake)\.tsx?$/u.test(entry.name),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function scan(rule: (file: string, source: string) => Finding[]): string[] {
  return appFiles(mobileSource)
    .flatMap((file) =>
      rule(path.relative(repositoryRoot, file), readFileSync(file, "utf8")).filter(
        (finding) =>
          !allowed.some(
            (entry) => entry.file === finding.file && finding.snippet.includes(entry.snippet),
          ),
      ),
    )
    .map(({ file, line, snippet }) => `${file}:${line}: ${snippet}`);
}

describe("the drawn form of an address never leaves the component that draws it", () => {
  it("is made only in the drawing components, and never handed to a screen reader", () => {
    expect(scan(drawnFormLeaks)).toEqual([]);
  });

  it("sees a model, a sentence and a label made from it", () => {
    const model = `import { addressWords } from "../ui/address-words.js";
      export const row = { kind: "status", detail: addressWords(form.redirectUri) };`;
    expect(
      new Set(
        drawnFormLeaks("apps/mobile/src/screens/plugin-connect.tsx", model).map(({ line }) => line),
      ),
    ).toEqual(new Set([1, 2]));
    const drawing = `export function Lines(props) {
        return <Text modifiers={[accessibilityLabel(addressWords(props.title))]}>{addressWords(props.title)}</Text>;
      }`;
    expect(
      drawnFormLeaks("apps/mobile/src/screens/settings-form-primitives.ios.tsx", drawing).map(
        ({ line }) => line,
      ),
    ).toEqual([2]);
  });
});

describe("no address is drawn raw", () => {
  it("draws no email address, host or URL raw anywhere in the app", () => {
    expect(scan(rawAddressesIn)).toEqual([]);
  });

  it("sees an address drawn raw in a screen, and not one drawn through the one place", () => {
    const screen = `
      export function Row(props) {
        return (
          <View>
            <AppText role="title">{props.email}</AppText>
            <Notice detail={\`Open \${unopenedUrl} in your browser.\`} title="x" />
            <AppText>{hostOf(origin)}</AppText>
            <AddressText role="title" value={props.email} />
            <AddressSentence parts={sentence\`Use \${domain} as you.\`} />
            <AppText>{deploymentInitial(props.email)}</AppText>
            <Pressable accessibilityLabel={props.email} onPress={() => open(props.url)} />
            <AppText>{tabSiteLabel(tab.url)}</AppText>
            <Lines addressIn="title" detail="Opensteer account" title={view.signedInAs} />
          </View>
        );
      }`;
    expect(rawAddressesIn("screen.tsx", screen).map(({ line }) => line)).toEqual([5, 6, 7, 12]);
  });

  it("sees the places a review found still raw: a model's row and sentence, a toast, an alert", () => {
    const model = `
      export const status = { title: \`\${single.name} is signed in to \${domain}\` };
      export const row = { key: "status", kind: "status", label: view.title, detail: view.address };
      export const marked = { kind: "status", label: "x", ...addressDetail(view.address) };
      export const account = { title: identity.email ?? identity.subject };`;
    expect(rawAddressesIn("model.ts", model).map(({ line }) => line)).toEqual([2, 3]);
    const screen = `
      setSaveNotice({ title: said.message, detail: \`\${offer.username} · \${site}\` });
      Alert.alert("Link could not be opened", url);`;
    expect(rawAddressesIn("screen.tsx", screen).map(({ line }) => line)).toEqual([2, 3]);
  });
});

describe("a one-line host is only where no one decides anything about the site", () => {
  const uses = () =>
    appFiles(mobileSource).flatMap((file) =>
      hostLinesIn(path.relative(repositoryRoot, file), readFileSync(file, "utf8")),
    );

  it("is drawn only in the files that say why none of theirs is a decision", () => {
    expect(
      uses()
        .filter(({ file }) => !(file in hostLineFiles) && !file.endsWith("ui/address-text.tsx"))
        .map(({ file, line, snippet }) => `${file}:${line}: ${snippet}`),
    ).toEqual([]);
  });

  it("names only files that draw one", () => {
    const drawing = new Set(uses().map(({ file }) => file));
    expect(Object.keys(hostLineFiles).filter((file) => !drawing.has(file))).toEqual([]);
  });

  it("sees one in a page's dialog", () => {
    const screen = `
      export function PageDialog(props) {
        return <HostLine after=" says" host={props.site} role="caption" />;
      }`;
    expect(hostLinesIn("page-dialog.tsx", screen).map(({ line }) => line)).toEqual([3]);
  });
});

describe("a sentence assembled elsewhere from data says which addresses it holds", () => {
  const shared = path.join(repositoryRoot, "packages/client/src");
  const found = () =>
    appFiles(shared)
      .filter((file) => !file.includes(`${path.sep}mock${path.sep}`))
      .flatMap((file) =>
        joinedSentencesIn(path.relative(repositoryRoot, file), readFileSync(file, "utf8")),
      );

  it("is said in every shared model the phone draws from, but the places known when the rule came", () => {
    const kinds = new Set(
      found().map(({ file, snippet }) => `${file}: ${snippet.split(":", 1)[0]}`),
    );
    expect([...kinds].filter((kind) => !(kind in knownJoinedSentences))).toEqual([]);
    // One made parts leaves the list.
    expect(Object.keys(knownJoinedSentences).filter((kind) => !kinds.has(kind))).toEqual([]);
  });

  it("sees the consent build 9 walked, and not a sentence made with its address as a slot", () => {
    const model = `
      export const lines = (sites) => [
        { key: "sites", text: sealed ? \`Your credential can only be sent to \${listText(sites)}.\` : "None." },
        { addresses: sites, key: "listed", text: \`Sent to \${listText(sites)}.\` },
        { key: "said", title: sentence\`Sharing \${domain} is stopped\` },
        { key: "plain", text: \`Linking trusts \${pluginName}.\` },
      ];`;
    // Saying which addresses a joined sentence holds is not enough: it is made of parts or raw.
    expect(joinedSentencesIn("plugins.ts", model).map(({ line }) => line)).toEqual([3, 4]);
  });
});

describe("no address is found by searching words", () => {
  it("is never searched for in the app or in packages/client", () => {
    const found = ["apps/mobile/src", "packages/client/src"].flatMap((directory) =>
      appFiles(path.join(repositoryRoot, directory)).flatMap((file) =>
        addressSearchesIn(path.relative(repositoryRoot, file), readFileSync(file, "utf8")),
      ),
    );
    expect(found.map(({ file, line, snippet }) => `${file}:${line}: ${snippet}`)).toEqual([]);
  });

  it("sees the search the re-check found, and a pattern made from an address", () => {
    const source = `
      export function sentenceWith(text, addresses) {
        for (const address of addresses) { const at = rest.indexOf(address); }
        return new RegExp(host).test(text) || line.text.includes(site);
      }`;
    expect(addressSearchesIn("sentence-addresses.ts", source).map(({ line }) => line)).toEqual([
      3, 4, 4,
    ]);
  });
});
