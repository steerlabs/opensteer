import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTestExclude } from "../../.github/scripts/ci-test-files.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
const testFile = (file) =>
  /\.test(?:-support)?\.tsx?$/.test(file) || /^tests\/.*\.[cm]?[jt]sx?$/.test(file);
const name = (node) => node?.name ?? node?.value;
const member = (node) => (node?.type === "MemberExpression" ? name(node.property) : undefined);
const unwrap = (node) =>
  ["AwaitExpression", "TSAsExpression", "TSNonNullExpression"].includes(node?.type)
    ? unwrap(node.argument ?? node.expression)
    : node;
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (!["parent", "loc", "range", "tokens", "comments"].includes(key)) walk(value, visit);
  }
}
function binding(source, node) {
  for (let scope = source.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) return variable.defs[0];
  }
}
function imported(source, node, exported, modules) {
  if (
    node?.type === "MemberExpression" &&
    member(node) === exported &&
    node.object.type === "Identifier"
  ) {
    const def = binding(source, node.object);
    return (
      def?.node.type === "ImportNamespaceSpecifier" && modules.includes(def.parent.source.value)
    );
  }
  if (node?.type !== "Identifier") return false;
  const def = binding(source, node);
  return (
    def?.type === "ImportBinding" &&
    modules.includes(def.parent.source.value) &&
    name(def.node.imported) === exported
  );
}
function timer(source, call) {
  if (call?.type !== "CallExpression") return false;
  const callee = call.callee;
  return (
    (callee.type === "Identifier" && callee.name === "setTimeout" && !binding(source, callee)) ||
    imported(source, callee, "setTimeout", ["node:timers", "timers"])
  );
}
function sleeping(source, expression, seen = new Set()) {
  const node = unwrap(expression);
  if (node?.type === "NewExpression" && node.callee.name === "Promise") {
    const executor = node.arguments[0];
    if (!executor?.params?.[0]) return false;
    let found = false;
    walk(executor.body, (child) => {
      if (!timer(source, child)) return;
      const callback = child.arguments[0];
      if (callback?.type === "Identifier" && callback.name === executor.params[0].name)
        found = true;
      const body = callback?.body;
      const call =
        body?.type === "BlockStatement" && body.body.length === 1 ? body.body[0].expression : body;
      if (call?.type === "CallExpression" && call.callee.name === executor.params[0].name)
        found = true;
    });
    return found;
  }
  if (node?.type !== "CallExpression") return false;
  if (imported(source, node.callee, "setTimeout", ["node:timers/promises", "timers/promises"]))
    return true;
  if (
    member(node.callee) === "wait" &&
    imported(source, node.callee.object, "scheduler", ["node:timers/promises", "timers/promises"])
  )
    return true;
  if (node.callee.type !== "Identifier") return false;
  const def = binding(source, node.callee);
  if (def?.type === "ImportBinding" && /\/(?:delay|sleep)(?:\.js)?$/.test(def.parent.source.value))
    return true;
  const fn = def?.node.type === "FunctionDeclaration" ? def.node : def?.node.init;
  if (!fn || seen.has(fn)) return false;
  seen.add(fn);
  const body =
    fn.body?.type === "BlockStatement" && fn.body.body.length === 1
      ? (fn.body.body[0].argument ?? fn.body.body[0].expression)
      : fn.body;
  return sleeping(source, body, seen);
}
function fakeTimers(source, node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!["Program", "BlockStatement"].includes(parent.type)) continue;
    let fake;
    for (const statement of parent.body) {
      const hook = statement.expression;
      if (
        hook?.type !== "CallExpression" ||
        !["beforeEach", "beforeAll"].includes(hook.callee.name)
      )
        continue;
      walk(hook.arguments[0]?.body, (child) => {
        if (child.type === "CallExpression" && child.callee.object?.name === "vi") {
          if (member(child.callee) === "useFakeTimers") fake = true;
          if (member(child.callee) === "useRealTimers") fake = false;
        }
      });
    }
    for (const statement of parent.body) {
      if (statement.range[0] >= node.range[0]) break;
      const call = statement.expression;
      if (call?.type === "CallExpression" && call.callee.object?.name === "vi") {
        if (member(call.callee) === "useFakeTimers") fake = true;
        if (member(call.callee) === "useRealTimers") fake = false;
      }
    }
    if (fake !== undefined) return fake;
  }
  return false;
}
function testCallee(source, node) {
  let callee = node;
  while (callee) {
    if (
      ["test", "it", "describe"].some((exported) => imported(source, callee, exported, ["vitest"]))
    )
      return true;
    if (callee.type === "Identifier") return ["test", "it", "describe"].includes(callee.name);
    if (callee.type !== "MemberExpression" && callee.type !== "CallExpression") return false;
    callee = callee.object ?? callee.callee;
  }
  return false;
}
function testCall(source, node) {
  return node?.type === "CallExpression" && testCallee(source, node.callee);
}
function promiseParameter(source, node, executor) {
  return (
    node?.type === "Identifier" &&
    executor.params.some((param) => binding(source, node)?.name === param)
  );
}
function executorDeadline(source, executor) {
  const statements =
    executor.body.type === "BlockStatement" ? executor.body.body : [{ expression: executor.body }];
  return statements.some((statement) => {
    const expressions =
      statement.type === "VariableDeclaration"
        ? statement.declarations.map((declaration) => declaration.init)
        : [statement.expression];
    return expressions.some((call) => {
      if (!timer(source, call)) return false;
      const callback = call.arguments[0];
      if (promiseParameter(source, callback, executor)) return true;
      if (!["ArrowFunctionExpression", "FunctionExpression"].includes(callback?.type)) return false;
      const body = callback.body;
      const settlement =
        body.type === "BlockStatement" && body.body.length === 1
          ? (body.body[0].expression ?? body.body[0].argument)
          : body;
      return (
        settlement?.type === "CallExpression" &&
        promiseParameter(source, settlement.callee, executor)
      );
    });
  });
}

