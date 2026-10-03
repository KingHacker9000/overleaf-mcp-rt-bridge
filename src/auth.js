import { timingSafeEqual } from 'node:crypto';

export function extractBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) {
    const padded = Buffer.alloc(a.length);
    b.copy(padded, 0, 0, Math.min(a.length, b.length));
    timingSafeEqual(a, padded);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearerAuthorized(header, expectedToken) {
  const supplied = extractBearerToken(header);
  return supplied !== null && constantTimeEqual(supplied, expectedToken);
}
