import { describe, it } from "node:test";
import * as assert from "node:assert";

// Set env before import
process.env.DATA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { encrypt, decrypt } = await import("./crypto.js");

describe("AES-256-GCM crypto", () => {
  it("round-trips a string", () => {
    const plaintext = "my-secret-token-value";
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    assert.strictEqual(decrypted, plaintext);
  });

  it("produces different ciphertext each time (unique nonces)", () => {
    const plaintext = "same-input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    assert.notStrictEqual(a, b);
  });

  it("encrypted format is nonce:ciphertext:tag", () => {
    const encrypted = encrypt("test");
    const parts = encrypted.split(":");
    assert.strictEqual(parts.length, 3);
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encrypt("test");
    const parts = encrypted.split(":");
    const tampered = parts[0] + ":" + "X" + parts[1].slice(1) + ":" + parts[2];
    assert.throws(() => decrypt(tampered));
  });
});
