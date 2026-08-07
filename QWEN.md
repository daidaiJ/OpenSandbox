# QWEN.md — OpenSandbox

Instructional context for working in this repository with Qwen Code. Read this before starting any task, then follow the nearest `AGENTS.md` (root `AGENTS.md` is the router; `server/`, `sdks/`, `specs/`, `kubernetes/` have their own).

## Project Overview

OpenSandbox is a **general-purpose sandbox platform for AI applications**: multi-language SDKs, unified sandbox APIs, and Docker/Kubernetes runtimes for Coding Agents, GUI Agents, Agent Evaluation, AI Code Execution, and RL Training. It is a monorepo spanning a Python lifecycle server, Go runtime sidecars, an optional Kubernetes operator, public OpenAPI contracts, and generated + handwritten SDKs for Python, JavaScript/TypeScript, Kotlin, C#, and Go. License: Apache 2.0.

Key capabilities: sandbox lifecycle management (create/run/files/kill), a Code Interpreter API, unified ingress gateway with routing strategies, per-sandbox egress network policy, a Credential Vault for secret injection, and secure container runtime support (gVisor, Kata, Firecracker).

## Repository Map

| Path | Contents |
|------|----------|
| `server/` | Python/FastAPI lifecycle control plane (`opensandbox_server` package), Docker + K8s runtime integration, snapshot metadata, server tests |
| `components/execd/` | In-sandbox execution daemon (Go): command execution + file operations |
| `components/egress/` | Per-sandbox network egress policy sidecar (Go) |
| `components/ingress/` | Ingress gateway and endpoint routing (Go) |
| `components/internal/` | Shared Go helpers for runtime components |
| `sdks/` | SDKs: `sandbox/` (base SDK: python, javascript, kotlin, csharp, go), `code-interpreter/` (python, javascript, csharp, kotlin/code-interpreter), `mcp/sandbox/python` (MCP server), plus workspace config (`package.json`, `pnpm-workspace.yaml`, `eslint.base.mjs`, `Directory.Build.props`) |
| `specs/` | Public API contracts: `sandbox-lifecycle.yml`, `diagnostic-api.yml`, `execd-api.yaml`, `egress-api.yaml` — **source of truth for public interfaces** |
| `kubernetes/` | Operator (BatchSandbox, Pool, SandboxSnapshot CRDs), task-executor, Helm chart (`charts/opensandbox-controller`), Kustomize config, Kind e2e tests |
| `cli/` | `osb` command-line client + bundled CLI skills (Python, uses the Python SDK) |
| `tests/` | Cross-language end-to-end SDK tests |
| `docs/` | VitePress documentation site (all long-form user/ops docs live here) |
| `examples/` | Runnable example code (agent integrations, browser automation, training) |
| `sandboxes/` | Runtime sandbox implementations (e.g., code-interpreter image) |
| `oseps/` | OpenSandbox Enhancement Proposals (required for major changes) |
| `scripts/` | Dev/maintenance scripts (release, license, per-language e2e) |
| `.github/workflows/` | CI: `server-test.yml`, `sdk-tests.yml`, `execd-test.yml`, `ingress-test.yaml`, `egress-test.yml`, `kubernetes-test.yml`, `real-e2e.yml`, publish/release workflows |

## Architecture

- **Lifecycle plane**: `server/` (FastAPI) exposes the lifecycle API; routes stay thin — business logic lives in `opensandbox_server/services/` (with `docker/` and `k8s/` runtime modules), persistence in `repositories/`, optional integrations in `integrations/`.
- **Execution plane**: `components/execd/` runs inside each sandbox, implements the execd API (commands, files). `components/ingress/` routes traffic into sandboxes; `components/egress/` enforces per-sandbox outbound policy.
- **Kubernetes runtime**: operator reconcilers (`BatchSandboxReconciler`, `PoolReconciler`) plus an in-process `TaskScheduler` that dispatches tasks to a task-executor HTTP server running inside sandbox pods. Allocation state is carried on BatchSandbox annotations (`alloc-status`, `alloc-release`, `endpoints`) — stability-sensitive contracts.
- **SDK generation**: OpenAPI-generated clients under generator-owned paths; handwritten adapters/services/facades on top. Never patch generated output as the only fix — regenerate from the spec.

## Prerequisites

