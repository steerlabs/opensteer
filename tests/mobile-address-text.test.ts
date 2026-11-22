import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

/*
 * Every email address, host and URL the phone draws goes through `AddressText`, or through
 * `addressWords` inside a sentence (`apps/mobile/src/ui/address-text.tsx`), so none takes a hyphen
 * it does not have and each wraps only at its own joints. This reads every screen's source and
 * fails on one drawn raw: a value whose name says it is an address (`email`, `origin`, `host`,
 * `url`, `site`, `domain`, …), or that an origin helper returned, put in a text's children or in a
 * prop a row draws, outside those two.
 *
 * What it reads is names: a value built elsewhere under a name that says nothing (`header`,
 * `detail`) is not seen here, so such a value is built with `addressWords` where it is made.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const mobileSource = path.join(repositoryRoot, "apps/mobile/src");

/** A name that says the value is an address, a host or a URL: whole, or as its camelCase end. */
const addressName =
  /^(?:email|url|uri|href|origin|host|hostname|domain|site|endpoint|address|issuer|signedInAs)$|(?:Email|Url|Uri|Href|Origin|Host|Hostname|Domain|Site|Endpoint|Address|Issuer)$/u;
/** An object whose `detail` is an origin: a connected agent's `AgentWho`. */
const originDetailOwners = new Set(["who"]);
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

/**
 * Places that draw an address raw on purpose. Keep this short; every entry says why.
 */
const allowed: readonly {
  readonly file: string;
  readonly snippet: string;
  readonly reason: string;
}[] = [
  {
    file: "apps/mobile/src/markdown/reference-link.tsx",
    snippet: "const link = { href: url, label: url };",
    reason:
      "what a long press on a message's link copies or opens: the exact address, not drawn text",
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

/** Whether an expression drawn as text holds an address outside `addressWords`. */
function rawAddress(expression: Node): Node | null {
  switch (expression.type) {
    case "Identifier":
      return addressName.test(expression["name"] as string) ? expression : null;
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const property = expression["property"] as Node;
      const object = expression["object"] as Node;
      const owner =
        object.type === "Identifier"
          ? (object["name"] as string)
          : object.type === "MemberExpression" || object.type === "OptionalMemberExpression"
            ? ((object["property"] as Node)["name"] as string | undefined)
            : undefined;
      if (expression["computed"] || property.type !== "Identifier") return null;
      if (owner !== undefined && copyTable.test(owner)) return null;
      const name = property["name"] as string;
      if (name === "detail" && owner !== undefined && originDetailOwners.has(owner))
        return expression;
      return addressName.test(name) ? expression : null;
    }
    case "CallExpression":
    case "OptionalCallExpression": {
      const callee = expression["callee"] as Node;
      const name =
        callee.type === "Identifier"
          ? (callee["name"] as string)
          : callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression"
            ? ((callee["property"] as Node)["name"] as string | undefined)
            : undefined;
      // Drawn through the one place: done. Any other call makes something else of its arguments.
      if (name === "addressWords") return null;
      // A helper that says an address raw, unless what it is handed was drawn the one way.
      return name !== undefined && addressHelpers.has(name) && !mentions(expression, "addressWords")
        ? expression
        : null;
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
      if (
        expression["operator"] !== "??" &&
        expression["operator"] !== "||" &&
        expression["operator"] !== "+"
      )
        return null;
      return rawAddress(expression["left"] as Node) ?? rawAddress(expression["right"] as Node);
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return rawAddress(expression["expression"] as Node);
    default:
      return null;
  }
}

/** Whether `node` calls the named function anywhere inside it. */
function mentions(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((child) => mentions(child, name));
  if (!isNode(node)) return false;
  if (node.type === "Identifier" && node["name"] === name) return true;
  return Object.entries(node).some(
    ([key, value]) => key !== "loc" && typeof value === "object" && mentions(value, name),
  );
}

function elementName(opening: Node): string {
  const name = opening["name"] as Node;
  return name.type === "JSXIdentifier"
    ? (name["name"] as string)
    : name.type === "JSXMemberExpression"
      ? ((name["property"] as Node)["name"] as string)
      : "";
}

/** Every address a file draws raw. */
export function rawAddressesIn(file: string, source: string): Finding[] {
  const ast = parse(source, { plugins: ["typescript", "jsx"], sourceType: "module" });
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const report = (node: Node) => {
    const line = node.loc?.start.line ?? 0;
    findings.push({ file, line, snippet: (lines[line - 1] ?? "").trim() });
  };
  const visit = (node: unknown, inAddressText: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inAddressText);
      return;
    }
    if (!isNode(node)) return;
    if (node.type === "JSXElement") {
      const opening = node["openingElement"] as Node;
      // AddressText's own value is drawn the one way; its other props are its text's.
      const addressText = elementName(opening) === "AddressText";
      for (const attribute of opening["attributes"] as Node[]) {
        if (attribute.type !== "JSXAttribute") continue;
        const name = (attribute["name"] as Node)["name"] as string;
        const value = attribute["value"] as Node | null;
        if (addressText && name === "value") continue;
        if (value?.type === "JSXExpressionContainer" && drawnProps.has(name)) {
          const found = rawAddress(value["expression"] as Node);
          if (found) report(found);
        }
        visit(value, inAddressText);
      }
      for (const child of node["children"] as Node[]) {
        if (child.type === "JSXExpressionContainer") {
          const found = rawAddress(child["expression"] as Node);
          if (found) report(found);
        }
        visit(child, inAddressText || addressText);
      }
      return;
    }
    // A row described as data: `{ title, detail }` is drawn as the row's text.
    if (node.type === "ObjectProperty" && !node["computed"]) {
      const key = node["key"] as Node;
      const name = key.type === "Identifier" ? (key["name"] as string) : undefined;
      if (name !== undefined && drawnProps.has(name)) {
        const found = rawAddress(node["value"] as Node);
        if (found) report(found);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "leadingComments") continue;
      visit(value, inAddressText);
    }
  };
  visit(ast.program, false);
  return findings;
}

function screens(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".tsx") &&
        !/\.(test|test-support|fake)\.tsx$/u.test(entry.name),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("the phone draws every address through AddressText", () => {
  it("draws no email address, host or URL raw on any screen", () => {
    const findings = screens(mobileSource).flatMap((file) =>
      rawAddressesIn(path.relative(repositoryRoot, file), readFileSync(file, "utf8")).filter(
        (finding) =>
          !allowed.some(
            (entry) => entry.file === finding.file && finding.snippet.includes(entry.snippet),
          ),
      ),
    );
    expect(findings.map(({ file, line, snippet }) => `${file}:${line}: ${snippet}`)).toEqual([]);
  });

  it("sees an address drawn raw, and not one drawn through the one place", () => {
    const screen = `
      export function Row(props) {
        return (
          <View>
            <AppText role="title">{props.email}</AppText>
            <Notice detail={\`Open \${unopenedUrl} in your browser.\`} title="x" />
            <AppText>{hostOf(origin)}</AppText>
            <AddressText role="title" value={props.email} />
            <AppText>{\`Use \${addressWords(domain)} as you.\`}</AppText>
            <AppText>{deploymentInitial(props.email)}</AppText>
            <Pressable accessibilityLabel={props.email} onPress={() => open(props.url)} />
          </View>
        );
      }`;
    expect(rawAddressesIn("screen.tsx", screen).map(({ line }) => line)).toEqual([5, 6, 7]);
  });
});
