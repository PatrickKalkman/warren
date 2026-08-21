# Quickstart

This guide takes a fresh Linux Docker host from no warren installation to a completed run with a pushed branch. For other Docker topologies and macOS requirements, read [Docker self-hosting](self-host/docker.md).

## Requirements

- A Linux host with Docker and Docker Compose.
- An Anthropic API key for the shipped default agent path.
- A GitHub token that can clone and push to the target repository.
- A Git author name and email for agent commits. Use a dedicated machine account and its GitHub noreply address.
- A target repository whose branch and workflow rules permit the bot account to push a run branch.

Warren supports other model providers through compatible harness configuration. The first-run path uses two secrets, plus non-secret Git identity metadata.

## Start warren

```bash
git clone https://github.com/jayminwest/warren
cd warren
cp .env.example .env
$EDITOR .env
```

Set at least these values in `.env`:

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
WARREN_GIT_AUTHOR_NAME=your-bot-login
WARREN_GIT_AUTHOR_EMAIL=1234567+your-bot-login@users.noreply.github.com
```

`WARREN_GIT_AUTHOR_NAME` and `WARREN_GIT_AUTHOR_EMAIL` are not secrets. Warren installs both as the Git author and committer identity. If either is absent, warren warns and falls back to the host identity, which is usually unset in a fresh container.

Then start the service:

```bash
docker compose up -d
docker compose logs warren | grep mintedOperatorToken
```

Leave `WARREN_API_TOKEN` unset on the first boot. Warren creates an operator token, stores it under the data directory, and prints it once in the structured boot log. Copy the `mintedOperatorToken` value, then export it in the shell that will run the authenticated checks and CLI commands:

```bash
export WARREN_API_TOKEN='<mintedOperatorToken value>'
```

Paste that same value into the UI login screen.

The Compose file selects the `local` runtime. It includes the Linux security settings required for Warren to create a separate `bwrap` sandbox for each run. The named volume stores the database, managed clones, and runtime state.

## Dispatch the first run

1. Open <http://localhost:8080>.
2. Paste the minted operator token from the boot log.
3. Open **Projects**, select **Add**, and enter the target GitHub URL.
4. Select **Dispatch run**.
5. Select an agent, enter a small task, and start the run.
6. Watch the event stream until the run reaches a terminal state.

A successful run finalizes its workspace and pushes the run branch. Warren opens a pull request when the forge and project configuration permit it. The pushed branch is the kernel's guaranteed delivery boundary.

## Verify the deployment

```bash
curl http://localhost:8080/healthz
curl -H "Authorization: Bearer $WARREN_API_TOKEN" \
  http://localhost:8080/readyz
```

`/healthz` is an auth-free liveness probe. `/readyz` checks the database, runtime, agent registry, and relevant configuration.

Install the CLI when you want to dispatch from a shell:

```bash
npm i -g @os-eco/warren-cli
echo "$WARREN_API_TOKEN" | warren login --url http://localhost:8080
warren projects
```

The package requires Bun v1.1 or later because it ships raw TypeScript with a Bun shebang.

## Next steps

- [Configure a project](project-setup.md).
- [Operate the service](operations.md).
- [Use the Docker sibling-container runtime](self-host/docker.md).
- [Deploy to Kubernetes](RUNBOOK-K8S.md).
- [Configure previews](previews.md).
- [Read the CLI reference](cli-reference.md).
