import { defineConfig } from "tsup";

/**
 * Bundle ALL runtime dependencies into dist/index.js so the shipped plugin
 * package is self-contained.
 *
 * Why: `openclaw plugins install` only runs `npm install` when the plugin
 * declares runtime `dependencies`. With an empty `dependencies` field the
 * install is a pure directory copy — fully offline, no network access
 * required on the consumer side. `openclaw` itself stays external because it
 * is provided by the host gateway (peer dependency).
 *
 * The SDK's `await import("undici")` (keep-alive dispatcher) is intentionally
 * left external by the bundler; at runtime it fails resolution inside an
 * installed plugin and the SDK silently falls back to the global fetch
 * (undici-based since Node 18), which is the SDK's designed path.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  external: ["openclaw"],
});
