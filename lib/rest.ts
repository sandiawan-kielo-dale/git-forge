// rest.ts — GitHub REST API v3 surface, as exercised by the conformance suite.
// Every reply is JSON with X-GitHub-Request-Id; 4xx bodies carry a `message`.

import type { Forge, Repo } from './store.ts';

export interface RestContext {
  forge: Forge;
  method: string;
  url: URL;
  body: unknown;
  requestId: string;
}

export type RestResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const notFound = (message = 'Not Found'): RestResult => json(404, { message });
const badRequest = (message: string): RestResult => json(400, { message });
const unprocessable = (message: string): RestResult => json(422, { message });

function asObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

interface PageOpts { page: number; perPage: number }

function pageOpts(url: URL): PageOpts {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { page, perPage };
}

/** Build a Link header for pagination (absolute URLs, same origin). */
function linkHeader(url: URL, page: number, perPage: number, total: number): string | undefined {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const build = (p: number): string => {
    const u = new URL(url.toString());
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return `<${u.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${build(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${build(page - 1)}; rel="prev"`);
  links.push(`${build(1)}; rel="first"`);
  links.push(`${build(totalPages)}; rel="last"`);
  return links.length > 0 ? links.join(', ') : undefined;
}

function paginate<T>(url: URL, items: T[]): { page: T[]; link?: string } {
  const { page, perPage } = pageOpts(url);
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), link: linkHeader(url, page, perPage, items.length) };
}

export function handleRest(ctx: RestContext): RestResult {
  const { forge, method, url } = ctx;
  const path = url.pathname;
  const seg = path.split('/').filter((s) => s.length > 0);
  // seg[0] === 'api', seg[1] === 'v3' (router strips nothing; handled here).
  const rest = seg.slice(2);

  // API root.
  if (rest.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{username}',
      meta_url: '/api/v3/meta',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0' });
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, forge.userView(forge.viewer));
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const { page, link } = paginate(url, forge.listRepos().map((r) => forge.repoView(r)));
      return json(200, page, link ? { Link: link } : undefined);
    }
    if (method === 'POST') {
      const b = asObject(ctx.body);
      const name = asString(b.name);
      if (!name) return unprocessable('Repository name is required');
      const result = forge.createRepo(name, { description: asString(b.description), private: b.private === true });
      if ('error' in result) return json(result.status, { message: result.error });
      return json(201, forge.repoView(result.repo));
    }
    return notFound();
  }

  if (rest[0] === 'repos') {
    return handleRepos(ctx, rest.slice(1));
  }

  return notFound();
}

function resolveRepo(ctx: RestContext, owner: string, name: string): Repo | RestResult {
  const repo = ctx.forge.resolveOwnerRepo(owner, name);
  if (!repo) return notFound();
  return repo;
}

