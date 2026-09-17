function positiveInt(value: string | undefined, fallback: number, min: number): number {
  const n = Number(value?.trim());
  return value?.trim() && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export const OWNER_CONTEXT =
  process.env.OWNER_CONTEXT?.trim() ||
  `The owner keeps a lifelong commonplace book: everything they read, watch and think, kept for decades.
They are an MBA (HR) student and product builder in India with a long-term aim of becoming a founder.
The book exists to build understanding that compounds: ideas, the passages that sparked them, and the connections between them.`;

/** Starting topic vocabulary. Override with TOPICS="a, b, c". The model may only propose new ones. */
export const TOPICS: string[] = (
  process.env.TOPICS?.trim() ||
  'psychology, decision-making, leadership, people-and-work, economics, business-strategy, startups, technology, ai, india, society-and-politics, learning, habits-and-productivity, writing-and-communication, philosophy'
)
  .split(',')
  .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
  .filter(Boolean);

/** Characters of source text sent to the model. Blank, zero or invalid values fall back to 80,000. */
export const MAX_SOURCE_CHARS = positiveInt(process.env.MAX_SOURCE_CHARS, 80_000, 2_000);
export const MAX_HIGHLIGHTS = 7;
export const MAX_CANDIDATES = 3;
export const NOTE_WINDOW_MINUTES = 10;

export const vault = {
  root: (process.env.VAULT_ROOT ?? '').replace(/^\/+|\/+$/g, ''),
  inbox: process.env.VAULT_INBOX_DIR || '00 Inbox',
  ideas: process.env.VAULT_IDEAS_DIR || '01 Ideas',
  sources: process.env.VAULT_SOURCES_DIR || '03 Sources',
  topics: process.env.VAULT_TOPICS_DIR || '04 Topics',
  reviews: process.env.VAULT_REVIEWS_DIR || '05 Reviews',
  archive: process.env.VAULT_ARCHIVE_DIR || '90 Archive',
};

export function vaultPath(dir: string, file = ''): string {
  return [vault.root, dir, file].filter(Boolean).join('/');
}
