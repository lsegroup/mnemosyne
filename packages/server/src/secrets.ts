import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Minimum length of MNEMOSYNE_SECRET; the web portal stays disabled below this. */
export const MIN_SECRET_LENGTH = 16;

export interface DerivedKeys {
  /** AES-256-GCM key for data at rest (provider API keys). */
  enc: Buffer;
  /** HMAC-SHA256 key for session / OAuth-state cookies. */
  sign: Buffer;
}

/** One operator secret -> independent encryption and signing keys. */
export function deriveKeys(secret: string): DerivedKeys {
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', secret, 'mnemosyne-web', info, 32));
  return { enc: derive('enc'), sign: derive('sign') };
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Inverse of {@link seal}; throws on a wrong key or tampered data. */
export function open(key: Buffer, sealed: string): string {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unsupported sealed format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(body).digest();
}

/** `<base64url(json)>.<base64url(hmac)>`. Payload must carry its own `exp` (epoch seconds). */
export function signToken(key: Buffer, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(key, body).toString('base64url')}`;
}

/** Returns the payload, or null if the signature is wrong, the token is malformed or expired. */
export function verifyToken<T extends { exp: number }>(key: Buffer, token: string | undefined): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = mac(key, body);
  const supplied = Buffer.from(sig, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    return typeof payload.exp === 'number' && payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}
