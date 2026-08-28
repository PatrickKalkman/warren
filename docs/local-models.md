# Local models

Warren targets cloud agent workloads. Local model serving is not a project
goal, and warren ships no dedicated feature for it. The existing seams
still permit it, and this page records the supported recipe.

A smoke test on 2026-08-28 confirmed the recipe against pi 0.84.3,
Ollama, and warren's LocalProvider on macOS, in warren's exact spawn
argv.

The recipe applies to any server that speaks an OpenAI-compatible API:
Ollama, LM Studio, vLLM, llama.cpp, or a private gateway. It also covers
remote OpenAI-compatible endpoints, not only localhost ones.

## How it works

The pi runtime registers custom model providers through pi extensions. An
extension names a provider, a base URL, an API shape, and a model list.
Three warren seams carry that into a run:

- The agent definition's `pi_extensions` section. Warren writes each
  entry to `.pi/extensions/<name>.ts` in the run workspace before spawn.
- The agent's `frontmatter.pi.extension` list. Each entry renders an
  explicit `--extension <path>` flag. Warren forces `--no-extensions`,
  which stops extension discovery, but pi still loads explicit paths.
- The agent's `frontmatter.provider` and `frontmatter.model`. These
  render pi's `--provider` and `--model` flags. Provider names outside
  warren's registry are legal at dispatch and contribute no env keys.

No credential env vars are necessary. The extension carries a literal
placeholder key, which keyless local servers ignore.

Note that pi does not read `OPENAI_BASE_URL`. The `openai` provider entry
in warren's registry forwards that variable into the sandbox, but pi
0.84.3 ignores it. The extension path above is the one that works.

## Recipe

Step 1. Serve a model on an OpenAI-compatible endpoint. Pick a model
that supports tool calls, because a coding agent is unusable without
them. With Ollama:

```bash
ollama pull qwen3-coder:30b
curl -s http://localhost:11434/v1/models   # confirm the endpoint answers
```

Step 2. Write a seed-agents file. The `WARREN_SEED_AGENTS_FILE` env var
points warren at a JSON array of agent definitions, seeded at every
boot beside the built-ins. This example registers a `local-pi` agent:

```json
[
  {
    "name": "local-pi",
    "version": 1,
    "sections": {
      "system": "You are a coding assistant. Edit files in place, run tests, and commit your changes. Do not push.",
      "burrow_config": "[sandbox]\nnetwork = \"open\"\n",
      "pi_extensions": "{\"name\": \"local-models\", \"body\": \"export default function (pi) {\\n\\tpi.registerProvider(\\\"ollama\\\", {\\n\\t\\tbaseUrl: \\\"http://localhost:11434/v1\\\",\\n\\t\\tapi: \\\"openai-completions\\\",\\n\\t\\tapiKey: \\\"ollama\\\",\\n\\t\\tcompat: { supportsDeveloperRole: false, supportsReasoningEffort: false },\\n\\t\\tmodels: [\\n\\t\\t\\t{\\n\\t\\t\\t\\tid: \\\"qwen3-coder:30b\\\",\\n\\t\\t\\t\\treasoning: false,\\n\\t\\t\\t\\tinput: [\\\"text\\\"],\\n\\t\\t\\t\\tcost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },\\n\\t\\t\\t\\tcontextWindow: 128000,\\n\\t\\t\\t\\tmaxTokens: 8192,\\n\\t\\t\\t},\\n\\t\\t],\\n\\t});\\n}\\n\"}"
    },
    "resolvedFrom": ["seed:local-pi"],
    "frontmatter": {
      "source": "builtin",
      "runtime": "pi",
      "provider": "ollama",
      "model": "qwen3-coder:30b",
      "pi": { "extension": [".pi/extensions/local-models.ts"] }
    }
  }
]
```

The `pi_extensions` value is one JSON envelope per line with `name` and
`body` fields. The `body` is the extension source. Unescaped, it reads:

```typescript
export default function (pi) {
	pi.registerProvider("ollama", {
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		apiKey: "ollama",
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: [
			{
				id: "qwen3-coder:30b",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
}
```

Keep `"source": "builtin"` in the frontmatter. Seeding only updates an
existing row when it carries that provenance, so without it, later
edits to the seed file never reach the agents table.

Step 3. Boot warren with the seed file and dispatch:

```bash
WARREN_SEED_AGENTS_FILE=/path/to/local-agents.json warren serve
warren run local-pi prj_xxx -p "fix the failing test in src/foo.test.ts"
```

The `--provider` and `--model` dispatch flags override the frontmatter
values per run, so one agent definition can serve several local models
that the same extension registers.

## Network policy

The agent's `burrow_config` section must open the sandbox network. The
default policy is `none`, which blocks all traffic. Two policies work:

- `network = "open"`. The sandbox shares the host network, so
  `localhost` reaches a server on the warren host.
- `network = "restricted"`, with `localhost` in `allowed_domains`. The
  proxy dials targets from the host side, so a server on the warren
  host stays reachable.

## Limits

- LocalProvider only. Under the Docker and K8s providers, `localhost`
  points inside the container or pod, not at the host. A reachable
  address for the model server (for Docker Desktop,
  `host.docker.internal`) must go in the extension's `baseUrl`.
- Cost enforcement is inert. The extension declares zero cost per token,
  so `maxCostUsd` caps never trigger for these runs.
- Model quality is your problem. Warren's run contract (commit, quality
  gates, PR delivery) assumes an agent that can follow it. Small local
  models frequently cannot.
- The pi extension API is upstream surface, not warren surface. See the
  pi package's `docs/custom-provider.md` and `docs/models.md` for the
  full provider config, compat flags for vLLM and SGLang, and reasoning
  controls.

## What was verified

The smoke test replicated warren's spawn exactly: pi in `--mode rpc`
with the forced argv (`--no-extensions --offline`, plus the explicit
`--extension` flag), a fresh empty HOME like the per-run sandbox home,
and a prompt on stdin.

Against Ollama, the run produced a full lifecycle (`agent_start`
through `agent_end`, exit 0), a correct text reply attributed to
`provider: "ollama"`, and a bash tool call that returned its output.
