/**
 * 购买页优惠券列表：可用券 + 不可用原因（仅当前商品相关券）。
 */

import type { PrismaClient } from "@prisma/client";
import {
  calcCouponDiscount,
  couponAppliesToProduct,
  formatCouponBenefit,
  validateCouponForOrder,
} from "./coupons";
import { toCouponForOrder } from "./coupon-reservation";

export type BuyerCouponView = {
  id: string;
  code: string;
  title: string;
  type: string;
  benefit: string;
  discountCents: number;
  minAmount: number;
  expiresAt: string | null;
  available: boolean;
  reason?: string;
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
  const rows = await db.coupon.findMany({
    where: {
      OR: [{ productScope: "ALL" }, { products: { some: { courseId: course.id } } }],
    },
    include: { products: { select: { courseId: true } } },
    orderBy: { createdAt: "desc" },
    take: 80,
  });

  const redeemed = await db.couponRedemption.findMany({
    where: {
      userId: input.userId,
      couponId: { in: rows.map((c) => c.id) },
    },
    select: { couponId: true },
  });
  const redeemedSet = new Set(redeemed.map((r) => r.couponId));

  const pendingHolds = await db.order.findMany({
    where: {
      userId: input.userId,
      status: "PENDING",
      couponId: { in: rows.map((c) => c.id) },
    },
    select: { couponId: true },
  });
  const pendingSet = new Set(
    pendingHolds.map((o) => o.couponId).filter(Boolean) as string[],
  );

  const available: BuyerCouponView[] = [];
  const unavailable: BuyerCouponView[] = [];

  for (const row of rows) {
    const coupon = toCouponForOrder(row);
    if (!couponAppliesToProduct(coupon, course.id)) continue;
    const discount = calcCouponDiscount(course.price, coupon);
    const base: BuyerCouponView = {
      id: coupon.id,
      code: row.code,
      title: row.title,
      type: coupon.type,
      benefit: formatCouponBenefit(coupon),
      discountCents: discount,
      minAmount: coupon.minAmount,
      expiresAt: coupon.expiresAt?.toISOString() ?? null,
      available: true,
    };

    if (redeemedSet.has(coupon.id)) {
      unavailable.push({ ...base, available: false, reason: "你已使用过这张优惠券" });
      continue;
    }
    if (pendingSet.has(coupon.id)) {
      unavailable.push({
        ...base,
        available: false,
        reason: "你有未支付订单正在使用这张优惠券",
      });
      continue;
    }
    const reason = validateCouponForOrder(coupon, course.price, now, course.id);
    if (reason) {
      unavailable.push({ ...base, available: false, reason });
      continue;
    }
    available.push(base);
  }

  available.sort((a, b) => b.discountCents - a.discountCents);
  return { coupons: available, unavailable, coursePrice: course.price };
}
