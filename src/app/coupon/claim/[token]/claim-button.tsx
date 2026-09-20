"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { couponClaimLoginPath } from "@andyyyds/shared/coupon-paths";

type Props = {
  token: string;
  loggedIn: boolean;
  claimState: string;
  message?: string;
  useHref?: string;
};

export function CouponClaimButton({
  token,
  loggedIn,
  claimState,
  message,
  useHref,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(claimState === "mine");

  async function claim() {
    if (!loggedIn) {
      router.push(couponClaimLoginPath(token));
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/coupons/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "领取失败");
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  if (claimState === "taken") {
    return <p className="text-sm text-red-700">该优惠券已被领取</p>;
  }
  if (claimState === "blocked") {
    return <p className="text-sm text-red-700">{message || "当前不可领取"}</p>;
  }
  if (done || claimState === "mine") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-[var(--brand-strong)]">你已领取</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          {useHref ? (
            <a href={useHref} className="btn btn-primary min-h-11 flex-1 text-center">
              去使用
            </a>
          ) : (
            <a href="/account/coupons" className="btn btn-primary min-h-11 flex-1 text-center">
              我的优惠券
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        className="btn btn-primary w-full min-h-11"
        disabled={busy}
        onClick={() => void claim()}
      >
        {busy ? "领取中..." : loggedIn ? "立即领取" : "登录后领取"}
      </button>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
