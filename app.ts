// app.ts — the forge's HTTP server: health probe, git smart HTTP, REST v3,
// GraphQL and MCP, all from one in-memory store. Node stdlib only.
//
// Auth: every surface except /healthz requires `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN` (when the env var is unset, any non-empty Bearer token
// is accepted, for local development). A missing or wrong token is 401 with a
// JSON `message`. Every REST reply is JSON and carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './lib/githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function urlOf(req: IncomingMessage): URL {
  // Build the request URL against the Host the client dialed, so absolute
  // pagination links stay on the entry's origin.
  const host = req.headers.host ?? 'entry';
  try {
    return new URL(req.url ?? '/', `http://${host}`);
  } catch {
    return new URL('/', `http://${host}`);
  }
}

function pathOf(req: IncomingMessage): string {
  return urlOf(req).pathname;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (TOKEN !== '') return token === TOKEN;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(forge: Forge = new Forge()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // All other surfaces require a Bearer token.
      if (!authorized(req)) {
        const headers: Record<string, string> = {};
        if (path.startsWith('/api/v3')) headers['X-GitHub-Request-Id'] = forge.nextRequestId();
        sendJson(res, 401, { message: 'Requires authentication' }, headers);
        return;
      }

      // MCP (streamable HTTP).
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const text = (await readBody(req)).toString('utf8');
        const out = handleMcp(forge, text);
        if (out.empty) {
          res.writeHead(out.status);
          res.end();
          return;
        }
        sendJson(res, out.status, out.body);
        return;
      }

      // GraphQL.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const text = (await readBody(req)).toString('utf8');
        let body: unknown;
        try {
          body = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return;
        }
        sendJson(res, 200, handleGraphQL(forge, body));
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const url = urlOf(req);
        let body: unknown;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Invalid JSON body' }, { 'X-GitHub-Request-Id': forge.nextRequestId() });
              return;
            }
          }
        }
        const result = handleRest({ forge, method, url, body, requestId: forge.nextRequestId() });
        const headers: Record<string, string> = {
          'X-GitHub-Request-Id': forge.nextRequestId(),
          ...(result.headers ?? {}),
        };
        if (result.status === 204) {
          res.writeHead(204, headers);
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, headers);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/<service-path>.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const [, owner, repoName, servicePath] = gitMatch;
        const repo = forge.resolveOwnerRepo(owner, repoName);
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        let url: URL;
        try {
          url = urlOf(req);
        } catch {
          sendJson(res, 400, { message: 'Bad Request' });
          return;
        }
        const gitProtocolRaw = req.headers['git-protocol'];
        const gitProtocol = Array.isArray(gitProtocolRaw) ? gitProtocolRaw[0] ?? null : gitProtocolRaw ?? null;
        if (servicePath === 'info/refs') {
          if (method !== 'GET') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const out = handleInfoRefs(repo, service, gitProtocol);
          sendBytes(res, out.status, out.contentType, out.body);
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const body = await readBody(req);
        if (servicePath === 'git-upload-pack') {
          const out = handleUploadPack(forge, repo, body, gitProtocol);
          sendBytes(res, out.status, out.contentType, out.body);
          return;
        }
        const out = handleReceivePack(forge, repo, body);
        sendBytes(res, out.status, out.contentType, out.body);
        return;
      }

      // Everything else: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err) => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        else res.end();
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });
}
