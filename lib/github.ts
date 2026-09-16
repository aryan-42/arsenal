import { env } from './env';
import { sleep } from './util';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gh<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new GitHubError(res.status, `GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const repo = () => `/repos/${env.githubRepo}`;

export interface FileWrite {
  path: string;
  content: string;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

async function headCommit(): Promise<{ commitSha: string; treeSha: string }> {
  const ref = await gh<{ object: { sha: string } }>(`${repo()}/git/ref/heads/${env.githubBranch}`);
  const commit = await gh<{ tree: { sha: string } }>(`${repo()}/git/commits/${ref.object.sha}`);
  return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}

/**
 * Writes and deletes files in a single commit. Retries if the branch moved
 * (for example Obsidian Git pushed at the same moment).
 * Returns the blob sha of every written path.
 */
export async function commitChanges(
  message: string,
  writes: FileWrite[],
  deletes: string[] = [],
): Promise<Record<string, string>> {
  const blobShas: Record<string, string> = {};
  if (!writes.length && !deletes.length) return blobShas;

  for (const w of writes) {
    const blob = await gh<{ sha: string }>(`${repo()}/git/blobs`, {
      method: 'POST',
      body: { content: w.content, encoding: 'utf-8' },
    });
    blobShas[w.path] = blob.sha;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await headCommit();
    let existing = new Set<string>();
    if (deletes.length) {
      const tree = await gh<{ tree: TreeEntry[] }>(`${repo()}/git/trees/${head.treeSha}?recursive=1`);
      existing = new Set(tree.tree.filter((t) => t.type === 'blob').map((t) => t.path));
    }
    const entries = [
      ...writes.map((w) => ({ path: w.path, mode: '100644', type: 'blob', sha: blobShas[w.path] })),
      ...deletes
        .filter((d) => existing.has(d) && !(d in blobShas))
        .map((d) => ({ path: d, mode: '100644', type: 'blob', sha: null })),
    ];
    if (!entries.length) return blobShas;

    const tree = await gh<{ sha: string }>(`${repo()}/git/trees`, {
      method: 'POST',
      body: { base_tree: head.treeSha, tree: entries },
    });
    const commit = await gh<{ sha: string }>(`${repo()}/git/commits`, {
      method: 'POST',
      body: { message, tree: tree.sha, parents: [head.commitSha] },
    });
    try {
      await gh(`${repo()}/git/refs/heads/${env.githubBranch}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
      });
      return blobShas;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422 && attempt < 3) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error('GitHub commit failed after retries');
}

export async function getTree(): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const head = await headCommit();
  const tree = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    `${repo()}/git/trees/${head.treeSha}?recursive=1`,
  );
  return { entries: tree.tree, truncated: tree.truncated };
}

export async function getBlobText(sha: string): Promise<string> {
  const blob = await gh<{ content: string; encoding: string }>(`${repo()}/git/blobs/${sha}`);
  return Buffer.from(blob.content, (blob.encoding as BufferEncoding) || 'base64').toString('utf8');
}

export async function getFileText(path: string): Promise<string | null> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  try {
    const file = await gh<{ content: string; encoding: string }>(
      `${repo()}/contents/${encoded}?ref=${encodeURIComponent(env.githubBranch)}`,
    );
    return Buffer.from(file.content, 'base64').toString('utf8');
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}
