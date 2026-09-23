/**
 * 购买页：只列出当前用户已领取、可用于该商品的独立券。
 */

import type { PrismaClient } from "@prisma/client";
import { calcCouponDiscount, formatCouponBenefit } from "./coupons";
import {
  campaignToDiscountInput,
  effectiveInstanceStatus,
  isCampaignUsable,
  loadCampaignRule,
} from "./coupon-instance";

export type BuyerCouponView = {
  id: string;
  instanceId: string;
  code: string;
  title: string;
  type: string;
  benefit: string;
  discountCents: number;
  minAmount: number;
  expiresAt: string | null;
  available: boolean;
  reason?: string;
  /** 这张券被哪张待支付订单占用；仅本人可见，用于继续支付或取消 */
  reservedOrderId?: string;
};

export async function listCouponsForBuyer(
  db: PrismaClient,
  input: { userId: string; courseId: string; now?: Date },
): Promise<{
  coupons: BuyerCouponView[];
  unavailable: BuyerCouponView[];
  coursePrice: number;
}> {
  const course = await db.course.findUnique({ where: { id: input.courseId } });
  if (!course || course.status !== "PUBLISHED" || course.price <= 0) {
    return { coupons: [], unavailable: [], coursePrice: course?.price ?? 0 };
  }

  const now = input.now || new Date();
  const rows = await db.couponInstance.findMany({
    where: {
      claimedByUserId: input.userId,
      status: { in: ["CLAIMED", "RESERVED", "REDEEMED"] },
      campaign: {
        deletedAt: null,
        OR: [
          { productScope: "ALL" },
          { products: { some: { courseId: course.id } } },
        ],
      },
    },
    include: {
      campaign: { include: { products: { select: { courseId: true } } } },
    },
    orderBy: { claimedAt: "desc" },
    take: 80,
  });

  const available: BuyerCouponView[] = [];
  const unavailable: BuyerCouponView[] = [];
  const reservedIds = rows
    .map((row) => row.reservedOrderId)
    .filter((id): id is string => Boolean(id));
  const reservedOrders = reservedIds.length
    ? await db.order.findMany({
        where: { id: { in: reservedIds }, userId: input.userId },
        select: { id: true, courseId: true, status: true },
      })
    : [];
  const reservedById = new Map(reservedOrders.map((order) => [order.id, order]));

  for (const row of rows) {
    const campaign = await loadCampaignRule(db, row.campaignId);
    if (!campaign) continue;
    const discount = calcCouponDiscount(
      course.price,
      campaignToDiscountInput(campaign),
    );
    const base: BuyerCouponView = {
      id: row.id,
      instanceId: row.id,
      code: row.serialNo,
      title: campaign.name,
      type: campaign.type,
      benefit: formatCouponBenefit(campaign),
      discountCents: discount,
      minAmount: campaign.minAmount,
      expiresAt: campaign.expiresAt?.toISOString() ?? null,
      available: true,
    };
    const effective = effectiveInstanceStatus(row.status, campaign, now);
    if (effective === "REDEEMED") {
      unavailable.push({ ...base, available: false, reason: "你已使用过这张优惠券" });
      continue;
    }
    if (effective === "RESERVED" && row.reservedOrderId) {
      const reserved = reservedById.get(row.reservedOrderId);
      const sameProduct = reserved?.courseId === course.id && reserved.status === "PENDING";
      unavailable.push({
        ...base,
        available: false,
        reason: sameProduct
          ? "已用于待支付订单"
          : "你有未支付订单正在使用这张优惠券",
        reservedOrderId:
          reserved?.status === "PENDING" ? reserved.id : undefined,
      });
      continue;
    }
    if (effective === "EXPIRED") {
      unavailable.push({ ...base, available: false, reason: "优惠券已过期" });
      continue;
    }
    const reason = isCampaignUsable(campaign, now, course.id);
    if (reason) {
      unavailable.push({ ...base, available: false, reason });
      continue;
    }
    available.push(base);
  }

  available.sort((a, b) => b.discountCents - a.discountCents);
  return { coupons: available, unavailable, coursePrice: course.price };
}

export async function listMyCouponInstances(
  db: PrismaClient,
  userId: string,
  now = new Date(),
) {
  const rows = await db.couponInstance.findMany({
    where: { claimedByUserId: userId },
    include: {
      campaign: {
        include: {
          products: {
            include: {
              course: {
                select: { id: true, title: true, slug: true, productType: true, status: true },
              },
            },
          },
        },
      },
    },
    orderBy: { claimedAt: "desc" },
    take: 100,
  });
  return rows.map((row) => {
    const campaign = row.campaign;
    const status = effectiveInstanceStatus(row.status, campaign, now);
    return {
      instanceId: row.id,
      serialNo: row.serialNo,
      status,
      claimedAt: row.claimedAt?.toISOString() ?? null,
      redeemedAt: row.redeemedAt?.toISOString() ?? null,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        type: campaign.type,
        discountCents: campaign.discountCents,
        percentOff: campaign.percentOff,
        minAmount: campaign.minAmount,
        productScope: campaign.productScope,
        expiresAt: campaign.expiresAt?.toISOString() ?? null,
        products: campaign.products
          .map((p) => p.course)
          .filter((c) => c && c.status === "PUBLISHED"),
      },
    };
  });
}
