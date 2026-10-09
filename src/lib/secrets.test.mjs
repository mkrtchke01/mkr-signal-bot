import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decryptSecret, encryptSecret, hashPassword, maskKey, newToken, normalizeEmail,
  sha256, verifyPassword,
} from "./secrets.ts";

test("пароль: хеш с солью, проверка верного и неверного", () => {
  const h = hashPassword("correct horse");
  assert.ok(h.startsWith("scrypt$"));
  assert.notEqual(h, hashPassword("correct horse"), "соль у каждого хеша своя");
  assert.equal(verifyPassword("correct horse", h), true);
  assert.equal(verifyPassword("wrong", h), false);
  assert.equal(verifyPassword("x", "garbage"), false);
});

test("токен сессии случайный, в базу идёт его sha256", () => {
  const a = newToken();
  assert.notEqual(a, newToken());
  assert.equal(sha256(a).length, 64);
  assert.equal(sha256(a), sha256(a));
});

test("секрет API шифруется и расшифровывается только тем же ключом", () => {
  const key = "a-very-long-encryption-key-123";
  const box = encryptSecret("my-bingx-secret", key);
  assert.ok(!box.includes("my-bingx-secret"));
  assert.equal(decryptSecret(box, key), "my-bingx-secret");
  assert.throws(() => decryptSecret(box, "another-long-encryption-key"));
  assert.throws(() => encryptSecret("x", "short"));
});

test("маска ключа и нормализация email", () => {
  assert.equal(maskKey("ABCDEFGHIJKL"), "ABCD••••IJKL");
  assert.equal(maskKey(null), null);
  assert.equal(normalizeEmail("  Egor@Example.COM "), "egor@example.com");
  assert.equal(normalizeEmail("nope"), null);
});
