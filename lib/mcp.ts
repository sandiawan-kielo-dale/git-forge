// mcp.ts — Model Context Protocol endpoint (streamable HTTP, 2026-07-28 era
// with a legacy initialize fallback). Tools: create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request.

import type { Forge, Repo } from './store.ts';

export const MCP_SERVER_NAME = 'git-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function serverInfo(): { name: string; version: string } {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function capabilities(): { tools: Record<string, unknown> } {
  return { tools: {} };
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], structuredContent: { error: message }, isError: true };
}

function missingArgs(tool: McpTool, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw { code: -32602, message: `unknown tool: ${name}` };
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return errorResult(`Missing required argument(s): ${missing.join(', ')}`);

  const owner = String(args.owner ?? forge.viewer.login);
  const repoName = String(args.repo ?? args.name ?? '');
  const repo = (name === 'create_repo')
    ? undefined
    : forge.resolveOwnerRepo(owner, repoName);
  if (name !== 'create_repo' && !repo) return errorResult(`repository not found: ${owner}/${repoName}`);

  switch (name) {
    case 'create_repo': {
      const result = forge.createRepo(String(args.name), {
        description: typeof args.description === 'string' ? args.description : undefined,
        private: args.private === true,
      });
      if ('error' in result) return errorResult(result.error);
      return okResult(forge.repoView(result.repo));
    }
    case 'get_repo': {
      return okResult(forge.repoView(repo as Repo));
    }
    case 'create_issue': {
      const result = forge.createIssue(repo as Repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in result) return errorResult(result.error);
      return okResult(forge.issueView(repo as Repo, result.issue));
    }
    case 'list_issues': {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...(repo as Repo).issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.number - a.number);
      const views = issues.map((i) => forge.issueView(repo as Repo, i));
      return okResult({ issues: views });
    }
    case 'create_pull_request': {
      const result = forge.createPull(
        repo as Repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if ('error' in result) return errorResult(result.error);
      return okResult(forge.pullView(repo as Repo, result.pull));
    }
    case 'merge_pull_request': {
      const pull = (repo as Repo).pulls.get(Number(args.pull_number));
      if (!pull) return errorResult(`pull request not found: ${args.pull_number}`);
      const result = forge.mergePull(repo as Repo, pull, 'squash');
      if ('error' in result) return errorResult(result.error);
      return okResult({ merged: true, sha: result.sha, message: result.message, pull_number: pull.number });
    }
    default:
      throw { code: -32602, message: `unknown tool: ${name}` };
  }
}

export interface McpHttpResult {
  status: number;
  body: unknown;
  /** True when the body must be sent as an empty response (notifications). */
  empty?: boolean;
}

/** Handle one POST /mcp request body (already read as text). */
export function handleMcp(forge: Forge, bodyText: string): McpHttpResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const req = body as Record<string, unknown>;
  const method = typeof req.method === 'string' ? req.method : '';
  const id = req.id === undefined ? null : req.id;

  // Notifications carry no id and expect an empty 202.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null, empty: true };
  }

  const result = (value: unknown): McpHttpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpHttpResult => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return result({
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: capabilities(),
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'initialize') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0];
    return result({ protocolVersion, capabilities: capabilities(), serverInfo: serverInfo() });
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const toolResult = callTool(forge, toolName, args);
      return result(toolResult);
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err) {
        const e = err as { code: number; message: string };
        return error(e.code, e.message);
      }
      return error(-32603, err instanceof Error ? err.message : String(err));
    }
  }
  return error(-32601, `method not found: ${method}`);
}
