import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@andyyyds/shared/auth";
import { listMyCouponInstances } from "@andyyyds/shared/coupon-availability";
import { formatCouponBenefit } from "@andyyyds/shared/coupons";
import { prisma } from "@andyyyds/shared/db";
import { productDetailPath } from "@andyyyds/shared/product-types";
import { formatPrice } from "@andyyyds/shared/utils";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  CLAIMED: "已领取未使用",
  RESERVED: "下单占用中",
  REDEEMED: "已核销",
  EXPIRED: "已过期",
  DISABLED: "已停用",
};

export default async function MyCouponsPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/account/coupons");
  const coupons = await listMyCouponInstances(prisma, session.id);

  return (
    <div className="container space-y-6 py-12">
      <div>
        <h1 className="text-3xl font-semibold">我的优惠券</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          这里只显示你已领取的独立优惠券。领取链接被别人占用后不会出现在此列表。
        </p>
      </div>
      {coupons.length === 0 ? (
        <div className="surface rounded-[28px] p-6 text-sm text-[var(--muted)]">
          暂无已领取的优惠券。
        </div>
      ) : (
        <ul className="space-y-3">
          {coupons.map((c) => {
            const first = c.campaign.products[0];
            const useHref =
              c.status === "CLAIMED"
                ? first
                  ? productDetailPath(first.slug, first.productType)
                  : "/courses"
                : "";
            return (
              <li key={c.instanceId} className="surface rounded-[28px] p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold">{c.campaign.name}</div>
                    <div className="mt-1 text-sm text-[var(--fire)]">
                      {formatCouponBenefit(c.campaign)}
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      券编号 {c.serialNo}
                      {c.campaign.minAmount > 0
                        ? ` · 满 ${formatPrice(c.campaign.minAmount)}`
                        : " · 无门槛"}
                    </div>
                  </div>
                  <span className="text-sm text-[var(--muted)]">
                    {STATUS_LABEL[c.status] || c.status}
                  </span>
                </div>
                {useHref ? (
                  <Link href={useHref} className="btn btn-primary mt-4 inline-flex min-h-11">
                    去使用
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Link href="/account" className="text-sm text-[var(--brand)]">
        返回个人中心
      </Link>
    </div>
  );
}
