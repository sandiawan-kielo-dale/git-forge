// store.ts — in-memory data model and all forge operations: repos, git refs and
// objects, contents commits, labels, issues, comments, pull requests and merges.
// Deterministic: fixed timestamps and the scenario viewer identity everywhere.

import { scenarioIdentity, SCENARIO_EPOCH_SEC, FIXED_ISO, type ScenarioUser } from './scenario.ts';
import {
  ZERO_OID, hashObject, parseCommit, buildCommit, parseTree, buildTree,
  flattenTreeEntries, collectReachable, isAncestor as gitIsAncestor,
  type GitObject, type ObjType, type RepoStore,
} from './git.ts';

export interface Label { name: string; color: string; description: string }
export interface IssueComment { id: number; body: string; user: string; createdAt: string }
export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; createdAt: string; updatedAt: string;
  comments: IssueComment[];
}
export interface PullRequest {
  number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; head: string; base: string; headSha: string; baseSha: string;
  mergeCommitSha: string | null; mergedAt: string | null; createdAt: string; updatedAt: string;
}

export interface Repo extends RepoStore {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  databaseId: number;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  nextCommentId: number;
  generation: number;
}

// Labels start empty: the suite creates the labels it needs through
// POST /labels and expects a 201 for them (a pre-seeded 'bug' would 422).
const DEFAULT_LABELS: Array<[string, string]> = [];

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx < 0) return null;
    return { kind: raw.slice(0, idx), key: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

export class Forge {
  readonly viewer: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly org: string;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 10000;
  private nextIssueId = 100000;
  reqSeq = 0;
  /** Pack cache keyed by repo + generation + fetch params (clone workload). */
  readonly packCache = new Map<string, Buffer>();

  constructor() {
    const id = scenarioIdentity();
    this.viewer = id.viewer;
    this.stranger = id.stranger;
    this.org = id.org;
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq.toString(16).padStart(8, '0')}`;
  }

  // -- repos ---------------------------------------------------------------

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  createRepo(name: string, opts?: { description?: string; private?: boolean }): { repo: Repo } | { error: string; status: number } {
    if (typeof name !== 'string' || name.length === 0) return { error: 'Repository name is required', status: 422 };
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return { error: 'Repository name is invalid', status: 422 };
    const key = repoKey(this.viewer.login, name);
    if (this.repos.has(key)) return { error: 'Repository already exists', status: 422 };
    const repo: Repo = {
      owner: this.viewer.login,
      name,
      description: opts?.description ?? '',
      isPrivate: opts?.private ?? false,
      databaseId: this.nextRepoId++,
      createdAt: FIXED_ISO,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(DEFAULT_LABELS.map(([n, c]) => [n, { name: n, color: c, description: '' }])),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      generation: 0,
      getObject: (oid: string) => repo.objects.get(oid),
    };
    this.repos.set(key, repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.databaseId - b.databaseId);
  }

  /** The repo for a REST/GraphQL owner path: only the viewer's own repos exist. */
  resolveOwnerRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.getRepo(owner, name);
  }

  // -- git refs & objects ---------------------------------------------------

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.generation++;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const ok = repo.refs.delete(ref);
    if (ok) repo.generation++;
    return ok;
  }

  storeObjects(repo: Repo, objects: Map<string, GitObject>): void {
    for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    repo.generation++;
  }

  defaultBranch(repo: Repo): string {
    return 'main';
  }

  headRef(repo: Repo): string {
    return `refs/heads/${this.defaultBranch(repo)}`;
  }

  headOid(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  /** All refs, sorted: HEAD target first is handled by callers. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const ident = `${this.viewer.name} <${this.viewer.email}> ${SCENARIO_EPOCH_SEC} +0000`;
    const data = buildCommit({ tree, parents, author: ident, committer: ident, message });
    const { oid, object } = hashObject('commit', data);
    repo.objects.set(oid, object);
    return oid;
  }

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    for (const e of flattenTreeEntries(repo, treeOid)) out.set(e.path, { oid: e.oid, mode: e.mode });
    return out;
  }

  /** Build (and store) a tree object from a flat path map. */
  buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, v] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: v.mode, name: rest, oid: v.oid });
        } else {
          const dir = rest.slice(0, slash);
          if (!dirs.has(dir)) dirs.set(dir, new Map());
          dirs.get(dir)!.set(path, v);
        }
      }
      for (const [dir, sub] of dirs) {
        const subTree = build(prefix + dir + '/');
        entries.push({ mode: '40000', name: dir, oid: subTree });
      }
      const { oid, object } = hashObject('tree', buildTree(entries));
      repo.objects.set(oid, object);
      return oid;
    };
    return build('');
  }

  /** Commits reachable from a tip, newest-first (DFS pre-order). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const c = parseCommit(obj.data);
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    return gitIsAncestor(repo, ancestor, descendant);
  }

  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const base = baseTree ? this.flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
    const head = headTree ? this.flattenTree(repo, headTree) : new Map<string, { oid: string; mode: string }>();
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  // -- contents --------------------------------------------------------------

  /**
   * Create or update a file on a branch. Returns the new commit oid and the
   * blob oid, or an error string with a status.
   */
  putContent(repo: Repo, path: string, opts: {
    message: string; content: Buffer; branch?: string; sha?: string;
  }): { commitSha: string; blobSha: string; created: boolean } | { error: string; status: number } {
    const branch = opts.branch ?? this.defaultBranch(repo);
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined && branch !== this.defaultBranch(repo)) {
      // Branch does not exist: start it from the default tip (or empty).
      tip = this.headOid(repo);
    }
    const baseFiles = tip ? this.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
    const existing = baseFiles.get(path);
    if (opts.sha !== undefined) {
      if (!existing) return { error: 'File does not exist', status: 409 };
      if (existing.oid !== opts.sha) return { error: 'sha does not match', status: 409 };
    }
    const created = !existing;
    const { oid: blobSha, object } = hashObject('blob', opts.content);
    repo.objects.set(blobSha, object);
    const files = new Map(baseFiles);
    files.set(path, { oid: blobSha, mode: '100644' });
    const tree = this.buildTreeFromMap(repo, files);
    const parents = tip ? [tip] : [];
    const commitSha = this.createCommit(repo, tree, parents, opts.message);
    repo.refs.set(ref, commitSha);
    repo.generation++;
    return { commitSha, blobSha, created };
  }

  getContent(repo: Repo, path: string, ref?: string): { kind: 'file'; blobOid: string; content: Buffer; size: number } | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> } | { error: string; status: number } {
    let tip: string | undefined;
    if (ref) {
      tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? (repo.objects.get(ref)?.type === 'commit' ? ref : undefined);
    } else {
      tip = this.headOid(repo);
    }
    if (!tip) return { error: 'Not Found', status: 404 };
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return { error: 'Not Found', status: 404 };
    const tree = parseCommit(commit.data).tree;
    const files = this.flattenTree(repo, tree);
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') {
      // Root directory listing.
      const entries = this.dirEntries(repo, tree, '');
      return { kind: 'dir', entries };
    }
    const file = files.get(clean);
    if (file) {
      const blob = repo.objects.get(file.oid);
      if (!blob) return { error: 'Not Found', status: 404 };
      return { kind: 'file', blobOid: file.oid, content: blob.data, size: blob.data.length };
    }
    // Directory?
    const prefix = clean + '/';
    const entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> = [];
    const seenDirs = new Set<string>();
    for (const [p, v] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ type: 'file', name: rest, path: p, sha: v.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          entries.push({ type: 'dir', name: dir, path: `${clean}/${dir}`, sha: v.oid });
        }
      }
    }
    if (entries.length === 0) return { error: 'Not Found', status: 404 };
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { kind: 'dir', entries };
  }

  private dirEntries(repo: Repo, treeOid: string, prefix: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return [];
    return parseTree(obj.data).map((e) => ({
      type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: e.name,
      path: prefix ? `${prefix}/${e.name}` : e.name,
      sha: e.oid,
    }));
  }

  deleteContent(repo: Repo, path: string, opts: { message: string; sha: string; branch?: string }): { commitSha: string } | { error: string; status: number } {
    const branch = opts.branch ?? this.defaultBranch(repo);
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return { error: 'Not Found', status: 404 };
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return { error: 'Not Found', status: 404 };
    const files = this.flattenTree(repo, parseCommit(commit.data).tree);
    const existing = files.get(path);
    if (!existing) return { error: 'Not Found', status: 404 };
    if (existing.oid !== opts.sha) return { error: 'sha does not match', status: 409 };
    files.delete(path);
    const tree = this.buildTreeFromMap(repo, files);
    const commitSha = this.createCommit(repo, tree, [tip], opts.message);
    repo.refs.set(ref, commitSha);
    repo.generation++;
    return { commitSha };
  }

  // -- labels / issues / comments --------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description?: string): { label: Label } | { error: string; status: number } {
    if (repo.labels.has(name)) return { error: 'Label already exists', status: 422 };
    const label: Label = { name, color: color ?? 'ededed', description: description ?? '' };
    repo.labels.set(name, label);
    return { label };
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): { issue: Issue } | { error: string; status: number } {
    for (const l of labelNames) {
      if (!repo.labels.has(l)) return { error: `Label does not exist: ${l}`, status: 422 };
    }
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labelNames],
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      comments: [],
    };
    repo.issues.set(number, issue);
    return { issue };
  }

  addComment(repo: Repo, issueNumber: number, body: string): { comment: IssueComment } | { error: string; status: number } {
    const issue = repo.issues.get(issueNumber);
    if (!issue) return { error: 'Not Found', status: 404 };
    const comment: IssueComment = { id: repo.nextCommentId++, body, user: this.viewer.login, createdAt: FIXED_ISO };
    issue.comments.push(comment);
    return { comment };
  }

  // -- pull requests ----------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): { pull: PullRequest } | { error: string; status: number } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip) return { error: `Head branch does not exist: ${head}`, status: 422 };
    if (!baseTip) return { error: `Base branch does not exist: ${base}`, status: 422 };
    const number = repo.nextNumber++;
    const pull: PullRequest = {
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      head,
      base,
      headSha: headTip,
      baseSha: baseTip,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    repo.pulls.set(number, pull);
    return { pull };
  }

  /** Files changed by a PR (base merge-base -> head), with line counts. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const baseTip = pull.baseSha;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    const baseTree = baseTip ? parseCommit(repo.objects.get(baseTip)!.data).tree : null;
    const headTree = headTip ? parseCommit(repo.objects.get(headTip)!.data).tree : null;
    const diffs = this.diffTrees(repo, baseTree, headTree);
    return diffs.map((d) => {
      let additions = 0;
      let deletions = 0;
      if (d.status !== 'removed') {
        const blob = repo.objects.get(d.newOid!);
        additions = blob ? blob.data.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
        if (d.status === 'added') additions = Math.max(additions, 1);
      }
      if (d.status !== 'added') {
        const blob = repo.objects.get(d.oldOid!);
        deletions = blob ? blob.data.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
      }
      if (d.status === 'modified' && additions === 0 && deletions === 0) additions = 1;
      return { filename: d.path, status: d.status, additions, deletions, changes: additions + deletions };
    });
  }

  /** Conflict rule: a file the PR changes was also changed on the base tip since the PR's base sha. */
  pullConflict(repo: Repo, pull: PullRequest): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    if (!baseTip || !headTip) return false;
    const baseAtCreation = pull.baseSha;
    const baseTreeAtCreation = parseCommit(repo.objects.get(baseAtCreation)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const atCreation = this.flattenTree(repo, baseTreeAtCreation);
    const atTip = this.flattenTree(repo, baseTipTree);
    const headFiles = this.flattenTree(repo, headTree);
    const changed = this.diffTrees(repo, baseTreeAtCreation, headTree);
    for (const d of changed) {
      const was = atCreation.get(d.path);
      const now = atTip.get(d.path);
      const baseChanged = (was?.oid ?? null) !== (now?.oid ?? null);
      const headOid = headFiles.get(d.path)?.oid ?? null;
      if (baseChanged && headOid !== (now?.oid ?? null)) return true;
    }
    return false;
  }

  mergePull(repo: Repo, pull: PullRequest, method: string): { sha: string; message: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
    if (this.pullConflict(repo, pull)) return { error: 'Merge conflict', status: 405 };
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    const baseFiles = this.flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const headFiles = this.flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
    const baseAtCreation = parseCommit(repo.objects.get(pull.baseSha)!.data).tree;
    const merged = new Map(baseFiles);
    for (const d of this.diffTrees(repo, baseAtCreation, parseCommit(repo.objects.get(headTip)!.data).tree)) {
      if (d.status === 'removed') merged.delete(d.path);
      else merged.set(d.path, { oid: d.newOid!, mode: '100644' });
    }
    void headFiles;
    const tree = this.buildTreeFromMap(repo, merged);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
    const sha = this.createCommit(repo, tree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    repo.generation++;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = FIXED_ISO;
    pull.updatedAt = FIXED_ISO;
    void method;
    return { sha, message };
  }

  // -- REST views ---------------------------------------------------------------

  repoView(repo: Repo): Record<string, unknown> {
    return {
      id: repo.databaseId,
      name: repo.name,
      full_name: repoKey(repo.owner, repo.name),
      owner: { login: repo.owner, id: this.viewer.id, type: 'User' },
      description: repo.description,
      private: repo.isPrivate,
      fork: false,
      default_branch: 'main',
      created_at: repo.createdAt,
      updated_at: repo.createdAt,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
      has_issues: true,
      open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    };
  }

  userView(user: ScenarioUser): Record<string, unknown> {
    return { login: user.login, id: user.id, name: user.name, email: user.email, type: 'User' };
  }

  issueView(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((n) => {
        const l = repo.labels.get(n);
        return { name: n, color: l?.color ?? 'ededed', description: l?.description ?? '' };
      }),
      user: { login: this.viewer.login, id: this.viewer.id },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      comments: issue.comments.length,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    return {
      id: pull.number,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.head, sha: headTip, repo: this.repoView(repo) },
      base: { ref: pull.base, sha: baseTip, repo: this.repoView(repo) },
      user: { login: this.viewer.login, id: this.viewer.id },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }

  commentView(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.user, id: this.viewer.id },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    };
  }
}