export function assertBaselineShrinks(current, ceiling) {
  for (const [file, entries] of Object.entries(current))
    for (const [key, count] of Object.entries(entries)) {
      if (!Number.isSafeInteger(count) || count < 1 || count > (ceiling[file]?.[key] ?? 0))
        throw new Error(`Baseline may only shrink: ${file} ${key}`);
    }
}
export function fingerprint(rule, text) {
  return `${rule}:${createHash("sha256").update(text).digest("hex").slice(0, 20)}`;
}
function rule(id, build, config = false) {
  return {
    meta: { type: "problem", schema: [] },
    create(context) {
      const file = relative(root, context.filename).replaceAll("\\", "/");
      if (
        config !== "all" &&
        !testFile(file) &&
        !(config && /(?:^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/.test(file))
      )
        return {};
      const source = context.sourceCode;
      const counts = new Map();
      const report = (node, message) => {
        const key = fingerprint(id, source.getText(node));
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count <= (baseline[file]?.[key] ?? 0)) return;
        context.report({ node, message });
      };
      return build(source, report, file);
    },
  };
}
const rules = {
  "no-unbounded-created-promise": rule("no-unbounded-created-promise", (source, report) => ({
    AwaitExpression(node) {
      if (node.argument.type !== "Identifier") return;
      const declaration = binding(source, node.argument)?.node;
      const owner = (child) => {
        for (let parent = child?.parent; parent; parent = parent.parent)
          if (
            ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(
              parent.type,
            )
          )
            return parent;
      };
      if (
        !owner(node) ||
        owner(node) !== owner(declaration) ||
        !testCall(source, owner(node).parent)
      )
        return;
      const promise = declaration?.init;
      if (promise?.type !== "NewExpression" || promise.callee.name !== "Promise") return;
      const executor = promise.arguments[0];
      if (!executor?.params?.[0]) return;
      let exportsResolver = false;
      const hasDeadline = executorDeadline(source, executor);
      walk(executor.body, (child) => {
        if (child.type === "AssignmentExpression" && child.right.name === executor.params[0].name)
          exportsResolver = true;
      });
      if (exportsResolver && !hasDeadline)
        report(
          node,
          "Bound this externally resolved promise with @opensteer/shared/withTimeout before awaiting it.",
        );
    },
  })),
  "no-real-time-wait-in-tests": rule("no-real-time-wait-in-tests", (source, report) => ({
    AwaitExpression(node) {
      if (sleeping(source, node.argument) && !fakeTimers(source, node))
        report(
          node,
          "Wait for an event or condition with vi.waitFor/vi.waitUntil, or use fake timers.",
        );
    },
    NewExpression(node) {
      if (
        node.parent.type !== "AwaitExpression" &&
        sleeping(source, node) &&
        !fakeTimers(source, node)
      )
        report(node, "Do not create real-time sleep promises in tests.");
    },
  })),
  "no-polling-loop-in-tests": rule("no-polling-loop-in-tests", (source, report) => {
    function loop(node) {
      let found = false;
      walk(node.body, (child) => {
        if (
          child.type === "AwaitExpression" &&
          sleeping(source, child.argument) &&
          !fakeTimers(source, child)
        )
          found = true;
      });
      if (found)
        report(
          node,
          "Replace delay-based polling with vi.waitFor/vi.waitUntil or the actual event.",
        );
    }
    return {
      WhileStatement: loop,
      DoWhileStatement: loop,
      ForStatement: loop,
      ForOfStatement: loop,
      ForInStatement: loop,
    };
  }),
  "no-unreasoned-skip-or-retry": rule(
    "no-unreasoned-skip-or-retry",
    (source, report, file) => ({
      MemberExpression(node) {
        if (!["skip", "todo", "fails"].includes(member(node))) return;
        if (!testCallee(source, node.object)) return;
        const comments = source.getAllComments();
        if (
          !comments.some(
            (comment) =>
              comment.loc.end.line === node.loc.start.line - 1 && /[a-z]{3}/i.test(comment.value),
          )
        )
          report(node, "Explain skip/todo/fails in a reason comment on the line above.");
      },
      Property(node) {
        if (name(node.key) !== "retry") return;
        const inConfig = /vitest[^/]*\.config\./.test(file);
        if (inConfig ? node.value.value !== 0 : testCall(source, node.parent?.parent))
          report(
            node,
            "Test retries hide failures; omit retry (configs may specify only retry: 0).",
          );
      },
    }),
    true,
  ),
  "require-suppression-reason": rule(
    "require-suppression-reason",
    (source, report) => ({
      Program() {
        for (const comment of source.getAllComments()) {
          if (
            /oxlint-disable(?:-next-line|-line)?\b[\s\S]*opensteer\//.test(comment.value) &&
            !/ -- \S[^\n]*\s*$/.test(comment.value)
          )
            report(comment, "End opensteer suppression comments with -- <reason>.");
        }
      },
    }),
    "all",
  ),
  "no-unit-test-timeout": rule("no-unit-test-timeout", (source, report, file) => {
    if (!/\.test\.tsx?$/.test(file)) return {};
    // Keep this aligned with the actual default-config lane, not a numerical ceiling on real stacks.
    if (
      defaultTestExclude.some((pattern) =>
        file.includes(pattern.replaceAll("*", "").replaceAll("/", "")),
      )
    )
      return {};
    return {
      CallExpression(node) {
        if (!testCall(source, node)) return;
        if (
          node.arguments.length >= 3 &&
          !["ArrowFunctionExpression", "FunctionExpression"].includes(node.arguments[2].type)
        )
          report(
            node.arguments[2],
            "Use the default unit-test timeout; bound the specific wait instead.",
          );
        for (const arg of node.arguments)
          if (arg.type === "ObjectExpression")
            for (const prop of arg.properties) {
              if (name(prop.key) === "timeout")
                report(prop, "Use the default unit-test timeout; bound the specific wait instead.");
            }
      },
    };
  }),
};
export default { meta: { name: "opensteer" }, rules };
