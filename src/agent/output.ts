export const MAX_TOOL_BYTES = 8000;

/** Bound the model-visible result without destroying the original structured result. */
export function toolModelOutput({ output }: { output: unknown }): { type: 'text'; value: string } {
  const prefix = 'UNTRUSTED_TOOL_DATA\n';
  const marker = '\n[truncated; narrow the filters for more detail]';
  const text = JSON.stringify(output);
  if (Buffer.byteLength(prefix + text) <= MAX_TOOL_BYTES) return { type: 'text', value: prefix + text };
  let preview = '';
  let bytes = Buffer.byteLength(prefix + marker);
  for (const point of text) {
    bytes += Buffer.byteLength(point);
    if (bytes > MAX_TOOL_BYTES) break;
    preview += point;
  }
  return { type: 'text', value: prefix + preview + marker };
}
