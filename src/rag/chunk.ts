import { z } from 'zod';

const targetBytes = 2000;
const overlapBytes = 200;

function suffix(text: string, bytes: number): string {
  let result = '';
  for (const point of [...text].reverse()) {
    if (Buffer.byteLength(point + result) > bytes) break;
    result = point + result;
  }
  return result;
}

/** Approximate 500 tokens by 2,000 UTF-8 bytes; headings start fresh sections. */
export function chunkDocument(input: string): string[] {
  const text = z.string().min(1).max(5_000_000).parse(input).replace(/\r\n?/g, '\n');
  const sections = text.split(/(?=^#{1,6} +)/m).filter((part) => part.trim());
  const chunks: string[] = [];
  for (const section of sections) {
    const [heading] = section.match(/^#{1,6} +[^\n]+/m) ?? [];
    const prefix = heading && Buffer.byteLength(heading) < 400 ? `${heading}\n` : '';
    const content = prefix && section.startsWith(heading ?? '') ? section.slice((heading?.length ?? 0)).trimStart() : section;
    let current = prefix;
    for (const token of content.match(/\S+\s*|\s+/gu) ?? []) {
      if (Buffer.byteLength(current + token) <= targetBytes) { current += token; continue; }
      if (current.trim() && current !== prefix) {
        chunks.push(current.trim());
        current = prefix + suffix(current.slice(prefix.length), overlapBytes);
      }
      // Split exceptionally long words at Unicode code points, never inside a UTF-8 sequence.
      for (const point of token) {
        if (Buffer.byteLength(current + point) > targetBytes) {
          chunks.push(current.trim());
          current = prefix + suffix(current.slice(prefix.length), overlapBytes);
        }
        current += point;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks;
}
