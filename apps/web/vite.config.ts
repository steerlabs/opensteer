import { resolve } from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { resolveWebPort } from "./src/development/dev-server-port.js";
import {
  localHostProxyRoutes,
  localWebBindAddress,
  redirectUnclaimedLocalHost,
  rejectSupervisorOnlyRoutes,
} from "./src/development/dev-server-boundary.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, repositoryRoot, "OPENSTEER_WEB_");
  const port = resolveWebPort(process.env.OPENSTEER_WEB_PORT ?? fileEnvironment.OPENSTEER_WEB_PORT);
  const publicOrigin = new URL(
    process.env.OPENSTEER_CANONICAL_ORIGIN?.trim() || "http://localhost:43100",
  );
  const installLocalBoundary = (server: {
    middlewares: {
      use: (
        middleware: (
          request: Parameters<typeof redirectUnclaimedLocalHost>[0],
          response: Parameters<typeof redirectUnclaimedLocalHost>[1],
          next: Parameters<typeof redirectUnclaimedLocalHost>[2],
        ) => void,
      ) => void;
    };
  }) => {
    server.middlewares.use((request, response, next) => {
      void redirectUnclaimedLocalHost(request, response, next, { publicOrigin });
    });
    server.middlewares.use(rejectSupervisorOnlyRoutes);
  };
  return {
    build: {
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, "index.html"),
          glass: resolve(import.meta.dirname, "glass.html"),
        },
      },
      sourcemap: true,
      target: "es2022",
    },
    envDir: repositoryRoot,
    define: {
      "import.meta.env.OPENSTEER_IMAGE_REGISTRY": JSON.stringify(
        process.env.OPENSTEER_IMAGE_REGISTRY ?? "",
      ),
      "import.meta.env.OPENSTEER_RUNNER_ARTIFACT_BASE_URL": JSON.stringify(
        process.env.OPENSTEER_RUNNER_ARTIFACT_BASE_URL ?? "",
      ),
      "import.meta.env.OPENSTEER_RUNNER_SOURCE_REVISION": JSON.stringify(
        process.env.OPENSTEER_RUNNER_SOURCE_REVISION ?? process.env.OPENSTEER_SOURCE_REVISION ?? "",
      ),
      "import.meta.env.OPENSTEER_SOURCE_REVISION": JSON.stringify(
        process.env.OPENSTEER_SOURCE_REVISION ?? "",
      ),
    },
    plugins: [
      {
        configurePreviewServer(server) {
          installLocalBoundary(server);
        },
        configureServer(server) {
          installLocalBoundary(server);
        },
        name: "opensteer-local-web-boundary",
      },
    ],
    preview: {
      host: localWebBindAddress,
      port,
      strictPort: true,
    },
    server: {
      host: localWebBindAddress,
      port,
      proxy: localHostProxyRoutes,
      strictPort: true,
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  };
});
