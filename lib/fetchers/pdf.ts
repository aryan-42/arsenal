import { extractText, getDocumentProxy } from 'unpdf';
import { cleanText } from '../util';

export async function pdfToText(buffer: ArrayBuffer): Promise<{ text: string | null; title: string | null; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  let title: string | null = null;
  try {
    const meta = await pdf.getMetadata();
    const t = (meta.info as { Title?: string } | undefined)?.Title;
    title = t && t.trim() ? t.trim() : null;
  } catch {
    // metadata is optional
  }
  const cleaned = cleanText(Array.isArray(text) ? text.join('\n') : text);
  return { text: cleaned.length > 200 ? cleaned : null, title, pages: totalPages };
}
