/**
 * Guard for caller-supplied values that end up in a URL path segment.
 * Rejects empty/dot segments and anything that could change the path
 * structure (separators, query/fragment markers, encoded dots/slashes),
 * then percent-encodes the value.
 */
export function pathSegment(value: string | number): string {
  const raw = String(value);
  if (raw === '' || raw === '.' || raw === '..') {
    throw new Error(`Invalid path parameter: ${JSON.stringify(raw)}`);
  }
  if (/[/\\?#]/.test(raw) || /%(2e|2f|5c)/i.test(raw)) {
    throw new Error(`Invalid path parameter: ${JSON.stringify(raw)}`);
  }
  return encodeURIComponent(raw);
}
