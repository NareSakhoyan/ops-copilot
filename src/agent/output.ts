export const MAX_TOOL_BYTES = 8000;
const UNTRUSTED_PREFIX = 'UNTRUSTED_TOOL_DATA\n';

/** Shared byte-bounded JSON rendering used by every transport that surfaces tool output (model, MCP). */
function boundedJson(output: unknown, prefix: string): string {
  const marker = '\n[truncated; narrow the filters for more detail]';
  const text = JSON.stringify(output);
  if (Buffer.byteLength(prefix + text) <= MAX_TOOL_BYTES) return prefix + text;
  let preview = '';
  let bytes = Buffer.byteLength(prefix + marker);
  for (const point of text) {
    bytes += Buffer.byteLength(point);
    if (bytes > MAX_TOOL_BYTES) break;
    preview += point;
  }
  return prefix + preview + marker;
}

/** Bound the model-visible result without destroying the original structured result. */
export function toolModelOutput({ output }: { output: unknown }): { type: 'text'; value: string } {
  return { type: 'text', value: boundedJson(output, UNTRUSTED_PREFIX) };
}

/** Same byte cap and untrusted-data framing, in MCP's CallToolResult shape. */
export function toMcpToolResult(output: unknown, isError: boolean): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: boundedJson(output, UNTRUSTED_PREFIX) }], isError };
}
