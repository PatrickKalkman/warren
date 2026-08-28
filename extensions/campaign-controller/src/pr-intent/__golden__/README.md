# Golden fixtures for the cross-fork PR intent

Per-profile goldens pin the exact upstream pull-request request the
campaign controller renders for the canonical OpenClaw dry-run scenario
(approved `camp-openclaw-eod-v0`, succeeded run `seq-1` on branch
`warren/issue-812` of the `warren-run-bot` fork, issue #812):

- `openclaw-pr-intent.json` — the `openclaw` profile. Its body matches
  the one that passed the live CI gate on openclaw#131131.
- `default-pr-intent.json` — the generic `default` profile contract.

Each golden's digest is over the canonical JSON of the request body —
the same digest journaled as the `pr_intent` action's `request_digest`.

The request is evidence only: V0 has no GitHub mutation transport, so
this request can never be posted. Regenerate with:

```bash
WARREN_UPDATE_GOLDENS=1 bun test src/pr-intent/intender.test.ts
```
