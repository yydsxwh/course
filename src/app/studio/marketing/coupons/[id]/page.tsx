import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CouponCampaignDetail } from "@/components/coupon-campaign-detail";
import { MarketingSubnav } from "@/components/marketing-subnav";
import { StudioNav } from "@/components/studio-nav";
import { getSession } from "@andyyyds/shared/auth";
import { campaignStats } from "@andyyyds/shared/coupon-campaign";
import { prisma } from "@andyyyds/shared/db";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";

export const dynamic = "force-dynamic";

export default async function CouponCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canManageCoupons(session.role)) redirect("/studio");
  const { id } = await params;
  const campaign = await prisma.couponCampaign.findUnique({
    where: { id },
    include: {
      products: {
        include: {
          course: { select: { id: true, title: true, slug: true, productType: true } },
        },
      },
    },
  });
  if (!campaign || campaign.deletedAt) notFound();
  if (!canViewAllStudioData(session.role) && campaign.createdById !== session.id) {
    redirect("/studio/marketing/coupons");
  }
  const stats = await campaignStats(prisma, id);
  return (
    <div className="container space-y-6 py-12">
      <StudioNav current="marketing" />
      <div>
        <Link href="/studio/marketing/coupons" className="text-sm text-[var(--brand)]">
          返回优惠券活动
        </Link>
        <h1 className="mt-2 text-3xl font-semibold">{campaign.name}</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          批次 {campaign.code}。每张券有独立领取链接；领取与核销是两个状态。
        </p>
      </div>
      <MarketingSubnav current="coupons" />
      <CouponCampaignDetail
        campaignId={campaign.id}
        name={campaign.name}
        description={campaign.description}
        code={campaign.code}
        type={campaign.type}
        discountCents={campaign.discountCents}
        percentOff={campaign.percentOff}
        minAmount={campaign.minAmount}
        maxPerUser={campaign.maxPerUser}
        issueCount={campaign.issueCount}
        productScope={campaign.productScope}
        products={campaign.products
          .map((p) => p.course)
          .filter(Boolean)
          .map((c) => ({ id: c!.id, title: c!.title }))}
        startsAt={campaign.startsAt?.toISOString() ?? null}
        expiresAt={campaign.expiresAt?.toISOString() ?? null}
        stats={
          stats
            ? {
                generated: stats.generated,
                available: stats.available,
                claimed: stats.claimedUnused,
                redeemed: stats.redeemed,
                expired: stats.expired,
                disabled: stats.disabled,
              }
            : {
                generated: 0,
                available: 0,
                claimed: 0,
                redeemed: 0,
                expired: 0,
                disabled: 0,
              }
        }
      />
    </div>
  );
}
