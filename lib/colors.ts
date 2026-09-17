const TOPIC_PALETTE = ['#f2d492', '#7fd6e8', '#c3a6ff', '#9be3b8', '#f4a3c4', '#e8b77d', '#8fb8ff', '#d6e685', '#ffb59a', '#6fd1c2'];

/** Stable colour per topic, shared by the server page and the constellation. */
export function topicColor(topic: string | null, order: string[]): string {
  if (!topic) return '#a9b0d6';
  const i = order.indexOf(topic);
  const index = i >= 0 ? i : [...topic].reduce((a, c) => a + c.charCodeAt(0), 0);
  return TOPIC_PALETTE[index % TOPIC_PALETTE.length];
}
