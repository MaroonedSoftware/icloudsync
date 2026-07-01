import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SrpSession } from '../src/srp/client.srp.js';
import { N, G, N_LENGTH, bigIntToBytes, bytesToBigInt, concatBytes, mod, modPow, pad, xorBytes } from '../src/srp/modp.js';

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('modp helpers', () => {
    it('round-trips bytes <-> BigInt', () => {
        const value = 0x0012abff34n;
        expect(bytesToBigInt(bigIntToBytes(value))).toBe(value);
    });

    it('pads to N length', () => {
        expect(pad(new Uint8Array([1, 2, 3]), 5)).toEqual(new Uint8Array([0, 0, 1, 2, 3]));
        expect(pad(new Uint8Array([1, 2, 3]), 2)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('computes modular exponentiation', () => {
        expect(modPow(4n, 13n, 497n)).toBe(445n);
        expect(modPow(G, 0n, N)).toBe(1n);
    });
});

/**
 * A minimal SRP-6a *server* that mirrors the client's conventions, so we can
 * verify the math end-to-end without Apple. The server holds the verifier
 * `v = g^x`, picks an ephemeral `b`, and validates the client's M1 / produces M2.
 */
function simulateServer(accountName: string, password: string, salt: Uint8Array, iteration: number, protocol: 's2k' | 's2k_fo', b: bigint) {
    const x = SrpSession.deriveX(password, { salt, iteration, protocol });
    const v = modPow(G, x, N);
    const k = bytesToBigInt(sha256(concatBytes(pad(bigIntToBytes(N), N_LENGTH), pad(bigIntToBytes(G), N_LENGTH))));
    const B = mod(k * v + modPow(G, b, N), N);

    function verify(A: bigint, clientM1: Uint8Array): { ok: boolean; m2: Uint8Array } {
        const aMin = bigIntToBytes(A);
        const bMin = bigIntToBytes(B);
        const u = bytesToBigInt(sha256(concatBytes(pad(aMin, N_LENGTH), pad(bMin, N_LENGTH))));
        const S = modPow(mod(A * modPow(v, u, N), N), b, N);
        const K = sha256(bigIntToBytes(S));

        const hN = sha256(bigIntToBytes(N));
        const hG = sha256(pad(bigIntToBytes(G), N_LENGTH));
        const hI = sha256(utf8(accountName));
        const expectedM1 = sha256(concatBytes(xorBytes(hN, hG), hI, salt, aMin, bMin, K));
        const m2 = sha256(concatBytes(aMin, expectedM1, K));
        const ok = Buffer.compare(Buffer.from(expectedM1), Buffer.from(clientM1)) === 0;
        return { ok, m2 };
    }

    return { B, verify };
}

describe('SrpSession', () => {
    for (const protocol of ['s2k', 's2k_fo'] as const) {
        it(`produces a server-verifiable proof (${protocol})`, () => {
            const accountName = 'tester@icloud.com';
            const password = 'hunter2-correct-horse';
            const salt = new Uint8Array(16).fill(0x42);
            const iteration = 1000;
            const b = bytesToBigInt(new Uint8Array(32).fill(0x07));

            const server = simulateServer(accountName, password, salt, iteration, protocol, b);

            // Fixed ephemeral `a` for determinism.
            const session = new SrpSession(accountName, new Uint8Array(32).fill(0x05));
            const proof = session.computeProof(password, { salt, serverB: bigIntToBytes(server.B), iteration, protocol });

            const { ok, m2 } = server.verify(session.A, proof.m1);
            expect(ok).toBe(true);
            // The client's expected M2 matches what the server emits.
            expect(Buffer.compare(Buffer.from(proof.m2), Buffer.from(m2))).toBe(0);
        });
    }

    it('rejects a wrong password', () => {
        const accountName = 'tester@icloud.com';
        const salt = new Uint8Array(16).fill(0x42);
        const iteration = 1000;
        const b = bytesToBigInt(new Uint8Array(32).fill(0x07));
        const server = simulateServer(accountName, 'right-password', salt, iteration, 's2k', b);

        const session = new SrpSession(accountName, new Uint8Array(32).fill(0x05));
        const proof = session.computeProof('wrong-password', { salt, serverB: bigIntToBytes(server.B), iteration, protocol: 's2k' });
        expect(server.verify(session.A, proof.m1).ok).toBe(false);
    });
});
