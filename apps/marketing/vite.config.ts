import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" },
  server: { port: Number(process.env.PORT ?? 4174) },
});
