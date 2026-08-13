// Dev-only: verify the built dist is self-contained — the only allowed
// external imports are the `openclaw` host peer and Node.js core builtins
// (bare or node:-prefixed). Run: node scripts/check-bundle.mjs
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const CORE_MODULES = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "module", "net", "os", "path",
  "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

const isCoreBuiltin = (spec) =>
  spec.startsWith("node:") || CORE_MODULES.has(spec);

const importSpecifiers = (src) => {
  const out = [];
  const re = /(?:from\s*|import\s*\(\s*)(["'])([^"']+)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[2];
    // A real module specifier never contains code characters; this filters
    // out regex false positives inside template literals in minified code.
    if (/[\s{}()=;,]/.test(spec)) continue;
    out.push(spec);
  }
  return out;
};

let failed = false;
for (const f of readdirSync(distDir).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(distDir, f), "utf8");
  const external = [
    ...new Set(importSpecifiers(src).filter((x) => !x.startsWith("."))),
  ];
  const problems = external.filter(
    (x) => x !== "openclaw" && x !== "openclaw/plugin-sdk/tool-plugin" && !isCoreBuiltin(x)
  );
  if (problems.length) failed = true;
  console.log(`${f}: ${external.join(", ") || "(self-contained)"}`);
  for (const p of problems) {
    console.log(`  ⚠ external import not provided offline: ${p}`);
  }
}
process.exitCode = failed ? 1 : 0;
