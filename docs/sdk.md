# TypeScript SDK

`@os-eco/warren-cli` exports a browser-safe TypeScript client for the warren HTTP API. The same package also supplies the `warren` and `wr` command-line programs.

Install the package with Bun available on the calling machine:

```bash
npm install @os-eco/warren-cli
```

## Create a client

```ts
import { WarrenClient } from "@os-eco/warren-cli/client";

const warren = WarrenClient.fromEnv();
await warren.probe();
```

`fromEnv()` reads `WARREN_BASE_URL` and `WARREN_API_TOKEN`. The default base URL is `http://localhost:8080`.

## Dispatch and wait

```ts
const { run } = await warren.dispatch({
  agent: "claude-code",
  project: "my-project",
  prompt: "Add input validation to the signup form",
});

const final = await warren.waitForRun(run.id, {
  onTick: (current) => console.log(`${current.id}: ${current.state}`),
});

console.log(final.state);
console.log(final.prUrl);
```

The pushed branch is the stable delivery boundary. `prUrl` can be null when PR creation is disabled, unsupported, or fails after the push.

## Events and intervention

Use `streamRunEvents` to replay or follow the normalized event stream. The client also exposes steering, cancellation, run detail, project management, and plan-run methods.

A harness must declare and implement a compatible steering transport before a steering message can affect its live process. Runtime capability flags let callers distinguish supported and degraded behavior.

## Errors

Remote API failures throw `WarrenClientError`, which includes HTTP status, machine code, and a recovery hint when the server supplies one. Reachability failures throw `WarrenUnreachableError`.

The generated [OpenAPI document](openapi.yaml) is the canonical HTTP schema. Public SDK types re-export wire vocabulary from `src/core/wire.ts` so lifecycle states do not drift between server, client, and UI.

## CLI relation

The CLI is a consumer of the same SDK and HTTP surface. It does not import server handlers or implement a second dispatch path. Read the [CLI reference](cli-reference.md) for commands, flags, output formats, and exit codes.
