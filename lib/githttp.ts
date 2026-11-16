// githttp.ts — git smart HTTP: info/refs advertisements (v0/v2), upload-pack
// (v0/v2 fetch, ls-refs) and receive-pack (push with report-status).
// Wire formats follow the conformance client's parser exactly.

import type { Forge, Repo } from './store.ts';
import {
  ZERO_OID, GIT_AGENT, encodePktLine, encodePktLines, FLUSH_PKT, DELIM_PKT,
  decodePktLines, writePack, readPack, computeFetch, parseCommit, parseTag,
  muxSidebandBand1, type GitObject, parseTree,
} from './git.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = `symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack multi_ack shallow agent=${GIT_AGENT}`;
const RECEIVE_CAPS_V0 = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${GIT_AGENT}`;

function textResult(status: number, contentType: string, body: Buffer): GitHttpResult {
  return { status, contentType, body };
}

function refLines(repo: Repo, caps: string): Buffer {
  const refs = repo.refs;
  const lines: Buffer[] = [];
  const mainTip = refs.get('refs/heads/main');
  if (mainTip) {
    lines.push(encodePktLine(`${mainTip} HEAD\0${caps}\n`));
  } else {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  const sorted = [...refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of sorted) {
    lines.push(encodePktLine(`${oid} ${name}\n`));
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        lines.push(encodePktLine(`${target} ${name}^{}\n`));
      }
    }
  }
  lines.push(FLUSH_PKT);
  return Buffer.concat(lines);
}

/** GET info/refs?service=<service> */
export function handleInfoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string | null): GitHttpResult {
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const caps = [
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
      `agent=${GIT_AGENT}\n`,
    ];
    const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), FLUSH_PKT];
    for (const c of caps) parts.push(encodePktLine(c));
    parts.push(FLUSH_PKT);
    return textResult(200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const body = Buffer.concat([
    encodePktLine(`# service=${service}\n`),
    FLUSH_PKT,
    refLines(repo, caps),
  ]);
  return textResult(200, `application/x-${service}-advertisement`, body);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface UploadArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  filter?: string;
  thinPack: boolean;
}

function parseV2Args(packets: Array<{ kind: string; data: Buffer }>): { command: string; args: UploadArgs } | null {
  let command = '';
  const args: UploadArgs = {
    peel: false, symrefs: false, unborn: false, prefixes: [],
    wants: [], haves: [], shallow: [], deepenNot: [], thinPack: false,
  };
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    else if (line === 'thin-pack') args.thinPack = true;
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) args.deepenSince = parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7);
  }
  if (!command) return null;
  return { command, args };
}