function handleRepos(ctx: RestContext, rest: string[]): RestResult {
  const { forge, method, url } = ctx;
  if (rest.length < 2) return notFound();
  const [owner, name] = rest;
  const tail = rest.slice(2);

  // /repos/{owner}/{repo}
  if (tail.length === 0) {
    const repo = resolveRepo(ctx, owner, name);
    if ('status' in repo) return repo;
    if (method === 'GET') return json(200, forge.repoView(repo));
    if (method === 'PATCH') {
      const b = asObject(ctx.body);
      const desc = asString(b.description);
      if (desc !== undefined) repo.description = desc;
      return json(200, forge.repoView(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return notFound();
  }

  const repo = resolveRepo(ctx, owner, name);
  if ('status' in repo) return repo;

  // -- branches ------------------------------------------------------------
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, branches);
    }
    if (method === 'GET' && tail.length >= 2) {
      const branch = tail.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return notFound();
      return json(200, { name: branch, commit: { sha: oid } });
    }
    return notFound();
  }

  // -- commits --------------------------------------------------------------
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') return notFound();
    const shaParam = url.searchParams.get('sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(`refs/tags/${shaParam}`) ?? (repo.objects.get(shaParam)?.type === 'commit' ? shaParam : undefined);
    } else {
      tip = forge.headOid(repo);
    }
    if (!tip) return notFound();
    const { page } = paginate(url, forge.commitsFrom(repo, tip).map((oid) => {
      const obj = repo.objects.get(oid)!;
      const c = parseCommitText(obj.data);
      return { sha: oid, commit: { message: c.message, author: { name: c.authorName }, committer: { name: c.committerName } }, author: null, committer: null };
    }));
    return json(200, page);
  }

  // -- git/refs ---------------------------------------------------------------
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const b = asObject(ctx.body);
      const ref = asString(b.ref);
      const sha = asString(b.sha);
      if (!ref || !sha) return unprocessable('ref and sha are required');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      if (!repo.objects.get(sha)) return unprocessable('Object does not exist');
      forge.setRef(repo, ref, sha);
      return json(201, { ref, object: { sha } });
    }
    if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
      const branch = tail.slice(3).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return notFound();
      return json(200, { ref: `refs/heads/${branch}`, object: { sha: oid } });
    }
    return notFound();
  }

  // -- contents ---------------------------------------------------------------
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'PUT') {
      const b = asObject(ctx.body);
      const message = asString(b.message) ?? 'Update file';
      const contentB64 = asString(b.content);
      if (contentB64 === undefined) return badRequest('content is required');
      const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const result = forge.putContent(repo, path, {
        message,
        content,
        branch: asString(b.branch),
        sha: asString(b.sha),
      });
      if ('error' in result) return json(result.status, { message: result.error });
      return json(result.created ? 201 : 200, {
        content: { name: path.split('/').pop() ?? '', path, sha: result.blobSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitSha, message },
      });
    }
    if (method === 'GET') {
      const ref = url.searchParams.get('ref') ?? undefined;
      const result = forge.getContent(repo, path, ref);
      if ('error' in result) return json(result.status, { message: result.error });
      if (result.kind === 'file') {
        return json(200, {
          type: 'file', encoding: 'base64', size: result.size, name: path.split('/').pop() ?? '',
          path, content: result.content.toString('base64'), sha: result.blobOid,
        });
      }
      return json(200, result.entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha })));
    }
    if (method === 'DELETE') {
      const b = asObject(ctx.body);
      const sha = asString(b.sha);
      if (!sha) return badRequest('sha is required');
      const result = forge.deleteContent(repo, path, {
        message: asString(b.message) ?? 'Delete file',
        sha,
        branch: asString(b.branch),
      });
      if ('error' in result) return json(result.status, { message: result.error });
      return json(200, { commit: { sha: result.commitSha } });
    }
    return notFound();
  }

  // -- labels -----------------------------------------------------------------
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method !== 'POST') return notFound();
    const b = asObject(ctx.body);
    const name = asString(b.name);
    if (!name) return unprocessable('Label name is required');
    const result = forge.createLabel(repo, name, asString(b.color) ?? 'ededed', asString(b.description));
    if ('error' in result) return json(result.status, { message: result.error });
    return json(201, { name: result.label.name, color: result.label.color, description: result.label.description });
  }

  // -- issues -------------------------------------------------------------------
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const b = asObject(ctx.body);
        const title = asString(b.title);
        if (!title) return unprocessable('Title is required');
        const result = forge.createIssue(repo, title, asString(b.body) ?? '', asStringArray(b.labels));
        if ('error' in result) return json(result.status, { message: result.error });
        return json(201, forge.issueView(repo, result.issue));
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        const dir = direction === 'asc' ? 1 : -1;
        if (sort === 'created') issues.sort((a, b) => (a.number - b.number) * dir);
        const { page, link } = paginate(url, issues.map((i) => forge.issueView(repo, i)));
        return json(200, page, link ? { Link: link } : undefined);
      }
      return notFound();
    }
    const num = Number(tail[1]);
    if (!Number.isInteger(num)) return notFound();
    const issue = repo.issues.get(num);
    if (!issue) return notFound();
    if (tail.length === 2) {
      if (method === 'GET') return json(200, forge.issueView(repo, issue));
      if (method === 'PATCH') {
        const b = asObject(ctx.body);
        if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        if (Array.isArray(b.labels)) {
          const names = asStringArray(b.labels);
          for (const l of names) if (!repo.labels.has(l)) return unprocessable(`Label does not exist: ${l}`);
          issue.labels = names;
        }
        return json(200, forge.issueView(repo, issue));
      }
      return notFound();
    }
    if (tail[2] === 'comments' && tail.length === 3) {
      if (method === 'POST') {
        const b = asObject(ctx.body);
        const body = asString(b.body);
        if (!body) return unprocessable('Comment body is required');
        const result = forge.addComment(repo, num, body);
        if ('error' in result) return json(result.status, { message: result.error });
        return json(201, forge.commentView(repo, issue, result.comment));
      }
      if (method === 'GET') {
        const { page, link } = paginate(url, issue.comments.map((c) => forge.commentView(repo, issue, c)));
        return json(200, page, link ? { Link: link } : undefined);
      }
      return notFound();
    }
    return notFound();
  }

  // -- pulls ----------------------------------------------------------------------
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const b = asObject(ctx.body);
        const title = asString(b.title);
        const head = asString(b.head);
        const base = asString(b.base);
        if (!title || !head || !base) return unprocessable('title, head and base are required');
        const result = forge.createPull(repo, title, asString(b.body) ?? '', head, base);
        if ('error' in result) return json(result.status, { message: result.error });
        return json(201, forge.pullView(repo, result.pull));
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.number - a.number);
        const { page, link } = paginate(url, pulls.map((p) => forge.pullView(repo, p)));
        return json(200, page, link ? { Link: link } : undefined);
      }
      return notFound();
    }
    const num = Number(tail[1]);
    if (!Number.isInteger(num)) return notFound();
    const pull = repo.pulls.get(num);
    if (!pull) return notFound();
    if (tail.length === 2) {
      if (method !== 'GET') return notFound();
      return json(200, forge.pullView(repo, pull));
    }
    if (tail[2] === 'files' && tail.length === 3) {
      if (method !== 'GET') return notFound();
      return json(200, forge.pullFiles(repo, pull));
    }
    if (tail[2] === 'merge' && tail.length === 3) {
      if (method !== 'PUT') return notFound();
      const result = forge.mergePull(repo, pull, asString(asObject(ctx.body).merge_method) ?? 'merge');
      if ('error' in result) return json(result.status, { message: result.error });
      return json(200, { merged: true, sha: result.sha, message: result.message });
    }
    return notFound();
  }

  return notFound();
}

function parseCommitText(data: Buffer): { message: string; authorName: string; committerName: string } {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep >= 0 ? text.slice(0, sep) : text;
  const message = sep >= 0 ? text.slice(sep + 2) : '';
  let authorName = '';
  let committerName = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('author ')) authorName = line.slice(7).split(' <')[0];
    else if (line.startsWith('committer ')) committerName = line.slice(10).split(' <')[0];
  }
  return { message, authorName, committerName };
}
