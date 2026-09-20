import type { CouponCampaign } from "@prisma/client";
import { formatCouponBenefit } from "./coupons";

export type CampaignWithProducts = CouponCampaign & {
  products?: Array<{
    courseId: string;
    course?: {
      id: string;
      title: string;
      slug: string;
      productType: string;
    } | null;
  }>;
  _count?: { instances?: number };
};

export function serializeCampaign(
  c: CampaignWithProducts,
  extras?: Record<string, unknown>,
) {
  const products = (c.products || [])
    .map((p) =>
      p.course
        ? {
            id: p.course.id,
            title: p.course.title,
            slug: p.course.slug,
            productType: p.course.productType,
          }
        : null,
    )
    .filter(Boolean) as Array<{
    id: string;
    title: string;
    slug: string;
    productType: string;
  }>;

  return {
    id: c.id,
    code: c.code,
    name: c.name,
    title: c.name,
    description: c.description,
    type: c.type,
    discountCents: c.discountCents,
    percentOff: c.percentOff,
    benefit: formatCouponBenefit(c),
    issueCount: c.issueCount,
    generatedCount: c._count?.instances ?? extras?.generatedCount,
    maxPerUser: c.maxPerUser,
    minAmount: c.minAmount,
    productScope: c.productScope || "ALL",
    productIds: products.map((p) => p.id),
    productTitles: products.map((p) => p.title),
    products,
    claimStartsAt: c.claimStartsAt?.toISOString() ?? null,
    claimEndsAt: c.claimEndsAt?.toISOString() ?? null,
    startsAt: c.startsAt?.toISOString() ?? null,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    isActive: c.isActive,
    deletedAt: c.deletedAt?.toISOString() ?? null,
    createdById: c.createdById,
    createdAt: c.createdAt.toISOString(),
    ...extras,
  };
}

export const campaignProductsInclude = {
  products: {
    include: {
      course: {
        select: { id: true, title: true, slug: true, productType: true },
      },
    },
  },
  _count: { select: { instances: true } },
} as const;
