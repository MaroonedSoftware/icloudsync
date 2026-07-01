import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { N, G, N_LENGTH, mod, modPow, bytesToBigInt, bigIntToBytes, pad, concatBytes, xorBytes } from './modp.js';

/**
 * SRP-6a client for Apple's GSA authentication.
 *
 * Matches the recipe `pyicloud` uses (the Python `srp` library with
 * `rfc5054_enable()` + `no_username_in_x()`), SHA-256, RFC 5054 2048-bit group:
 *
 * - Password hash `P = PBKDF2-SHA256(SHA-256(password), salt, iter)` — for the
 *   `s2k_fo` protocol, `SHA-256(password)` is first lowercase-hex-encoded.
 * - Private value `x = SHA-256(salt ‖ SHA-256(':' ‖ P))`. `no_username_in_x`
 *   empties the username but keeps the `:` separator.
 * - `k = SHA-256(PAD(N) ‖ PAD(g))`, `u = SHA-256(PAD(A) ‖ PAD(B))`, and the
 *   `H(g)` inside `H(N)⊕H(g)` all use operands left-padded to N's byte length.
 * - `K = SHA-256(S)` and the client proof `M1 = SHA-256(H(N)⊕H(g) ‖ H(I) ‖ salt
 *   ‖ A ‖ B ‖ K)` use the *minimal* big-endian bytes of `S`, `A`, `B` (NOT
 *   padded). `M2 = SHA-256(A ‖ M1 ‖ K)`.
 */

function sha256(data: Uint8Array): Uint8Array {
    return new Uint8Array(createHash('sha256').update(data).digest());
}

function utf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function toHex(bytes: Uint8Array): string {
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
}

/** The SRP parameters returned by Apple's `/signin/init` step. */
export interface SrpChallenge {
    /** PBKDF2 salt (raw bytes). */
    salt: Uint8Array;
    /** Server public value B (raw bytes). */
    serverB: Uint8Array;
    /** PBKDF2 iteration count. */
    iteration: number;
    /** Password-hash protocol selected by the server. */
    protocol: 's2k' | 's2k_fo';
}

/** The client proof (M1) and the expected server proof (M2). */
export interface SrpProof {
    m1: Uint8Array;
    m2: Uint8Array;
}

export class SrpSession {
    /** Ephemeral private value a. */
    private readonly a: bigint;
    /** Ephemeral public value A = g^a mod N. */
    readonly A: bigint;

    /**
     * @param accountName Apple ID — the SRP identity `I`.
     * @param ephemeral Optional fixed `a` (32 bytes) for deterministic tests.
     */
    constructor(
        private readonly accountName: string,
        ephemeral?: Uint8Array,
    ) {
        this.a = bytesToBigInt(ephemeral ?? new Uint8Array(randomBytes(32)));
        this.A = modPow(G, this.a, N);
    }

    /** Client public value A as minimal big-endian bytes (base64-encode for the wire). */
    get publicA(): Uint8Array {
        return bigIntToBytes(this.A);
    }

    /** Derive the password hash `P = PBKDF2(SHA-256(password), salt, iter)`. */
    static derivePasswordHash(password: string, challenge: Pick<SrpChallenge, 'salt' | 'iteration' | 'protocol'>): Uint8Array {
        let passHash = sha256(utf8(password));
        if (challenge.protocol === 's2k_fo') passHash = utf8(toHex(passHash));
        return new Uint8Array(pbkdf2Sync(Buffer.from(passHash), Buffer.from(challenge.salt), challenge.iteration, 32, 'sha256'));
    }

    /** Derive the private SRP value `x = SHA-256(salt ‖ SHA-256(':' ‖ P))`. */
    static deriveX(password: string, challenge: Pick<SrpChallenge, 'salt' | 'iteration' | 'protocol'>): bigint {
        const passwordHash = SrpSession.derivePasswordHash(password, challenge);
        const inner = sha256(concatBytes(utf8(':'), passwordHash));
        return bytesToBigInt(sha256(concatBytes(challenge.salt, inner)));
    }

    /** Compute the client proof M1 and the expected server proof M2. */
    computeProof(password: string, challenge: SrpChallenge): SrpProof {
        const B = bytesToBigInt(challenge.serverB);
        if (mod(B, N) === 0n) throw new Error('SRP: server sent an invalid B (B mod N == 0)');

        // Minimal (unpadded) and padded byte forms; M1/M2/K use minimal, k/u use padded.
        const aMin = bigIntToBytes(this.A);
        const bMin = bigIntToBytes(B);
        const aPad = pad(aMin, N_LENGTH);
        const bPad = pad(bMin, N_LENGTH);

        const k = bytesToBigInt(sha256(concatBytes(pad(bigIntToBytes(N), N_LENGTH), pad(bigIntToBytes(G), N_LENGTH))));
        const u = bytesToBigInt(sha256(concatBytes(aPad, bPad)));
        if (u === 0n) throw new Error('SRP: u == 0');

        const x = SrpSession.deriveX(password, challenge);
        const gx = modPow(G, x, N);
        const base = mod(B - mod(k * gx, N), N);
        const S = modPow(base, this.a + u * x, N);
        const K = sha256(bigIntToBytes(S));

        const hN = sha256(bigIntToBytes(N));
        const hG = sha256(pad(bigIntToBytes(G), N_LENGTH));
        const hI = sha256(utf8(this.accountName));

        const m1 = sha256(concatBytes(xorBytes(hN, hG), hI, challenge.salt, aMin, bMin, K));
        const m2 = sha256(concatBytes(aMin, m1, K));
        return { m1, m2 };
    }
}
