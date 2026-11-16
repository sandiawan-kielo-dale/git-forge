// graphql.ts — a small, dependency-free GraphQL parser and executor covering the
// documents the conformance suite sends (gh-style queries and mutations,
// introspection, inline fragments, batched operations). Unknown fields produce
// a 200 response with an `errors` array, as GitHub does.

import type { Forge, Repo, Issue, PullRequest } from './store.ts';
import { globalId, parseGlobalId } from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  kind: 'field';
  name: string;
  alias?: string;
  args: Array<{ name: string; value: GqlValue }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }>;
  selection?: GqlSelection[];
}

export interface GqlFragmentSpread {
  kind: 'fragmentSpread';
  name: string;
  directives: Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }>;
}

export interface GqlInlineFragment {
  kind: 'inlineFragment';
  typeCondition?: string;
  directives: Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }>;
  selection: GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragmentSpread | GqlInlineFragment;

export interface GqlOperation {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: Array<{ name: string; defaultValue?: GqlValue }>;
  selection: GqlSelection[];
}

export interface GqlFragmentDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: GqlSelection[];
}

export type GqlDefinition = GqlOperation | GqlFragmentDef;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('unexpected end of GraphQL document');
    return t;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected "${v}" in GraphQL document, got ${t.kind} ${t.value}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${t.kind} ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected "${value}" in GraphQL document, got ${t.value}`);
    return t.value;
  }

  parseDocument(): GqlDefinition[] {
    const defs: GqlDefinition[] = [];
    while (this.pos < this.tokens.length) defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): GqlDefinition {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '{') return this.parseOperation('query', undefined);
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      this.next();
      const op = t.value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      const n = this.peek();
      if (n?.kind === 'name') name = this.next().value as string;
      return this.parseOperation(op, name);
    }
    if (t?.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.parseDirectives();
      const selection = this.parseSelectionSet();
      return { kind: 'fragment', name, typeCondition, selection };
    }
    throw new Error(`unexpected token ${t?.kind} ${t?.value} in GraphQL document`);
  }

  private parseOperation(operation: 'query' | 'mutation' | 'subscription', name: string | undefined): GqlOperation {
    const variableDefinitions: Array<{ name: string; defaultValue?: GqlValue }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: GqlValue | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    this.parseDirectives();
    const selection = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, selection };
  }

  private parseType(): void {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }> {
    const out: Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }> = [];
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      const name = this.expectName();
      const args = this.parseArguments();
      out.push({ name, args });
    }
    return out;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const t = this.peek();
    if (t?.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n?.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selection = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, directives, selection };
      }
      if (n?.kind === 'name') {
        const name = this.next().value as string;
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      const selection = this.parseSelectionSet();
      return { kind: 'inlineFragment', directives, selection };
    }
    const nameOrAlias = this.expectName();
    let name = nameOrAlias;
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = nameOrAlias;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selection: GqlSelection[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, directives, selection };
  }

  private parseArguments(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.kind} ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Schema (field sets, for validation and introspection)
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body'],
  AddCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER'];

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GqlError { message: string; path?: Array<string | number> }

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, GqlFragmentDef>;
  errors: GqlError[];
}

function unwrapValue(v: GqlValue, ctx: ExecContext): unknown {
  switch (v.kind) {
    case 'variable': {
      const val = ctx.variables[v.name];
      return val === undefined ? null : val;
    }
    case 'string': return v.value;
    case 'int': case 'float': return v.value;
    case 'boolean': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.values.map((x) => unwrapValue(x, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = unwrapValue(f.value, ctx);
      return out;
    }
  }
}

function argsOf(field: GqlField, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = unwrapValue(a.value, ctx);
  return out;
}

function directivesAllow(field: { directives: Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }> }, ctx: ExecContext): boolean {
  for (const d of field.directives) {
    const ifArg = d.args.find((a) => a.name === 'if');
    if (!ifArg) continue;
    const val = unwrapValue(ifArg.value, ctx);
    if (d.name === 'skip' && val === true) return false;
    if (d.name === 'include' && val !== true) return false;
  }
  return true;
}

type GqlObject = { __typename: string; [key: string]: unknown };

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(raw);
    if (m) return parseInt(m[1], 10);
  } catch {
    // fall through
  }
  return -1;
}

function paginate<T>(items: T[], first: unknown, after: unknown): { nodes: T[]; pageInfo: GqlObject } {
  const n = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : items.length;
  const start = decodeCursor(after) + 1;
  const slice = items.slice(start, start + n);
  const end = start + slice.length - 1;
  return {
    nodes: slice,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + n < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
      endCursor: slice.length > 0 ? encodeCursor(end) : null,
    },
  };
}

function issueObject(forge: Forge, repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    id: globalId('I', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullObject(forge: Forge, repo: Repo, pull: PullRequest): GqlObject {
  const state = pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
  const mergeable = forge.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __typename: 'PullRequest',
    id: globalId('P', `${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    state,
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable,
    __repo: repo,
    __pull: pull,
  };
}

