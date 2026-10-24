export const REDACTED = '[redacted]';

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/gu;
// JWT-shaped (header.payload.signature) and long opaque base64url/hex tokens.
const TOKEN_LIKE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_-]{32,}\b/gu;
// "token" already covers e.g. REFRESH_TOKEN_PEPPER by substring; pepper/database_url/
// connection_string/dsn are listed explicitly for clarity and in case a field is ever named
// without "token"/"password" in it (e.g. a bare DATABASE_URL object key).
const SENSITIVE_KEY = /password|secret|token|pepper|authorization|api[-_]?key|cookie|database_url|connection_string|dsn/iu;

function redactString(value: string): string {
  return value.replace(EMAIL, REDACTED).replace(TOKEN_LIKE, REDACTED).replace(PHONE, REDACTED);
}

/** Deep-redacts emails, phone numbers, token-shaped strings, and known-sensitive key names. Bounded depth/size to stay cheap on span attributes and log payloads. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) =>
      [key, SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1)]));
  }
  return value;
}
