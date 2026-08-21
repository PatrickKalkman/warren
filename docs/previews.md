# Preview environments

A project can ask warren to start a web application from a successful run's workspace. Reviewers can inspect the result without checking out the branch.

Previews are optional. A project without `.warren/preview.yaml` skips this lifecycle step. The Kubernetes runtime currently declares `previewPorts: false` and does not launch previews.

## Project configuration

Create `.warren/preview.yaml` in the repository:

```yaml
type: server
command: bun run dev
port: 3000
readiness_path: /healthz
idle_ttl: 30m
max_lifetime: 8h
```

Warren starts `command` in the completed run workspace, waits for the readiness path, and records the allocated preview URL on the run.

## Path mode, the default

`WARREN_PREVIEW_MODE=path` is the default. It needs no wildcard DNS or `WARREN_PREVIEW_HOST`. A preview URL uses the warren hostname and a run path:

```text
https://warren.example.com:8081/p/<run-id>/
```

Path-mode previews use a dedicated listener on `WARREN_PREVIEW_PORT`, which defaults to the main bind port plus one. Publish that port beside the API port. The main warren origin redirects `/p/<run-id>/` to the preview listener, so agent-authored code runs on a different browser origin from the operator UI.

The shipped Compose file publishes port 8081. A reverse proxy must route the preview listener as a second origin on the same hostname. A unix-socket-only deployment cannot create this TCP origin and retains legacy same-origin behavior; warren warns at boot. Use subdomain mode when that deployment runs untrusted preview code.

## Subdomain mode

Set both values to opt into one hostname per preview:

```dotenv
WARREN_PREVIEW_MODE=subdomain
WARREN_PREVIEW_HOST=preview.warren.example.com
```

Point wildcard DNS at the warren edge:

```text
*.preview.warren.example.com CNAME warren.example.com
```

Warren then routes `run-<runId>.preview.warren.example.com` to the corresponding sandbox sidecar. Subdomain mode requires `WARREN_PREVIEW_HOST`; without it, the preview surface is disabled while the completed run remains successful.

## Authentication

`POST /runs/:id/preview/login` accepts the operator bearer and issues a signed preview cookie. Path mode scopes the cookie to the run path and uses a run-specific cookie name. Subdomain mode scopes the cookie to the configured preview domain. The proxy strips `Authorization` and `Cookie` before forwarding a request to agent-authored code.

## TLS

TLS belongs at the operator's edge. Path mode uses the certificate for the warren hostname and the separately proxied preview port. Subdomain mode needs a wildcard certificate, which requires a DNS challenge. A Caddy deployment can use a provider plugin:

```caddyfile
*.preview.warren.example.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy localhost:8080
}
```

The exact configuration depends on the DNS provider and preview mode. Do not expose preview traffic without reviewing the origin and cookie boundary in [Security](../SECURITY.md).

## Lifecycle

Warren reaps previews after their idle TTL or maximum lifetime. The run page shows status and offers manual teardown. Environment variables in `.env.example` configure deployment-wide live-count, lifetime, idle, and port-range limits. Project values can narrow the time limits.

`/readyz` reports preview allocator saturation. A missing `WARREN_PREVIEW_HOST` affects only subdomain mode; default path mode derives its host from the incoming warren request.

## Limitations

- Kubernetes run pods do not expose preview ports in the current provider.
- Warren does not route a local preview to another worker host.
- A preview runs repository code. Treat it as untrusted and keep it on a separate browser origin from the operator UI.

The full lifecycle contract and security rationale live in [the preview design record](design/preview-environments.md).
