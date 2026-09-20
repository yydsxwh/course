import { redirect } from "next/navigation";
import {
  CouponAdminPanel,
  type CouponAdminRow,
  type CouponProductOption,
} from "@/components/coupon-admin-panel";
import { MarketingSubnav } from "@/components/marketing-subnav";
import { StudioNav } from "@/components/studio-nav";
import { getSession } from "@andyyyds/shared/auth";
import { prisma } from "@andyyyds/shared/db";
import { ensureMeetupProductCourse } from "@andyyyds/meetup/lib/meetup-product";
import { MATHCODE_PRODUCT_TYPE } from "@andyyyds/shared/product-types";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";

export const dynamic = "force-dynamic";

export default async function StudioCouponsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canManageCoupons(session.role)) redirect("/studio");

  const seeAll = canViewAllStudioData(session.role);

  try {
    const orphanMeetups = await prisma.meetup.findMany({
      where: { productCourseId: null },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    for (const m of orphanMeetups) {
      await ensureMeetupProductCourse(prisma, m);
    }
  } catch (error) {
    console.error("[coupons:meetup-product-backfill]", error);
  }

  const [rows, products] = await Promise.all([
    prisma.couponCampaign.findMany({
      where: {
        deletedAt: null,
        ...(seeAll ? {} : { createdById: session.id }),
      },
      include: {
        products: {
          include: {
            course: {
              select: { id: true, title: true, slug: true, productType: true },
            },
          },
        },
        _count: { select: { instances: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.course.findMany({
      where: {
        ...(seeAll ? {} : { teacherId: session.id }),
        productType: { not: MATHCODE_PRODUCT_TYPE },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        slug: true,
        productType: true,
        status: true,
      },
      take: 500,
    }),
  ]);

  const initialCoupons: CouponAdminRow[] = rows.map((c) => {
    const productList = c.products
      .map((p) => p.course)
      .filter(Boolean)
      .map((course) => ({
        id: course!.id,
        title: course!.title,
        slug: course!.slug,
        productType: course!.productType,
      }));
    return {
      id: c.id,
      code: c.code,
      title: c.name,
      name: c.name,
      type: c.type,
      discountCents: c.discountCents,
      percentOff: c.percentOff,
      minAmount: c.minAmount,
      issueCount: c.issueCount,
      generatedCount: c._count.instances,
      maxPerUser: c.maxPerUser,
      startsAt: c.startsAt?.toISOString() ?? null,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      isActive: c.isActive,
      productScope: c.productScope || "ALL",
      productIds: productList.map((p) => p.id),
      productTitles: productList.map((p) => p.title),
      products: productList,
      createdAt: c.createdAt.toISOString(),
    };
  });

  const productOptions: CouponProductOption[] = products;

  return (
    <div className="container space-y-6 py-12">
      <StudioNav current="marketing" />
      <div>
        <h1 className="text-3xl font-semibold">优惠券</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          创建一个活动会按发行数量生成独立优惠券。每张券有自己的领取链接，领取后才能下单抵扣。
        </p>
      </div>
      <MarketingSubnav current="coupons" />
      <CouponAdminPanel
        initialCoupons={initialCoupons}
        productOptions={productOptions}
      />
    </div>
  );
}
