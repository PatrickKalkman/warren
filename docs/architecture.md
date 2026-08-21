# Architecture

Warren turns an agent harness invocation into a managed run. The domain owns one lifecycle while provider seams replace the surrounding infrastructure.

```text
                         UI · CLI · SDK
                               │
                               ▼
                    HTTP API and run domain
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
  AgentRuntimeAdapter    RuntimeProvider            Forge
  harness semantics      workload placement      Git delivery
         │                     │                     │
   Pi · Claude Code      local · docker · k8s       GitHub
                               │
                               ▼
                     persisted run + events
```

## The run kernel

The irreducible flow is:

```text
project registry → dispatch → isolated run → event stream
→ steer or cancel → finalize → push branch → teardown
```

The run row freezes the resolved agent, provider, model, limits, and workspace intent at dispatch. Later registry or project edits do not mutate an in-flight run.

The pushed workspace branch is the kernel's guaranteed output. Pull requests, tracker updates, memory synchronization, previews, audit projections, and judge verdicts happen around that boundary when configured.

## Harness adapters

`AgentRuntimeAdapter` owns harness-specific behavior:

- Command and argument construction
- Event parsing and normalization
- Terminal and provider-error detection
- Usage extraction
- Steering encoding
- Harness-owned workspace paths

A harness is compatible when it has a Warren adapter and its executable exists in the selected runtime image or host toolchain. The current distribution includes Pi and Claude Code adapters.

## Runtime providers

`RuntimeProvider` owns workload placement and transport. Warren resolves one provider at boot from `WARREN_RUNTIME`.

- `local` creates a worktree and runs the harness in a warren-owned `bwrap` sandbox on Linux or `sandbox-exec` sandbox on macOS.
- `docker` creates a sibling agent container over the Docker socket.
- `k8s` creates one Kubernetes pod per run.

Capability flags declare differences such as preview ports, network policy, steering, resource limits, archival, and garbage collection. Domain code branches on capabilities rather than provider names.

## Forge and tracker seams

The `Forge` seam owns repository references, Git credentials, branch delivery, pull requests, and checks. GitHub PAT and GitHub App modes ship today.

The `IssueTracker` seam owns work items and plan capabilities. Seeds is the in-process implementation. `RemoteTracker` bridges to external tracker containers through `warren-tracker/v1`.

Neither seam calls the other. Domain orchestration coordinates tracker and forge behavior after the run.

## Storage

SQLite is the default. Postgres is optional through `WARREN_DB_URL`. The database stores projects, agents, runs, normalized events, inbox messages, plan-run state, and operational analytics.

Project-owned configuration remains in Git under `.warren/`. Optional Seeds and Mulch data also remain project files rather than warren database mirrors.

## Extensions

Extensions consume published boundaries and remain outside core. The audit-log and judge packages are optional, out-of-process examples. A base installation does not launch them.

The lifecycle bus defines the event vocabulary, but warren does not yet ship a general extension loader or public catalog. Read [Extensions](design/extensions.md) for the delivered and proposed boundaries.

## Source map

- `src/runs/` — dispatch, event bridge, analytics, finalization, and reap
- `src/runtime/` — runtime provider contract and implementations
- `src/runtime/adapters/` — harness-specific behavior
- `src/forge/` — forge contract and GitHub transports
- `src/tracker/` — issue tracker contract and implementations
- `src/projects/` — managed clones and project registration
- `src/server/` — HTTP routes, auth, boot wiring, and static UI
- `src/client/` — typed HTTP client
- `src/ui/` — React application
- `src/db/` — SQLite and Postgres adapters

Detailed decisions live under [`docs/design/`](design/README.md). Operator procedures live in [Quickstart](quickstart.md), [Docker self-hosting](self-host/docker.md), and the [Kubernetes runbook](RUNBOOK-K8S.md).
