import type { Format } from '../types';

export interface Fetched {
  format: Format;
  title?: string | null;
  author?: string | null;
  text?: string | null;
  /** Why text is missing, shown to the user. */
  reason?: string;
}
