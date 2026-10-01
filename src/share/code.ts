/**
 * F11 配方分享码（决策 0003：本地短码 + 码本可分享）。
 *
 * 两种码：
 * - 完整码  `FM1.<校验2位>.<base64url payload>`：payload = 配方 JSON（紧凑序列化）的
 *   base64url 编码，自带全部参数，粘贴即导入；前 2 位校验和由 payload 内容 hash 推得，
 *   防止复制/粘贴缺字后导入出错误配方。
 * - 短码    `FM-XXXX`：4 位 = 3 位数据 + 1 位校验位（对 3 位数据做 hash 校验），
 *   仅是本地码本的钥匙；分享短码需同时分享码本（.json）。
 *
 * 本模块保持纯函数、无 DOM/存储依赖（vitest 直接覆盖）；码本持久化在 ui/storage.ts。
 */

/** 结构最小约束：不引 ui/recipe 类型，避免反向依赖（Recipe 结构满足即可） */
export interface ShareableRecipe {
  schema_version: number;
  id: string;
}

/* ---------------- 基础编码 ---------------- */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** FNV-1a 32 位（与 ui/recipe.ts 同式；此处独立持有保持模块无依赖） */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bytesToB64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63] + B64URL[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63];
  }
  return out;
}

function b64urlToBytes(s: string): Uint8Array | null {
  const rev = B64URL_REVERSE ?? (B64URL_REVERSE = buildReverse());
  const L = s.length;
  if (L % 4 === 1) return null; // 编码只可能产生 4k / 4k+2 / 4k+3 长度
  const out = new Uint8Array(Math.floor(L * 3 / 4));
  let o = 0;
  for (let i = 0; i < L; i += 4) {
    const c = [0, 1, 2, 3].map((k): number => {
      const ch = i + k < L ? s.charCodeAt(i + k) : -1;
      return ch < 0 ? 0 : ch < 128 ? rev[ch] : -1; // 缺位补 0（合法尾组）；越界/非法字符 → -1
    });
    if (c.some((v) => v < 0)) return null; // 非法字符
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    out[o++] = (n >>> 16) & 0xff;
    if (i + 2 < L) out[o++] = (n >>> 8) & 0xff;
    if (i + 3 < L) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}
let B64URL_REVERSE: Int8Array | null = null;
function buildReverse(): Int8Array {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) t[B64URL.charCodeAt(i)] = i;
  return t;
}

const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: true }) : null;

/* ---------------- 完整码 ---------------- */

const FULL_PREFIX = 'FM1.';

function checkChars(json: string): string {
  const h = fnv1a32(json);
  return B64URL[h & 63] + B64URL[(h >>> 6) & 63];
}

/**
 * 配方 → 完整分享码：JSON 紧凑序列化（无空白）→ UTF-8 → base64url，前置 2 位校验和。
 */
export function encodeFull(recipe: ShareableRecipe): string {
  const json = JSON.stringify(recipe);
  const bytes = te ? te.encode(json) : fallbackEncode(json);
  return FULL_PREFIX + checkChars(json) + '.' + bytesToB64url(bytes);
}

/**
 * 完整分享码 → 配方。任何一步失败（格式/字符集/校验和/JSON/结构）返回 null，绝不抛错、
 * 绝不返回半解析结果（防粘贴错误导入脏配方）。
 */
export function decodeFull(text: string): ShareableRecipe | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, '');
  const m = /^FM1\.([A-Za-z0-9_-]{2})\.([A-Za-z0-9_-]+)$/.exec(t);
  if (!m) return null;
  const bytes = b64urlToBytes(m[2]);
  if (!bytes || bytes.length === 0) return null;
  let json: string;
  try {
    json = td ? td.decode(bytes) : fallbackDecode(bytes);
  } catch {
    return null;
  }
  if (checkChars(json) !== m[1]) return null; // 校验和拦截
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  return isRecipeShape(obj) ? obj : null;
}

/** 最小结构校验：能驱动 recipeToState 的底线（字段完整性交给 normalizeParams 兜底） */
function isRecipeShape(o: unknown): o is ShareableRecipe {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  /* 接受 1 / 1.1 / 1.2 / 1.3（只增字段：v1.2 分离色调、v1.3 coupling/hsl/anchors；旧配方由 normalizeParams 补默认） */
  const ver = r['schema_version'];
  if (ver !== 1 && ver !== 1.1 && ver !== 1.2 && ver !== 1.3) return false;
  if (typeof r['id'] !== 'string' || !r['id']) return false;
  const color = r['color'] as Record<string, unknown> | undefined;
  if (!color || typeof color !== 'object' || typeof color['params'] !== 'object') return false;
  const tex = r['texture'];
  if (!tex || typeof tex !== 'object' || Array.isArray(tex)) return false;
  return true;
}

/* ---------------- 短码（3 数据位 + 1 校验位） ---------------- */

/** 与 ui/recipe.ts 同表：去 I/L/O/0/1 防混淆（31 字符） */
export const SHORT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function shortCheck(data3: string): string {
  return SHORT_ALPHABET[fnv1a32('FM短码校验:' + data3) % SHORT_ALPHABET.length];
}

/** 3 位数据字符 → 带校验位短码 FM-XXXX */
export function shortCodeWithCheck(data3: string): string | null {
  if (!/^[A-Z2-9]{3}$/.test(data3) || [...data3].some((c) => !SHORT_ALPHABET.includes(c))) return null;
  return 'FM-' + data3 + shortCheck(data3);
}

/** 短码校验位核验（人类抄写防错）；接受任意大小写与首尾空白 */
export function verifyShortCode(code: string): boolean {
  const t = code.trim().toUpperCase();
  const m = /^FM-([A-Z2-9]{3})([A-Z2-9])$/.exec(t);
  if (!m || !m[1].split('').every((c) => SHORT_ALPHABET.includes(c))) return false;
  return shortCheck(m[1]) === m[2];
}

/** 短码自增（码本冲突时由 storage 调用）：3 位数据字符按 31 进制 +1，重算校验位；溢出回绕 */
export function bumpShortCode(code: string): string {
  const t = code.trim().toUpperCase();
  const m = /^FM-([A-Z2-9]{3})[A-Z2-9]$/.exec(t);
  if (!m) throw new Error('无法自增的短码：' + code);
  const chars = m[1].split('').map((c) => SHORT_ALPHABET.indexOf(c));
  for (let i = 2; i >= 0; i--) {
    chars[i] = (chars[i] + 1) % SHORT_ALPHABET.length;
    if (chars[i] !== 0) break;
  }
  const data = chars.map((c) => SHORT_ALPHABET[c]).join('');
  return 'FM-' + data + shortCheck(data);
}

/* ---------------- node/旧环境兜底（vitest node 环境有 TextEncoder，通常不走这里） ---------------- */

function fallbackEncode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}
function fallbackDecode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp: number;
    if (b < 0x80) { cp = b; i += 1; }
    else if (b < 0xe0) { cp = ((b & 31) << 6) | (bytes[i + 1] & 63); i += 2; }
    else if (b < 0xf0) { cp = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); i += 3; }
    else { cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); i += 4; }
    out += String.fromCodePoint(cp);
  }
  return out;
}