function lsRefsLines(repo: Repo, args: UploadArgs): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const mainTip = repo.refs.get('refs/heads/main');
  const hasRefs = repo.refs.size > 0;
  if (!hasRefs) {
    if (args.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  } else {
    if (mainTip && keep('HEAD')) {
      lines.push(`${mainTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [name, oid] of sorted) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      if (name.startsWith('refs/tags/') && args.peel) {
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tag') {
          const target = parseTag(obj.data).object;
          line += ` peeled:${target}`;
        }
      }
      lines.push(`${line}\n`);
    }
  }
  return encodePktLines(lines.map((l) => Buffer.from(l, 'utf8')));
}

function packCacheKey(repo: Repo, args: UploadArgs): string {
  return `${repo.owner}/${repo.name}|g${repo.generation}|w=${args.wants.join(',')}|h=${args.haves.join(',')}|s=${args.shallow.join(',')}|d=${args.depth ?? ''}`;
}

function fetchResponse(forge: Forge, repo: Repo, args: UploadArgs, version: 2 | 0): GitHttpResult {
  const key = packCacheKey(repo, args);
  let pack = forge.packCache.get(key);
  let computed: { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } | undefined;
  if (!pack) {
    computed = computeFetch(repo, {
      wants: args.wants,
      haves: args.haves,
      shallow: args.shallow,
      depth: args.depth,
    });
    if (computed.objects.size > 0) {
      pack = writePack(computed.objects);
      if (forge.packCache.size > 500) forge.packCache.clear();
      forge.packCache.set(key, pack);
    }
  }
  // If the pack came from cache, the shallow/unshallow lists are recomputed
  // cheaply (they are small) so the response stays correct.
  if (!computed) {
    computed = computeFetch(repo, {
      wants: args.wants,
      haves: args.haves,
      shallow: args.shallow,
      depth: args.depth,
    });
  }
  const { shallow, unshallow } = computed;

  if (version === 2) {
    const parts: Buffer[] = [];
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(FLUSH_PKT);
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
      parts.push(FLUSH_PKT);
    }
    if (pack) {
      parts.push(encodePktLine('packfile\n'));
      parts.push(muxSidebandBand1(pack));
    }
    return textResult(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  // v0: NAK + shallow/unshallow lines, then the sideband pack, then flush.
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
  if (pack) parts.push(muxSidebandBand1(pack));
  parts.push(FLUSH_PKT);
  return textResult(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST git-upload-pack */
export function handleUploadPack(forge: Forge, repo: Repo, body: Buffer, gitProtocol: string | null): GitHttpResult {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return textResult(400, 'application/json', Buffer.from(JSON.stringify({ message: 'malformed pkt-line' }), 'utf8'));
  }
  const firstData = packets.find((p) => p.kind === 'data');
  const firstLine = firstData ? firstData.data.toString('utf8') : '';
  if (firstLine.startsWith('command=')) {
    const parsed = parseV2Args(packets);
    if (!parsed) return textResult(400, 'application/json', Buffer.from(JSON.stringify({ message: 'bad v2 request' }), 'utf8'));
    if (parsed.command === 'ls-refs') {
      return textResult(200, 'application/x-git-upload-pack-result', lsRefsLines(repo, parsed.args));
    }
    if (parsed.command === 'fetch') {
      return fetchResponse(forge, repo, parsed.args, 2);
    }
    return textResult(400, 'application/json', Buffer.from(JSON.stringify({ message: `unknown command ${parsed.command}` }), 'utf8'));
  }
  // v0 fetch: want lines (first may carry capabilities), shallow/deepen,
  // flush, have lines, done, flush.
  const args: UploadArgs = {
    peel: false, symrefs: false, unborn: false, prefixes: [],
    wants: [], haves: [], shallow: [], deepenNot: [], thinPack: false,
  };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      args.wants.push(rest.split(' ')[0]);
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      args.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      args.depth = parseInt(line.slice(7), 10);
    } else if (line.startsWith('deepen-since ')) {
      args.deepenSince = parseInt(line.slice(13), 10);
    } else if (line.startsWith('deepen-not ')) {
      args.deepenNot.push(line.slice(11).trim());
    }
  }
  void gitProtocol;
  return fetchResponse(forge, repo, args, 0);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack */
export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): GitHttpResult {
  // Split the pkt-line command section from the pack bytes that follow it.
  let commands: PushCommand[] = [];
  let packStart = body.length;
  let sideband = false;
  try {
    let i = 0;
    let first = true;
    while (i < body.length) {
      if (i + 4 > body.length) throw new Error('truncated pkt-line');
      const head = body.subarray(i, i + 4).toString('ascii');
      if (head === '0000') { i += 4; packStart = i; break; }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || i + len > body.length) throw new Error('malformed pkt-line');
      const line = body.subarray(i + 4, i + len).toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const main = nul >= 0 ? line.slice(0, nul) : line;
      const caps = nul >= 0 ? line.slice(nul + 1) : '';
      if (first && caps.includes('side-band-64k')) sideband = true;
      first = false;
      const parts = main.split(' ');
      if (parts.length < 3) throw new Error('bad push command');
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      i += len;
    }
    if (packStart === body.length && commands.length === 0) {
      // No flush found: the whole body is the command section (or garbage).
      throw new Error('no flush after push commands');
    }
  } catch {
    return textResult(400, 'application/json', Buffer.from(JSON.stringify({ message: 'malformed pkt-line' }), 'utf8'));
  }

  const report = (lines: string[]): GitHttpResult => {
    const stream = encodePktLines(lines.map((l) => Buffer.from(l, 'utf8')));
    const bodyOut = sideband ? muxSidebandBand1(stream) : stream;
    return textResult(200, 'application/x-git-receive-pack-result', bodyOut);
  };

  // Unpack the pack (if any): resolve deltas against the pack and the store.
  const packBytes = body.subarray(packStart);
  let newObjects = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      newObjects = read.objects;
    } catch {
      return report(['unpack error\n']);
    }
  }
  // Every new tip's closure must be resolvable from the pack + the store.
  const lookup = (oid: string): GitObject | undefined => newObjects.get(oid) ?? repo.objects.get(oid);
  for (const cmd of commands) {
    if (cmd.newOid === ZERO_OID) continue;
    try {
      // Walk the new tip's commit closure; a missing object fails the unpack.
      const stack = [cmd.newOid];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid) || oid === ZERO_OID) continue;
        seen.add(oid);
        const obj = lookup(oid);
        if (!obj) throw new Error(`missing object ${oid}`);
        if (obj.type === 'commit') {
          const c = parseCommit(obj.data);
          stack.push(c.tree);
          for (const p of c.parents) stack.push(p);
        } else if (obj.type === 'tree') {
          for (const e of parseTree(obj.data)) stack.push(e.oid);
        } else if (obj.type === 'tag') {
          stack.push(parseTag(obj.data).object);
        }
      }
    } catch {
      return report(['unpack error\n']);
    }
  }
  // Store the unpacked objects, then evaluate each ref update.
  for (const [oid, obj] of newObjects) repo.objects.set(oid, obj);
  if (newObjects.size > 0) repo.generation++;

  const lines: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else if (current !== cmd.oldOid) {
        lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(cmd.ref);
        repo.generation++;
        lines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        repo.generation++;
        lines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    // Update: old must match, new must descend from current.
    if (current === undefined || current !== cmd.oldOid) {
      lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (!isAncestorCombined(lookup, current, cmd.newOid)) {
      lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    repo.generation++;
    lines.push(`ok ${cmd.ref}\n`);
  }
  return report(lines);
}

function isAncestorCombined(lookup: (oid: string) => GitObject | undefined, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const queue = [descendant];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}
