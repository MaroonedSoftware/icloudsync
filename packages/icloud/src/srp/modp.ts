/**
 * BigInt / byte-array primitives for SRP-6a.
 *
 * Apple's GSA SRP uses the RFC 5054 2048-bit group with SHA-256. All operands
 * exchanged in hashes are left-padded ("PAD") to the byte length of N (256 bytes).
 */

/** RFC 5054 2048-bit group modulus (hex, upper-case). */
export const N_HEX =
    'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050' +
    'A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50' +
    'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8' +
    '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B' +
    'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748' +
    '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6' +
    'AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6' +
    '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73';

/** The 2048-bit modulus N as a BigInt. */
export const N = BigInt('0x' + N_HEX);

/** The generator g for the RFC 5054 2048-bit group. */
export const G = 2n;

/** Byte length of N — the PAD width for all hashed operands. */
export const N_LENGTH = 256;

/** Positive modulo (BigInt `%` keeps the sign of the dividend). */
export function mod(a: bigint, m: bigint): bigint {
    const r = a % m;
    return r >= 0n ? r : r + m;
}

/** Modular exponentiation: base^exp mod m, via square-and-multiply. */
export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
    if (m === 1n) return 0n;
    let result = 1n;
    let b = mod(base, m);
    let e = exp;
    while (e > 0n) {
        if (e & 1n) result = (result * b) % m;
        e >>= 1n;
        b = (b * b) % m;
    }
    return result;
}

/** Big-endian byte array -> BigInt. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex.length ? BigInt('0x' + hex) : 0n;
}

/** BigInt -> minimal big-endian byte array. */
export function bigIntToBytes(value: bigint): Uint8Array {
    if (value < 0n) throw new RangeError('cannot encode a negative BigInt');
    if (value === 0n) return new Uint8Array([0]);
    let hex = value.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Left-pad a byte array with zeros to `length` bytes (no-op if already long enough). */
export function pad(bytes: Uint8Array, length: number = N_LENGTH): Uint8Array {
    if (bytes.length >= length) return bytes;
    const out = new Uint8Array(length);
    out.set(bytes, length - bytes.length);
    return out;
}

/** Concatenate byte arrays. */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

/** Byte-wise XOR of two equal-length arrays (truncates to the shorter). */
export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const len = Math.min(a.length, b.length);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
    return out;
}