- Python 3.10+, `uv` (Python tooling throughout: server, CLI, Python SDKs)
- Go 1.24+ (components, kubernetes, Go SDK)
- JDK 17+, Gradle (Kotlin SDK); Node.js + pnpm (JS/TS SDKs); .NET SDK (C#)
- Docker (local server runtime and integration/e2e tests)
- Kind (kubernetes e2e tests)

## Building, Testing, and Linting

### Server (`server/`)

```bash
cd server
uv sync --all-groups          # setup
uv run ruff check             # lint
uv run ruff format opensandbox_server tests
uv run pyright                # type check
uv run pytest                 # full suite
uv run pytest tests/test_docker_service.py   # focused test
uv run pytest tests/k8s       # kubernetes tests
cp opensandbox_server/examples/example.config.toml ~/.sandbox.toml
uv run python -m opensandbox_server.main   # run dev server
```

### SDKs (`sdks/`)

JS workspace: `cd sdks && pnpm install --frozen-lockfile`; checks: `pnpm run lint:js`, `typecheck:js`, `build:js`, `test:js`.

Python sandbox SDK (`sdks/sandbox/python`): `uv sync`, `uv run python scripts/generate_api.py` (regenerate client), `uv run ruff check`, `uv run pyright`, `uv run pytest tests/ -v`, `uv build`.
Python code-interpreter SDK (`sdks/code-interpreter/python`): same pattern, no generator step.
JS sandbox SDK (`sdks/sandbox/javascript`): `pnpm run gen:api`, `lint`, `typecheck`, `build`, `test`. JS code-interpreter SDK (`sdks/code-interpreter/javascript`): same minus `gen:api`.
Kotlin SDK (`sdks/sandbox/kotlin`): `./gradlew :sandbox-api:generateLifecycleApi :sandbox-api:generateExecdApi :sandbox-api:generateEgressApi`, then `./gradlew spotlessApply :sandbox:test :code-interpreter:test`.
Go SDK (`sdks/sandbox/go`): `go test ./...`.

### Kubernetes (`kubernetes/`)

```bash
cd kubernetes
make setup-envtest
make test                 # envtest-based unit tests (Ginkgo/Gomega)
make build
make lint
make manifests generate   # MUST run after changing apis/ CRD types
make run                  # run controller locally
make test-e2e             # Kind-based e2e: core + task-executor + gViso
make test-e2e-main        # core e2e only
make helm-install / make deploy
```

Focused unit tests: `go test ./internal/controller/ -run TestAllocatorSchedule -v`; Ginkgo: `go test ./internal/controller/ -run TestControllers -v -ginkgo.focus='Pool allocate'`. Pause/resume: `go test ./internal/controller/ -run 'Test(DispatchPauseResume|HandlePause|HandleResume|ContinueResume|CompletePause|SyncPauseOrClear|SandboxSnapshot)' -v`. E2E troubleshooting: `kubernetes/docs/E2E-TROUBLESHOOTING.md`.

### Go components (`components/execd`, `ingress`, `egress`)

Per-component: `go mod download`, `go build ./...`, `gofmt -w .` (or `make fmt`), `go vet`, `golangci-lint` where configured. execd dev run: `./bin/execd --jupyter-host=http://localhost:8888 --port=44772`. See each component's `README.md` / `DEVELOPMENT.md`.

### Specs (`specs/`)

Spec files are the source of truth for public contracts. Validate consumers after edits (`server`: `uv run ruff check && uv run pytest`; SDKs: affected-language checks). Keep operation IDs, schema names, examples, and descriptions consistent; prefer additive, backward-compatible changes.

### Docs (`docs/`)

VitePress site; every page needs YAML frontmatter (`title`, `description`); images in `docs/public/images/`; internal links use absolute paths (e.g., `/sdks/python`). Build: `cd docs && pnpm docs:build` (must complete with zero errors). Long-form docs live in `docs/`, not package READMEs.

### End-to-end tests (`tests/`, `scripts/`)

Per-language e2e scripts exist in `scripts/` (`python-e2e.sh`, `go-e2e.sh`, `java-e2e.sh`, `javascript-e2e.sh`, `csharp-e2e.sh`, `python-k8s-e2e.sh`); the `real-e2e.yml` workflow runs them against a live server. They require a running server + Docker.

## Development Conventions

- **Commits**: Conventional Commits (`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci` + scope, e.g. `fix(server): ...`).
- **Branching**: `main` is stable; `feature/[name]`, `fix/[name]`, `docs/[name]`, `refactor/[name]`, `test/[name]`.
- **OSEP**: Major features, architectural changes, or core API/security-model changes require an OSEP proposal (`oseps/`). Small fixes don't.
- **Coding standards** (enforced in CI): Python — PEP 8 + ruff + Google-style docstrings on public APIs (`server/pyproject.toml`, `server-test.yml`); Go — Effective Go, gofmt/go vet/golangci-lint; JS/TS — `sdks/eslint.base.mjs` + tsc; Kotlin — Spotless/ktlint; C# — `.editorconfig` + analyzers, warnings-as-errors.
- **Generated code**: Never hand-edit generator-owned output (Python `src/opensandbox/api/**`, JS `src/api/*.ts`, Kotlin `build/generated/**`, CRD YAML/DeepCopy). Change the source spec/CRD type and regenerate.
- **Tests**: Add a regression test for every bug fix; update tests when behavior changes; prefer focused package-scoped checks before full-suite validation.
- **Docs**: Update `docs/` first when user-visible or operations-visible behavior changes; keep spec, implementation, SDKs, docs, examples, config, and CLI behavior aligned; regen derived outputs.

## Working Guidelines (Qwen Code)

- Always read the nearest `AGENTS.md`/`README.md` for the area you're touching: root `AGENTS.md` routes to `server/AGENTS.md`, `sdks/AGENTS.md`, `specs/AGENTS.md`, `kubernetes/AGENTS.md`, and component READMEs.
- Cross-cutting changes (spec → server → SDKs) start at `specs/AGENTS.md`, then check affected consumers.
- Be surgical: touch only files/lines needed; match local style; don't refactor unrelated code; don't mix unrelated component work into one change.
- **Ask first** before: breaking public API/SDK/config/CLI/protocol changes; CRD/annotation/label/Helm changes; intentional contract drift; user-visible config changes without a migration story.
- Verify with the area-appropriate commands above (lint + tests + docs build where applicable) and report unrun or blocked verification honestly.
