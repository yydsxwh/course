/** 领取页路径（可在客户端使用，不含 node:crypto）。 */

export function couponClaimPath(token: string): string {
  return `/coupon/claim/${encodeURIComponent(token)}`;
}

export function couponClaimLoginPath(token: string): string {
  return `/login?next=${encodeURIComponent(couponClaimPath(token))}`;
}

export function couponClaimAbsoluteUrl(token: string, base: string): string {
  return `${base.replace(/\/$/, "")}${couponClaimPath(token)}`;
}
