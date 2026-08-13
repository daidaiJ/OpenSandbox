export interface TruncationResult {
  content: string;
  truncated: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * Byte-accurate truncation of tool payloads to keep agent context bounded.
 *
 * Uses global TextEncoder/TextDecoder (Node >= 20, no imports) so the bundled
 * output has zero external imports. A multi-byte character split by the byte
 * cut decodes as U+FFFD, which is acceptable for a truncated preview; the
 * omission marker tells the agent the payload is incomplete.
 */
export function truncateText(text: string, maxBytes: number): TruncationResult {
  if (maxBytes <= 0) {
    return { content: "", truncated: text.length > 0 };
  }
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return { content: text, truncated: false };
  }
  const cut = decoder.decode(bytes.subarray(0, maxBytes));
  return {
    content: `${cut}\n… [output truncated: ${bytes.length - maxBytes} bytes omitted]`,
    truncated: true,
  };
}
