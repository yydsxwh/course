/**
 * 待支付订单超时/取消：释放独立券预占，避免用户白丢券。
 * 兼容尚未迁移的旧 CouponRedemption。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { releaseInstanceForOrder } from "./coupon-instance";

type Db = PrismaClient | Prisma.TransactionClient;

export const ORDER_PENDING_TTL_MS = 30 * 60 * 1000;

export async function releaseCouponForOrder(db: Db, orderId: string) {
  await releaseInstanceForOrder(db, orderId);

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

/** 履约时核销独立券；历史待支付单若只有旧 CouponRedemption 则补占。 */
export async function fulfillCouponOnPaidOrder(
  db: Db,
  order: { id: string; userId: string; couponId: string | null; couponInstanceId?: string | null },
) {
  const { redeemInstanceForOrder } = await import("./coupon-instance");
  const instance = await redeemInstanceForOrder(db, {
    orderId: order.id,
    userId: order.userId,
  });
  if (instance) return;

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
