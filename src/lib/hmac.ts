// HMAC helpers using WebCrypto. Used for verifying NowPayments / CryptoCloud webhooks.

const enc = new TextEncoder();

async function importKey(secret: string, alg: 'SHA-256' | 'SHA-512'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: alg },
    false,
    ['sign'],
  );
}

function bufferToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  // btoa available in Workers runtime
  return btoa(bin);
}

// Constant-time string comparison.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * NowPayments IPN signature verification.
 * Per docs: HMAC-SHA512 over JSON payload with keys sorted alphabetically (recursive),
 * separators ":",", with no extra spaces. Compare hex digest.
 * https://documenter.getpostman.com/view/7907941/S1a32n38
 */
export async function verifyNowPaymentsSig(
  secret: string,
  rawBody: string,
  signatureHex: string,
): Promise<boolean> {
  if (!signatureHex) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const sortedJson = stableStringify(payload);
  const key = await importKey(secret, 'SHA-512');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(sortedJson));
  return timingSafeEqual(bufferToHex(sig).toLowerCase(), signatureHex.toLowerCase());
}

/**
 * CryptoCloud postback signature verification.
 * Per docs: HMAC-SHA256 over raw body string, base64-encoded. Header name varies by integration:
 * `Sign` or `x-signature`. Caller passes the value as-is.
 */
export async function verifyCryptoCloudSig(
  secret: string,
  rawBody: string,
  signatureBase64: string,
): Promise<boolean> {
  if (!signatureBase64) return false;
  const key = await importKey(secret, 'SHA-256');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return timingSafeEqual(bufferToBase64(sig), signatureBase64);
}

/**
 * Stable JSON stringify with sorted object keys (recursive). Arrays preserve order.
 * Used for canonicalizing webhook payloads before HMAC.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
