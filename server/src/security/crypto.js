import crypto from "node:crypto";

export function encryptSecret(plainText, base64Key) {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("API_KEY_ENCRYPTION_KEY 必须是 32 字节 base64 密钥。");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(payload, base64Key) {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("API_KEY_ENCRYPTION_KEY 必须是 32 字节 base64 密钥。");
  }
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

