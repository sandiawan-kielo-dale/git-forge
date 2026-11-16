// tests/smoke.mjs — end-to-end smoke test for the git-forge entry.
// Starts the dev server on 127.0.0.1:18081, exercises every surface over HTTP
// (healthz, REST, GraphQL, MCP, git smart HTTP), then stops it.
// Usage: node --test tests/        (or: node tests/smoke.mjs)
// Requires: Node >= 22. No dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token';
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json' };

async function waitForHealthz(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('dev server did not answer /healthz in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('git-forge smoke', async (t) => {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'dev.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), MAKEFUN_SHOP_TOKEN: TOKEN },
      stdio: 'ignore',
    },
  );
  t.after(() => {
    child.kill('SIGTERM');
  });
  await waitForHealthz();

  // Health probe.
  const health = await fetch(`${BASE}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  // Auth: no token -> 401 with a JSON message.
  const anon = await fetch(`${BASE}/api/v3/user`);
  assert.equal(anon.status, 401);
  assert.equal(typeof (await anon.json()).message, 'string');

  // REST: the viewer is the scenario identity.
  const user = await fetch(`${BASE}/api/v3/user`, { headers: H });
  assert.equal(user.status, 200);
  assert.equal((await user.json()).login, 'adaiversen');

  // REST: create a repo, read it back, create an issue.
  const created = await fetch(`${BASE}/api/v3/user/repos`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ name: 'smoke-repo', description: 'smoke test', private: false }),
  });
  assert.equal(created.status, 201);
  const repo = await created.json();
  assert.equal(repo.full_name, 'adaiversen/smoke-repo');
  assert.ok(repo.id > 0);

  const issue = await fetch(`${BASE}/api/v3/repos/adaiversen/smoke-repo/issues`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ title: 'smoke issue', body: 'hello' }),
  });
  assert.equal(issue.status, 201);
  assert.equal((await issue.json()).number, 1);

  // GraphQL: viewer login + repository fields.
  const gql = await fetch(`${BASE}/api/graphql`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      query: `query { viewer { login } repository(owner: "adaiversen", name: "smoke-repo") { id databaseId name nameWithOwner viewerPermission hasIssuesEnabled } }`,
    }),
  });
  assert.equal(gql.status, 200);
  const gqlBody = await gql.json();
  assert.equal(gqlBody.data.viewer.login, 'adaiversen');
  assert.equal(gqlBody.data.repository.nameWithOwner, 'adaiversen/smoke-repo');

  // MCP: discover + tools/list + create_repo.
  const discover = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
  });
  assert.equal(discover.status, 200);
  const disc = await discover.json();
  assert.ok(disc.result.supportedVersions.includes('2026-07-28'));
  assert.equal(disc.result.serverInfo.name, 'git-forge');

  const tools = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const toolsBody = await tools.json();
  const names = toolsBody.result.tools.map((tool) => tool.name);
  for (const required of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
    assert.ok(names.includes(required), `missing MCP tool ${required}`);
  }

  const call = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_repo', arguments: { owner: 'adaiversen', name: 'smoke-mcp', description: 'via MCP', private: false } },
    }),
  });
  assert.equal(call.status, 200);
  const callBody = await call.json();
  assert.equal(callBody.result.isError, false);
  assert.equal(callBody.result.structuredContent.full_name, 'adaiversen/smoke-mcp');

  // Git smart HTTP: v0 and v2 advertisements, unknown repo 404.
  const advV0 = await fetch(`${BASE}/adaiversen/smoke-repo.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(advV0.status, 200);
  assert.match(advV0.headers.get('content-type') ?? '', /x-git-upload-pack-advertisement/);

  const advV2 = await fetch(`${BASE}/adaiversen/smoke-repo.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${TOKEN}`, 'Git-Protocol': 'version=2' },
  });
  assert.equal(advV2.status, 200);
  assert.match(await advV2.text(), /version 2/);

  const missing = await fetch(`${BASE}/adaiversen/no-such-repo.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(missing.status, 404);
});
