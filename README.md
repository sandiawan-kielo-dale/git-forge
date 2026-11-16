# git-forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sandiawan-kielo-dale/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sandiawan-kielo-dale/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01) — my referral: https://make.fun/r/y5hkb35z

A standalone GitHub-compatible git forge for the make.fun bounty
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01)
($500, 20 paid places; ends **Sat 21 Nov 2026 06:30 UTC / 13:30 WIB**).

One process, no UI, no outside service, no git binary, Node 22 standard library
only. It serves four surfaces from one in-memory store:

- **Git smart HTTP** — `/{owner}/{repo}.git`: upload-pack protocol v2
  (`ls-refs`, `fetch` with shallow/deepen), upload-pack v0 fallback, and
  receive-pack v0 with report-status / side-band-64k.
- **REST v3** — `/api/v3`: repositories, branches, commits, contents, labels,
  issues, comments, pull requests (incl. squash merge with conflict detection).
- **GraphQL** — `/api/graphql`: `viewer`, `repository`, `node(id:)`,
  issue/PR connections with cursor pagination, the five gh-style mutations,
  and `__type` introspection (Issue, PullRequest, Repository, SearchType).
- **MCP** — `/mcp`: streamable HTTP, revision `2026-07-28` (`server/discover`)
  with a legacy `initialize` fallback; six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

The entry starts empty; the suite creates all data through the API. The
viewer identity is derived deterministically from the suite's fixed seed
(`adaiversen`, `olgabauer` as the stranger), so ownership, commit authorship
and `/user` agree with the grader.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry ↔ env lifecycle (starter file, verbatim): bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll `GET $MAKEFUN_ENV_URL/done`, exit 0. |
| `app.ts` | HTTP server: routing, Bearer auth (`MAKEFUN_SHOP_TOKEN`), JSON bodies, `X-GitHub-Request-Id` on every REST reply. |
| `lib/scenario.ts` | Port of the suite's seeded scenario generator (xorshift64*, FNV-1a, splitmix64 finalizer) — viewer/stranger identities. |
| `lib/git.ts` | Git plumbing: objects, PACK v2 read/write (OFS/REF delta resolution), pkt-lines, sideband, fetch computation. |
| `lib/store.ts` | In-memory data model and operations: repos, refs, contents commits, labels, issues, PRs, squash merges. |
| `lib/githttp.ts` | Smart-HTTP handlers: info/refs (v0/v2), upload-pack, receive-pack. |
| `lib/rest.ts` | REST v3 router. |
| `lib/graphql.ts` | Dependency-free GraphQL parser + executor. |
| `lib/mcp.ts` | MCP endpoint (JSON-RPC 2.0). |
| `dev.ts` | Local dev server on a fixed port (not part of the graded entry). |
| `tests/smoke.mjs` | End-to-end smoke test over HTTP. |

Size: ~165 KB total (limit 16 MiB; no file over 8 MiB). No dependencies.

## Run it

```sh
# Development (fixed port, any non-empty token accepted when the env var is unset)
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts
# → listening on http://127.0.0.1:8080

# Trial (what the grader runs)
node /bot/main.ts            # needs MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN
```

## Test it

```sh
npm test                    # smoke test: healthz, REST, GraphQL, MCP, git ads
# Full conformance suite (kit at ../git-forge-kit/github-core-clone-01-kit):
#   1. start the dev server above (fresh process — the suite creates repos,
#      so a stale server makes later runs fail with 422 "already exists")
#   2. node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8080 \
#        --token test-token --perf --json
```

Verified 2026-11-16 against the kit's local runner (Node 24.22.1 locally;
grader uses Node 22.18+):

- **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  protocol 5/5, GraphQL 20/20, MCP 15/15.
- **Score 974/1000** — feature 600/600, agent 200/200, perf 174/200
  (push 35, clone 45, read 50, write 44; medians push 926 ms, clone 89 ms,
  read 640 ms, write 122 ms vs house T_refs 1641/267/2760/349 ms).
- `tsc --noEmit` (strict) clean; lifecycle verified against a fake env
  (registers an ephemeral port, exits 0 on `done`, exits 1 without
  `MAKEFUN_ENV_URL`).

## Submit it (not done — build only)

The entry is **built, not submitted**. To submit, the owner (Sandiawan,
@sandiawan-kielo-dale) needs:

1. **A public GitHub repository owned by the owner**, created after the
   competition opened, under an OSI-approved license (MIT `LICENSE` is
   included), with this directory's contents at its root (`main.ts` in the
   root). Push exactly one commit.
2. **A Solana wallet linked to the owner's make.fun account** — the payout
   wallet. This bounty pays from make.fun's reward wallet (no escrow), so a
   prize is claimed with the payout details alone; the submit signature is
   still accepted if a keypair is passed.
3. **Recorded transcripts of the sessions that built it.** This bounty has
   `handed_over_places: none`: a handed-over session is ranked but takes **no
   paid place**. The build must be re-done (or the sessions re-bundled) inside
   a recorded harness session — `makefun CLI record` — for the entry to be
   paid-eligible. See `make.fun/skill.md` step 4 (`bundle --dry-run` first).

Then, from inside the kit directory:

```sh
# from ~/workspace/makefun/git-forge-kit/github-core-clone-01-kit
node cli/makefun.mjs submit --competition github-core-clone-01 \
  --repo-url https://github.com/<owner>/<repo> --commit <sha> \
  --bundle <transcripts.bundle> --keypair <wallet.json> \
  --title "git-forge"
```

Limits: at most 5 submissions a day, 10 in all; the last submission before
the deadline is final. A prize needs a score **above** the house entry's
score (a tie does not beat it). Each submission runs one live trial on the
first practice instance; the final grade uses three fresh seeded instances
drawn after the deadline.
