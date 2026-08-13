# OpenSandbox × OpenClaw Tool Plugin

**English** | [简体中文](README.zh-CN.md)

[OpenClaw](https://docs.openclaw.ai) tool plugin that exposes OpenSandbox sandboxes as native agent tools: lifecycle management, shell command execution, and file operations. Built on the official `@alibaba-group/opensandbox` JS SDK.

## Requirements

- Node.js 22.22.3+ / 24.15+ / 25.9+
- OpenClaw `>=2026.5.17` (first release exporting `openclaw/plugin-sdk/tool-plugin`)

## Install

```bash
openclaw plugins install ./plugins/opensandbox-openclaw
# or from a tarball / ClawHub once published
openclaw plugins install clawhub:<org>/opensandbox-openclaw
```

Restart or reload the OpenClaw gateway after installation, then verify:

```bash
openclaw plugins inspect opensandbox-openclaw --runtime
```

### Offline / self-contained install

The built package is **self-contained**: all runtime dependencies
(`@alibaba-group/opensandbox`, `typebox`, `undici`) are bundled into
`dist/`, and `package.json` declares **no runtime `dependencies`**.
Because of that, `openclaw plugins install` skips `npm install` entirely
(it only runs when a plugin declares dependencies) and the install is a pure
directory copy — no network access is needed on the consumer side. The only
runtime requirement is the host `openclaw` package itself (peer dependency),
which the gateway already provides.

Verification: `npm run check:bundle` asserts `dist/` imports nothing but the
`openclaw` peer and Node.js core builtins.

## Configuration

Configure the plugin in `openclaw.json` under the plugin config section (plugin id: `opensandbox-openclaw`):

| Key | Default | Description |
|---|---|---|
| `domain` | `localhost:8080` | OpenSandbox lifecycle server domain (`host[:port]`), e.g. `api.opensandbox.io` |
| `protocol` | `http` | `http` or `https` |
| `apiKey` | env `OPEN_SANDBOX_API_KEY` | Prefer environment variables or SecretRefs over hardcoding |
| `requestTimeoutSeconds` | `30` | SDK HTTP request timeout |
| `useServerProxy` | `true` | Route execd/file/endpoint traffic through the lifecycle server proxy |
| `defaultImage` | `ubuntu` | Image used by `sandbox_create` when no image is given |
| `maxOutputBytes` | `65536` | Cap on command output / file content returned to the agent (truncated beyond) |
| `sandboxCacheSize` | `8` | In-process Sandbox instance LRU cache bound |

**`useServerProxy` matters.** In the expected deployment (OpenClaw gateway and sandbox server on different hosts) the sandbox's public endpoints are not reachable from the plugin process — keep it `true` so all traffic goes through the lifecycle server. Set it to `false` only when sandbox endpoints are directly reachable (e.g. local development).

## Tools

All tools use the `sandbox_` prefix and require an explicit `sandbox_id` from `sandbox_create`/`sandbox_connect`.

### Lifecycle

| Tool | Description |
|---|---|
| `sandbox_create` | Create a sandbox (`image`, `timeoutSeconds`, `env`, `metadata`, `resource`, `networkPolicy`, `entrypoint`) → `{ sandboxId, state, createdAt, expiresAt }` |
| `sandbox_connect` | Connect to an existing sandbox by ID (restore after restart) |
| `sandbox_list` | List sandboxes with state/metadata filters and pagination |
| `sandbox_get_info` | Status, metadata, `expiresAt` (TTL awareness) |
| `sandbox_renew` | Extend lifetime: `timeoutSeconds` from now |
| `sandbox_kill` | Terminate the sandbox (destroys all data — see warning below) |
| `sandbox_get_endpoint` | Absolute URL for a sandbox port (via server proxy by default) |

### Command execution

| Tool | Description |
|---|---|
| `sandbox_run_command` | Foreground command execution → `{ executionId, exitCode, stdout, stderr, executionTimeMs, truncated }` |
| `sandbox_interrupt_command` | Interrupt a running command by `executionId` |

### Files

| Tool | Description |
|---|---|
| `sandbox_read_file` | Read a text file (encoding / range reads) |
| `sandbox_write_file` | Write text content |
| `sandbox_list_files` | List directory entries (recursive `depth`) |
| `sandbox_delete_files` | Delete files/directories (`recursive` required for directories) |

## Stateless sandbox warning

OpenSandbox sandboxes are **stateless**: `sandbox_kill` or server-side TTL expiry destroys everything inside. The `sandbox_kill` tool description instructs the agent to export files/artifacts first (read via `sandbox_read_file`, package via `sandbox_run_command`, or download via `sandbox_get_endpoint`). Un-killed sandboxes are reclaimed by the server TTL.

## Development

```bash
npm install
npm run plugin:build      # tsup bundle + openclaw plugins build --entry ./dist/index.js
npm run check:bundle      # assert dist/ is self-contained (no external npm imports)
npm run plugin:validate   # validate manifest against the built entry
npm test                  # vitest metadata contract tests
npm run typecheck
```

Tools are grouped in `src/tools/` (`lifecycle.ts`, `command.ts`, `files.ts`); each exports a TypeBox parameter schema plus an executor with signature `(client, config, params, signal)`, assembled in `src/index.ts`. `tsup.config.ts` bundles all runtime deps into `dist/` (only `openclaw` stays external).

## License

Apache-2.0
