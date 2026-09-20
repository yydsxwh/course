/**
 * 独立优惠券 token：密码学随机、哈希校验、管理员可恢复的加密存储。
 * 完整 token 不得写入日志。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import {
  couponClaimAbsoluteUrl,
  couponClaimLoginPath,
  couponClaimPath,
} from "./coupon-paths";

export { couponClaimAbsoluteUrl, couponClaimLoginPath, couponClaimPath };

/** 192 bit；URL-safe */
const TOKEN_BYTES = 24;
const CIPHER_VERSION = "v1";

export function generateCouponToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashCouponToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function couponTokenHint(token: string): string {
  if (token.length < 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function tokenKey(): Buffer {
  const raw = process.env.COUPON_TOKEN_KEY || process.env.AUTH_SECRET;
  if (!raw) {
    throw new Error("COUPON_TOKEN_KEY 或 AUTH_SECRET 未配置");
  }
  return createHash("sha256").update(`coupon-token-v1:${raw}`, "utf8").digest();
}

export function encryptCouponToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    iv.toString("base64url"),
    enc.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptCouponToken(payload: string): string {
  const [ver, ivB64, encB64, tagB64] = payload.split(".");
  if (ver !== CIPHER_VERSION || !ivB64 || !encB64 || !tagB64) {
    throw new Error("TOKEN_CIPHER_INVALID");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    tokenKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

