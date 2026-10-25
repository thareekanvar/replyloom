import { describe, expect, it } from "vitest";
import { encryptBackupPayload, decryptBackupPayload } from "../../../../scripts/config.mjs";

describe("R2 backup AES-256-GCM encryption", () => {
  const passphrase = "correct-horse-battery-staple-2026";

  it("encrypts and decrypts backup payloads with AES-256-GCM + PBKDF2-SHA256", () => {
    const secretSql = "INSERT INTO messages VALUES ('msg_1', 'Sensitive customer WhatsApp message');";
    const envelopeStr = encryptBackupPayload(secretSql, passphrase);
    const parsed = JSON.parse(envelopeStr);

    expect(parsed.encrypted).toBe(true);
    expect(parsed.algorithm).toBe("aes-256-gcm");
    expect(parsed.kdf).toBe("pbkdf2-sha256");
    expect(parsed.iterations).toBe(600_000);
    expect(envelopeStr).not.toContain("Sensitive customer WhatsApp message");

    const decrypted = decryptBackupPayload(envelopeStr, passphrase).toString("utf8");
    expect(decrypted).toBe(secretSql);
  });

  it("rejects weak passphrases, wrong passphrases, and tampered ciphertext", () => {
    expect(() => encryptBackupPayload("data", "short")).toThrow(/at least 12 characters/);

    const envelopeStr = encryptBackupPayload("top-secret-config", passphrase);
    expect(() => decryptBackupPayload(envelopeStr, "wrong-passphrase-12345")).toThrow();

    const tampered = JSON.parse(envelopeStr);
    const tagBuf = Buffer.from(tampered.tag, "base64");
    tagBuf[0] ^= 0xff;
    tampered.tag = tagBuf.toString("base64");
    expect(() => decryptBackupPayload(tampered, passphrase)).toThrow();
  });
});
