/**
 * 进程内滑动窗口限流：降低 token 枚举 / 批量盗领。
 * 多实例部署时各自计数，仍能挡住单机扫描。
 */

type Bucket = number[];

const buckets = new Map<string, Bucket>();

export function allowRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const cutoff = now - windowMs;
  const prev = (buckets.get(key) || []).filter((t) => t > cutoff);
  if (prev.length >= limit) {
    buckets.set(key, prev);
    return false;
  }
  prev.push(now);
  buckets.set(key, prev);
  return true;
}

export function resetRateLimitForTests() {
  buckets.clear();
}

export function clientIpFromRequest(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return req.headers.get("x-real-ip") || "unknown";
}
