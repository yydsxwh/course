/**
 * 旧公共领券页已停用：不再用一个券码共享库存。
 */

import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function LegacyCouponPage() {
  return (
    <div className="container py-12">
      <div className="surface mx-auto max-w-lg rounded-[28px] p-6 text-center">
        <h1 className="text-2xl font-semibold">该分享方式已停用</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          公共优惠券链接不再对应一批可转发的共享库存。请使用管理员发放的独立领取链接（每张券一个地址）。
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link href="/account/coupons" className="btn btn-primary min-h-11 flex-1">
            我的优惠券
          </Link>
          <Link href="/courses" className="btn btn-secondary min-h-11 flex-1">
            去课程广场
          </Link>
        </div>
      </div>
    </div>
  );
}
