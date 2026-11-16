# Tests

- `tests/smoke.mjs` — end-to-end smoke test. It starts the dev server on
  `127.0.0.1:18081` itself, checks `/healthz`, auth (401 without a token),
  REST (create repo + issue), GraphQL (viewer + repository), MCP
  (`server/discover`, `tools/list`, `tools/call create_repo`) and the git
  smart-HTTP advertisements (v0 + v2, unknown repo 404), then stops the
  server. Run with `npm test` or `node --test tests/smoke.mjs`.

- Full conformance: the kit's sealed suite, not in this repo. From a **fresh**
  dev server (the suite creates repos, so a stale server fails with
  422 "already exists"):

  ```sh
  MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts
  # in another shell, from the kit directory:
  node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8080 \
    --token test-token --perf --json
  ```

  Last verified result (2026-11-16): 120/120 checks, score 974/1000
  (feature 600, agent 200, perf 174).
