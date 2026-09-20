import Link from "next/link";
import { getSession } from "@andyyyds/shared/auth";
import { previewInstanceByToken } from "@andyyyds/shared/coupon-instance";
import { formatCouponBenefit } from "@andyyyds/shared/coupons";
import { prisma } from "@andyyyds/shared/db";
import { productDetailPath, productTypeLabel } from "@andyyyds/shared/product-types";
import { formatPrice } from "@andyyyds/shared/utils";
import { CouponClaimButton } from "./claim-button";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

export default async function CouponInstanceClaimPage({ params }: Props) {
  const { token: raw } = await params;
  const token = decodeURIComponent(raw || "");
  const session = await getSession();
  const preview = await previewInstanceByToken(prisma, token, session?.id);

  if ("error" in preview && preview.error && !("campaign" in preview)) {
    return (
      <div className="container py-12">
        <div className="surface mx-auto max-w-lg rounded-[28px] p-6 text-center">
          <h1 className="text-2xl font-semibold">优惠券不可用</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{preview.error}</p>
          <Link href="/courses" className="btn btn-primary mt-6 inline-flex min-h-11">
            去课程广场
          </Link>
        </div>
      </div>
    );
  }

  const campaign = preview.campaign!;
  const products = campaign.productIds.length
    ? await prisma.course.findMany({
        where: { id: { in: campaign.productIds }, status: "PUBLISHED" },
        select: { id: true, title: true, slug: true, productType: true, price: true },
      })
    : [];
  const useHref =
    campaign.productScope === "SELECTED" && products.length === 1
      ? productDetailPath(products[0]!.slug, products[0]!.productType)
      : campaign.productScope === "ALL"
        ? "/courses"
        : products[0]
          ? productDetailPath(products[0].slug, products[0].productType)
          : "/account/coupons";

  return (
    <div className="container space-y-6 py-12">
      <div className="surface mx-auto max-w-lg space-y-4 rounded-[28px] p-6">
        <div>
          <p className="text-sm text-[var(--muted)]">独立优惠券</p>
          <h1 className="mt-1 text-2xl font-semibold">{campaign.name}</h1>
          {campaign.description ? (
            <p className="mt-2 text-sm text-[var(--muted)]">{campaign.description}</p>
          ) : null}
        </div>
        <div className="rounded-2xl bg-[var(--brand-soft)] px-4 py-3">
          <div className="text-lg font-semibold text-[var(--fire)]">
            {formatCouponBenefit(campaign)}
          </div>
          <div className="mt-1 text-xs text-[var(--muted)]">
            {campaign.minAmount > 0
              ? `满 ${formatPrice(campaign.minAmount)} 可用`
              : "无门槛"}
            {campaign.productScope === "ALL" ? " · 全站商品" : " · 指定商品"}
          </div>
        </div>
        <ul className="space-y-1 text-xs text-[var(--muted)]">
          <li>
            领取期限：
            {campaign.claimStartsAt || campaign.claimEndsAt
              ? `${campaign.claimStartsAt || "即日起"} 至 ${campaign.claimEndsAt || "不限"}`
              : "不限"}
          </li>
          <li>
            使用期限：
            {campaign.startsAt || campaign.expiresAt
              ? `${campaign.startsAt || "即日起"} 至 ${campaign.expiresAt || "不限"}`
              : "不限"}
          </li>
        </ul>
        {products.length > 0 ? (
          <div className="space-y-2">
            <div className="text-sm text-[var(--muted)]">适用课程</div>
            <ul className="space-y-2">
              {products.map((p) => (
                <li key={p.id} className="rounded-2xl border border-[var(--line)] px-4 py-3 text-sm">
                  <span className="mr-2 text-xs text-[var(--muted)]">
                    {productTypeLabel(p.productType)}
                  </span>
                  {p.title}
                </li>
              ))}
            </ul>
          </div>
        ) : campaign.productScope === "ALL" ? (
          <p className="text-sm text-[var(--muted)]">适用于全站已上架课程 / 资料。</p>
        ) : null}

        <CouponClaimButton
          token={token}
          loggedIn={Boolean(session)}
          claimState={preview.claimState || "blocked"}
          message={preview.message || ""}
          useHref={useHref}
        />
      </div>
    </div>
  );
}
