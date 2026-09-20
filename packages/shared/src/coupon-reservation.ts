/**
 * 优惠券占用 / 核销 / 释放。
 * 下单时即占用库存与每用户次数；待支付超时或取消后释放，避免用户白丢券。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  validateCouponForOrder,
  type CouponDiscountInput,
} from "./coupons";
import { OrderBusinessError } from "./order-errors";

type Db = PrismaClient | Prisma.TransactionClient;

export const ORDER_PENDING_TTL_MS = 30 * 60 * 1000;

export type CouponForOrder = CouponDiscountInput & {
  id: string;
  maxPerUser: number;
};

export function toCouponForOrder(row: {
  id: string;
  type: string;
  discountCents: number;
  percentOff: number;
  minAmount: number;
  maxUses: number;
  usedCount: number;
  maxPerUser: number;
  isActive: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
  productScope?: string | null;
  products?: Array<{ courseId: string }>;
}): CouponForOrder {
  return {
    id: row.id,
    type: row.type,
    discountCents: row.discountCents,
    percentOff: row.percentOff,
    minAmount: row.minAmount,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    maxPerUser: Math.max(1, row.maxPerUser || 1),
    isActive: row.isActive,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    productScope: row.productScope,
    productIds: (row.products || []).map((p) => p.courseId),
  };
}

export async function loadCouponForOrder(
  db: Db,
  input: { couponId?: string; couponCode?: string },
): Promise<CouponForOrder | null> {
  const include = { products: { select: { courseId: true } } } as const;
  const row = input.couponId
    ? await db.coupon.findUnique({
        where: { id: input.couponId },
        include,
      })
    : input.couponCode
      ? await db.coupon.findUnique({
          where: { code: input.couponCode },
          include,
        })
      : null;
  return row ? toCouponForOrder(row) : null;
}

/**
 * 在事务内占用一张券：条件更新总库存 + 写入核销行。
 * 失败抛 OrderBusinessError，事务回滚即可。
 */
export async function reserveCouponInTx(
  db: Db,
  input: {
    coupon: CouponForOrder;
    userId: string;
    orderId: string;
    priceCents: number;
    courseId: string;
    now?: Date;
  },
) {
  const now = input.now || new Date();
  const availability = validateCouponForOrder(
    input.coupon,
    input.priceCents,
    now,
    input.courseId,
  );
  if (availability) {
    throw new OrderBusinessError(availability);
  }

  const occupied = await db.coupon.updateMany({
    where: {
      id: input.coupon.id,
      isActive: true,
      usedCount: { lt: input.coupon.maxUses },
    },
    data: { usedCount: { increment: 1 } },
  });
  if (occupied.count === 0) {
    throw new OrderBusinessError("优惠券已领完");
  }

  const usedByUser = await db.couponRedemption.count({
    where: { couponId: input.coupon.id, userId: input.userId },
  });
  if (usedByUser >= input.coupon.maxPerUser) {
    throw new OrderBusinessError("该优惠券已使用过");
  }

  await db.couponRedemption.create({
    data: {
      couponId: input.coupon.id,
      userId: input.userId,
      orderId: input.orderId,
    },
  });
}

export async function releaseCouponForOrder(db: Db, orderId: string) {
  const redemption = await db.couponRedemption.findFirst({
    where: { orderId },
  });
  if (!redemption) return;

  await db.couponRedemption.delete({ where: { id: redemption.id } });
  await db.coupon.updateMany({
    where: { id: redemption.couponId, usedCount: { gt: 0 } },
    data: { usedCount: { increment: -1 } },
  });
}

export async function cancelPendingOrder(
  db: Db,
  orderId: string,
  reason: "TIMEOUT" | "USER" | "SUPERSEDED" = "USER",
) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "PENDING") return false;
  await releaseCouponForOrder(db, orderId);
  await db.order.update({
    where: { id: orderId },
    data: {
      status: "CANCELLED",
      payChannel: order.payChannel || reason,
    },
  });
  return true;
}

/** 关闭超时未支付订单并释放优惠券。 */
export async function expireStalePendingOrders(
  db: Db,
  now: Date = new Date(),
) {
  const cutoff = new Date(now.getTime() - ORDER_PENDING_TTL_MS);
  const stale = await db.order.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    take: 50,
  });
  for (const row of stale) {
    await cancelPendingOrder(db, row.id, "TIMEOUT");
  }
}

/** 履约时：新单已占用则跳过；历史待支付单补占一次。 */
export async function fulfillCouponOnPaidOrder(
  db: Db,
  order: { id: string; userId: string; couponId: string | null },
) {
  if (!order.couponId) return;
  const existing = await db.couponRedemption.findFirst({
    where: {
      OR: [{ orderId: order.id }, { couponId: order.couponId, userId: order.userId }],
    },
  });
  if (existing) {
    if (!existing.orderId) {
      await db.couponRedemption.update({
        where: { id: existing.id },
        data: { orderId: order.id },
      });
    }
    return;
  }
  await db.coupon.update({
    where: { id: order.couponId },
    data: { usedCount: { increment: 1 } },
  });
  await db.couponRedemption.create({
    data: {
      couponId: order.couponId,
      userId: order.userId,
      orderId: order.id,
    },
  });
}
