import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlaywrightBrowserCoreEngine } from "../../packages/engine-playwright/src/index.js";
import {
  createDomRuntime,
  createFilesystemOpensteerWorkspace,
} from "../../packages/opensteer/src/index.js";

type PersistCase = {
  readonly title: string;
  readonly pathname: string;
  readonly selector: string;
  readonly persist: string;
};

let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
const temporaryRoots: string[] = [];

function html(body: string, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function genericSiblings(): string {
  return html(
    `
      <div id="host"></div>
      <script>
        const host = document.getElementById("host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML =
          '<button id="btn-add" class="action" type="button" style="width:180px;height:42px">Add a note</button>' +
          '<button id="btn-send" class="action" type="button" style="width:180px;height:42px">Send without a note</button>';
      </script>
    `,
    "shadow-persist: generic siblings",
  );
}

function parallelSubtrees(): string {
  return html(
    `
      <div id="host"></div>
      <script>
        const host = document.getElementById("host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML =
          '<div class="option"><button id="btn-add" class="action" type="button" style="width:180px;height:42px">Add a note</button></div>' +
          '<div class="option"><button id="btn-send" class="action" type="button" style="width:180px;height:42px">Send without a note</button></div>';
      </script>
    `,
    "shadow-persist: parallel subtrees",
  );
}

function identicalHosts(): string {
  return html(
    `
      <div id="container">
        <div></div>
        <div></div>
      </div>
      <script>
        const divs = document.getElementById("container").children;
        let hostIndex = 0;
        for (const div of divs) {
          const shadow = div.attachShadow({ mode: "open" });
          const suffix = hostIndex++;
          shadow.innerHTML =
            '<button id="btn-add-' + suffix + '" class="action" type="button" style="width:180px;height:42px">Add a note</button>' +
            '<button id="btn-send-' + suffix + '" class="action" type="button" style="width:180px;height:42px">Send without a note</button>';
        }
      </script>
    `,
    "shadow-persist: identical hosts",
  );
}

function deepIdenticalBranches(): string {
  return html(
    `
      <div id="root"></div>
      <script>
        const root = document.getElementById("root");
        for (let i = 0; i < 2; i++) {
          const branch = document.createElement("div");
          branch.className = "branch";
          const inner = document.createElement("div");
          inner.className = "inner";
          const host = document.createElement("div");
          host.className = "host";
          const shadow = host.attachShadow({ mode: "open" });
          shadow.innerHTML =
            '<div class="panel"><button id="btn-add-' + i + '" class="action" type="button" style="width:180px;height:42px">Add a note</button></div>' +
            '<div class="panel"><button id="btn-send-' + i + '" class="action" type="button" style="width:180px;height:42px">Send without a note</button></div>';
          inner.appendChild(host);
          branch.appendChild(inner);
          root.appendChild(branch);
        }
      </script>
    `,
    "shadow-persist: deep identical branches",
  );
}

function withAriaLabel(): string {
  return html(
    `
      <div id="host"></div>
      <script>
        const host = document.getElementById("host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML =
          '<button id="btn-add" class="action" type="button" aria-label="Add a note" style="width:180px;height:42px">Add a note</button>' +
          '<button id="btn-send" class="action" type="button" aria-label="Send without a note" style="width:180px;height:42px">Send without a note</button>';
      </script>
    `,
    "shadow-persist: with aria-label",
  );
}

async function handleRequest(_request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(_request.url ?? "/", "http://127.0.0.1");
  const pages: Record<string, () => string> = {
    "/shadow-persist/generic-siblings": genericSiblings,
    "/shadow-persist/parallel-subtrees": parallelSubtrees,
    "/shadow-persist/identical-hosts": identicalHosts,
    "/shadow-persist/deep-identical-branches": deepIdenticalBranches,
    "/shadow-persist/with-aria-label": withAriaLabel,
  };

  const factory = pages[url.pathname];
  if (factory) {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(factory());
    return;
  }

  response.statusCode = 404;
  response.end("not found");
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function createTemporaryRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(tmpdir(), "opensteer-shadow-persist-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const persistCases = [
  {
    title: "persists click on shadow DOM button with aria-label (control)",
    pathname: "/shadow-persist/with-aria-label",
    selector: "#btn-send",
    persist: "aria-label-button",
  },
  {
    title: "persists click on generic sibling shadow DOM buttons",
    pathname: "/shadow-persist/generic-siblings",
    selector: "#btn-send",
    persist: "generic-sibling-button",
  },
  {
    title: "persists click on shadow DOM button in parallel subtrees",
    pathname: "/shadow-persist/parallel-subtrees",
    selector: "#btn-send",
    persist: "parallel-subtree-button",
  },
  {
    title: "persists click on shadow DOM button across identical hosts",
    pathname: "/shadow-persist/identical-hosts",
    selector: "#btn-send-1",
    persist: "identical-host-button",
  },
  {
    title: "persists click on shadow DOM button in deep identical branches",
    pathname: "/shadow-persist/deep-identical-branches",
    selector: "#btn-send-1",
    persist: "deep-branch-button",
  },
] satisfies readonly PersistCase[];

async function expectStoredDescriptor(testCase: PersistCase): Promise<void> {
  const rootPath = await createTemporaryRoot();
  const root = await createFilesystemOpensteerWorkspace({ rootPath });
  const engine = await createPlaywrightBrowserCoreEngine({
    launch: { headless: true },
  });

  try {
    const runtime = createDomRuntime({ engine, root, namespace: "shadow-persist" });
    const sessionRef = await engine.createSession();
    const created = await engine.createPage({
      sessionRef,
      url: `${baseUrl}${testCase.pathname}`,
    });
    await wait(400);

    await runtime.resolveTarget({
      pageRef: created.data.pageRef,
      method: "click",
      target: {
        kind: "selector",
        selector: testCase.selector,
        persist: testCase.persist,
      },
    });

    const stored = await runtime.readDescriptor({
      method: "click",
      persist: testCase.persist,
    });
    expect(stored).toBeDefined();
  } finally {
    await engine.dispose();
  }
}

beforeAll(async () => {
  const started = await startServer();
  baseUrl = started.url;
  closeServer = started.close;
}, 30_000);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (closeServer) {
    await closeServer();
  }
});

describe.sequential("Shadow DOM persist boundary tests", () => {
  for (const testCase of persistCases) {
    test(testCase.title, { timeout: 60_000 }, async () => {
      await expectStoredDescriptor(testCase);
    });
  }
});
