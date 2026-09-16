export const OWNER_CONTEXT =
  process.env.OWNER_CONTEXT?.trim() ||
  `The owner is an MBA (HR) student and product builder. They use this evidence bank to:
(1) win business case competitions judged at top-tier consulting standard,
(2) answer MBA HR exam questions with real examples,
(3) prepare for job interviews with stories and examples,
(4) create posts for an AI/career Instagram page,
(5) spot startup opportunities for a future founder path.`;

export const MAX_CARDS_PER_SOURCE = 6;
export const MAX_SOURCE_CHARS = 80_000;
export const NOTE_WINDOW_MINUTES = 10;

export const vault = {
  root: (process.env.VAULT_ROOT ?? '').replace(/^\/+|\/+$/g, ''),
  inbox: process.env.VAULT_INBOX_DIR || '00 Inbox',
  sources: process.env.VAULT_SOURCES_DIR || '03 Sources',
  evidence: process.env.VAULT_EVIDENCE_DIR || '04 Evidence',
};

export function vaultPath(dir: string, file = ''): string {
  return [vault.root, dir, file].filter(Boolean).join('/');
}
