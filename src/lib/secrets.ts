// Пароли, сессии и API-ключи бирж. Только встроенный crypto Node — без
// внешних зависимостей. Модуль чистый: базы и сети здесь нет.
//
//  - Пароль хранится как scrypt-хеш с солью: «scrypt$<соль>$<хеш>».
//  - Сессия — случайный токен в httpOnly-куке; в базе лежит только его SHA-256,
//    поэтому утечка таблицы сессий не даёт войти чужим токеном.
//  - Секрет API-ключа шифруется AES-256-GCM ключом из ENCRYPTION_KEY.
//    Без этой переменной ключи не сохраняются вовсе. Сменить её — значит
//    потерять все сохранённые ключи: расшифровать их будет нечем.

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_LEN);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, saltB64, hashB64] = stored.split("$");
  if (kind !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// Ключ шифрования: любая длинная строка из ENCRYPTION_KEY, приводим к 32 байтам
function encKey(secret = process.env.ENCRYPTION_KEY): Buffer {
  if (!secret || secret.length < 16) {
    throw new Error("Не задан ENCRYPTION_KEY (минимум 16 символов) — ключи API сохранить нельзя");
  }
  return createHash("sha256").update(secret).digest();
}

/** «v1.<iv>.<tag>.<данные>» в base64url */
export function encryptSecret(plain: string, secret?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(secret), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, data].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}

export function decryptSecret(box: string, secret?: string): string {
  const [v, iv, tag, data] = box.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Повреждённый зашифрованный ключ");
  const decipher = createDecipheriv("aes-256-gcm", encKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

// API-ключ показываем только краешками
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function normalizeEmail(email: unknown): string | null {
  const e = String(email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200 ? e : null;
}

export const MIN_PASSWORD = 8;