function repoObject(forge: Forge, repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    id: globalId('R', `${repo.owner}/${repo.name}`),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: {
      __typename: 'User',
      login: repo.owner,
      id: forge.viewer.id,
      name: forge.viewer.name,
      email: forge.viewer.email,
    },
    defaultBranchRef: { __typename: 'Ref', name: 'main' },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __repo: repo,
  };
}

function resolveField(parentType: string, parent: GqlObject, field: GqlField, ctx: ExecContext): unknown {
  const { forge } = ctx;
  const args = argsOf(field, ctx);
  const repo = parent.__repo as Repo | undefined;

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      const v = forge.viewer;
      return { __typename: 'User', login: v.login, id: v.id, name: v.name, email: v.email };
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const r = forge.resolveOwnerRepo(owner, name);
      return r ? repoObject(forge, r) : null;
    }
    if (field.name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      const [owner, rest] = parsed.key.split('/', 2);
      if (parsed.kind === 'R') {
        const r = forge.getRepo(owner, rest);
        return r ? repoObject(forge, r) : null;
      }
      if (parsed.kind === 'I') {
        const [name, num] = rest.split(':');
        const r = forge.getRepo(owner, name);
        const issue = r?.issues.get(Number(num));
        return r && issue ? issueObject(forge, r, issue) : null;
      }
      if (parsed.kind === 'P') {
        const [name, num] = rest.split(':');
        const r = forge.getRepo(owner, name);
        const pull = r?.pulls.get(Number(num));
        return r && pull ? pullObject(forge, r, pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (name === 'Issue' || name === 'PullRequest' || name === 'Repository') {
        return {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          __fields: SCHEMA_FIELDS[name] ?? [],
          __enumValues: null,
        };
      }
      if (name === 'SearchType') {
        return {
          __typename: '__Type',
          name,
          kind: 'ENUM',
          __fields: null,
          __enumValues: SEARCH_TYPE_VALUES,
        };
      }
      return null;
    }
  }

  if (parentType === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'R') throw new Error('repositoryId does not identify a repository');
      const [owner, name] = parsed.key.split('/', 2);
      const r = forge.getRepo(owner, name);
      if (!r) throw new Error('repository not found');
      const result = forge.createIssue(r, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreateIssuePayload', issue: issueObject(forge, r, result.issue) };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (!parsed || parsed.kind !== 'I') throw new Error('issueId does not identify an issue');
      const [owner, rest] = parsed.key.split('/', 2);
      const [name, num] = rest.split(':');
      const r = forge.getRepo(owner, name);
      const issue = r?.issues.get(Number(num));
      if (!r || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObject(forge, r, issue) };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'R') throw new Error('repositoryId does not identify a repository');
      const [owner, name] = parsed.key.split('/', 2);
      const r = forge.getRepo(owner, name);
      if (!r) throw new Error('repository not found');
      const result = forge.createPull(r, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(forge, r, result.pull) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.kind !== 'P') throw new Error('pullRequestId does not identify a pull request');
      const [owner, rest] = parsed.key.split('/', 2);
      const [name, num] = rest.split(':');
      const r = forge.getRepo(owner, name);
      const pull = r?.pulls.get(Number(num));
      if (!r || !pull) throw new Error('pull request not found');
      const result = forge.mergePull(r, pull, String(input.mergeMethod ?? 'SQUASH'));
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(forge, r, pull) };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed || parsed.kind !== 'I') throw new Error('subjectId does not identify an issue');
      const [owner, rest] = parsed.key.split('/', 2);
      const [name, num] = rest.split(':');
      const r = forge.getRepo(owner, name);
      if (!r) throw new Error('issue not found');
      const result = forge.addComment(r, Number(num), String(input.body ?? ''));
      if ('error' in result) throw new Error(result.error);
      const comment = result.comment;
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueEdge',
          node: {
            __typename: 'IssueComment',
            id: globalId('C', `${owner}/${name}:${num}:${comment.id}`),
            body: comment.body,
          },
          cursor: encodeCursor(comment.id),
        },
      };
    }
  }

  if (parentType === 'Repository' && repo) {
    if (field.name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObject(forge, repo, issue) : null;
    }
    if (field.name === 'issues') {
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC');
      const dir = direction === 'ASC' ? 1 : -1;
      issues.sort((a, b) => (a.number - b.number) * dir);
      const { nodes, pageInfo } = paginate(issues, args.first, args.after);
      return {
        __typename: 'IssueConnection',
        nodes: nodes.map((i) => issueObject(forge, repo, i)),
        pageInfo,
      };
    }
    if (field.name === 'pullRequests') {
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const { nodes, pageInfo } = paginate(pulls, args.first, args.after);
      return {
        __typename: 'PullRequestConnection',
        nodes: nodes.map((p) => pullObject(forge, repo, p)),
        pageInfo,
      };
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObject(forge, repo, pull) : null;
    }
  }

  if (parentType === 'PullRequest') {
    if (field.name === 'files') {
      const pull = parent.__pull as PullRequest;
      const files = repo ? forge.pullFiles(repo, pull) : [];
      const { nodes } = paginate(files, args.first, args.after);
      return {
        __typename: 'PullRequestConnection',
        nodes: nodes.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
  }

  if (parentType === '__Type') {
    if (field.name === 'fields') {
      const names = (parent.__fields as string[] | null) ?? [];
      return names.map((n) => ({ __typename: '__Field', name: n }));
    }
    if (field.name === 'enumValues') {
      const values = (parent.__enumValues as string[] | null) ?? [];
      return values.map((n) => ({ __typename: '__EnumValue', name: n }));
    }
  }

  // Scalar / plain object fields: read them straight off the parent.
  return parent[field.name] ?? null;
}

function executeSelection(
  selections: GqlSelection[],
  parentType: string,
  parent: GqlObject,
  ctx: ExecContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      if (!directivesAllow(sel, ctx)) continue;
      const def = ctx.fragments.get(sel.name);
      if (!def) continue;
      Object.assign(out, executeSelection(def.selection, parentType, parent, ctx, path));
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (!directivesAllow(sel, ctx)) continue;
      if (sel.typeCondition && sel.typeCondition !== parentType) continue;
      Object.assign(out, executeSelection(sel.selection, parentType, parent, ctx, path));
      continue;
    }
    if (!directivesAllow(sel, ctx)) continue;
    const field = sel;
    const responseKey = field.alias ?? field.name;
    const fieldPath = [...path, responseKey];
    if (field.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const known = SCHEMA_FIELDS[parentType] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(parentType, parent, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    if (field.selection && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item, idx) => {
          if (item !== null && typeof item === 'object' && '__typename' in item) {
            return executeSelection(field.selection!, (item as GqlObject).__typename as string, item as GqlObject, ctx, [...fieldPath, idx]);
          }
          return item;
        });
      } else if (typeof value === 'object' && '__typename' in (value as GqlObject)) {
        const obj = value as GqlObject;
        out[responseKey] = executeSelection(field.selection, obj.__typename as string, obj, ctx, fieldPath);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value ?? null;
    }
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: GqlError[];
}

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>): GraphQLResult {
  let definitions: GqlDefinition[];
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = new Map<string, GqlFragmentDef>();
  let operation: GqlOperation | undefined;
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else if (!operation) operation = def;
  }
  if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: ExecContext = { forge, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelection(operation.selection, rootType, root, ctx, []);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one GraphQL HTTP body (single operation or a batch array). */
export function handleGraphQL(forge: Forge, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      const e = entry as Record<string, unknown>;
      return executeGraphQL(forge, String(e.query ?? ''), (e.variables ?? {}) as Record<string, unknown>);
    });
  }
  const e = body as Record<string, unknown>;
  return executeGraphQL(forge, String(e.query ?? ''), (e.variables ?? {}) as Record<string, unknown>);
}
