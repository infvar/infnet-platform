function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(size = 32) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return bytesToBase64Url(bytes); }
export function randomHex(size = 16) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export function randomId() { return crypto.randomUUID(); }
export function sameSecret(left: string | undefined, right: string) { if (!left || left.length !== right.length) return false; let result = 0; for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index); return result === 0; }
export async function sha256(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function hmacSha256(value: string, secret: string) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)); return bytesToBase64Url(new Uint8Array(signature)); }
export async function hmacSha256Hex(value: string, secret: string) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)); return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function pbkdf2Hash(password: string, salt = randomHex()) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]); const digest = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 120000, hash: "SHA-256" }, key, 256); return `pbkdf2:${salt}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`; }
export async function pbkdf2Verify(password: string, encoded: string) { const [, salt, expected] = encoded.split(":"); if (!salt || !expected) return false; const actual = await pbkdf2Hash(password, salt); return sameSecret(actual, encoded); }
