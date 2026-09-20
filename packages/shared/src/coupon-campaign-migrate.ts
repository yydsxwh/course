/**
 * 将旧「公共券码 + 库存」Coupon 幂等迁移为 Campaign + Instance。
 * 不删除 Coupon / Order / CouponRedemption。
 */

import type { PrismaClient } from "@prisma/client";
import { encryptCouponToken, generateCouponToken, hashCouponToken, couponTokenHint } from "./coupon-token";

function padSerial(n: number) {
  return String(n).padStart(6, "0");
}

function campaignCodeFromLegacy(code: string, index: number) {
  const cleaned = code.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8) || "LEGACY";
  return `${cleaned}${index ? index : ""}`.slice(0, 16);
}

export async function migrateLegacyCoupons(db: PrismaClient) {
  const coupons = await db.coupon.findMany({
    include: {
      products: { select: { courseId: true } },
      redemptions: true,
    },
    orderBy: { createdAt: "asc" },
  });

  let campaigns = 0;
  let instances = 0;
  const notes: string[] = [];

  for (const [index, coupon] of coupons.entries()) {
    let campaign = await db.couponCampaign.findUnique({
      where: { legacyCouponId: coupon.id },
    });
    if (!campaign) {
      let code = campaignCodeFromLegacy(coupon.code, index);
      for (let i = 0; i < 8; i += 1) {
        const clash = await db.couponCampaign.findUnique({ where: { code } });
        if (!clash) break;
        code = `${campaignCodeFromLegacy(coupon.code, index)}${i + 1}`.slice(0, 16);
      }
      campaign = await db.couponCampaign.create({
        data: {
          code,
          name: coupon.title,
          description: `由旧券码 ${coupon.code} 迁移，公共链接已停用。`,
          type: coupon.type,
          discountCents: coupon.discountCents,
          percentOff: coupon.percentOff,
          issueCount: Math.max(1, coupon.maxUses),
          maxPerUser: Math.max(1, coupon.maxPerUser || 1),
          minAmount: coupon.minAmount,
          productScope: coupon.productScope || "ALL",
          startsAt: coupon.startsAt,
          expiresAt: coupon.expiresAt,
          claimStartsAt: coupon.startsAt,
          claimEndsAt: coupon.expiresAt,
          isActive: coupon.isActive,
          createdById: coupon.createdById,
          legacyCouponId: coupon.id,
          ...(coupon.productScope === "SELECTED"
            ? {
                products: {
                  create: coupon.products.map((p) => ({ courseId: p.courseId })),
                },
              }
            : {}),
        },
      });
      campaigns += 1;
    }

    const existing = await db.couponInstance.findMany({
      where: { campaignId: campaign.id },
      select: { id: true, legacyRedemptionId: true, status: true },
    });
    const mappedRedemptions = new Set(
      existing.map((row) => row.legacyRedemptionId).filter(Boolean) as string[],
    );

    const pendingOrders = await db.order.findMany({
      where: {
        couponId: coupon.id,
        status: "PENDING",
        couponInstanceId: null,
      },
      select: { id: true, userId: true, createdAt: true },
    });

    let seq = campaign.serialSeq;
    const toCreate: PrismaInstanceRow[] = [];

    for (const redemption of coupon.redemptions) {
      if (mappedRedemptions.has(redemption.id)) continue;
      seq += 1;
      const token = generateCouponToken();
      const order = redemption.orderId
        ? await db.order.findUnique({
            where: { id: redemption.orderId },
            select: { id: true, status: true },
          })
        : null;
      const reserved = order?.status === "PENDING";
      toCreate.push({
        campaignId: campaign.id,
        serialNo: `${campaign.code}-${padSerial(seq)}`,
        tokenHash: hashCouponToken(token),
        tokenEncrypted: encryptCouponToken(token),
        tokenHint: couponTokenHint(token),
        status: reserved ? "RESERVED" : "REDEEMED",
        claimedByUserId: redemption.userId,
        claimedAt: redemption.createdAt,
        redeemedByUserId: reserved ? null : redemption.userId,
        redeemedAt: reserved ? null : redemption.createdAt,
        redeemedOrderId: reserved ? null : redemption.orderId,
        reservedOrderId: reserved ? redemption.orderId : null,
        reservedAt: reserved ? redemption.createdAt : null,
        legacyCouponId: coupon.id,
        legacyRedemptionId: redemption.id,
      });
    }

    const usedUserOrder = new Set(
      coupon.redemptions.map((r) => `${r.userId}:${r.orderId || ""}`),
    );
    for (const order of pendingOrders) {
      if (usedUserOrder.has(`${order.userId}:${order.id}`)) continue;
      const already = existing.some((row) => row.status === "RESERVED");
      if (already) continue;
      seq += 1;
      const token = generateCouponToken();
      toCreate.push({
        campaignId: campaign.id,
        serialNo: `${campaign.code}-${padSerial(seq)}`,
        tokenHash: hashCouponToken(token),
        tokenEncrypted: encryptCouponToken(token),
        tokenHint: couponTokenHint(token),
        status: "RESERVED",
        claimedByUserId: order.userId,
        claimedAt: order.createdAt,
        redeemedByUserId: null,
        redeemedAt: null,
        redeemedOrderId: null,
        reservedOrderId: order.id,
        reservedAt: order.createdAt,
        legacyCouponId: coupon.id,
        legacyRedemptionId: null,
      });
    }

    const currentTotal = existing.length + toCreate.length;
    const remaining = Math.max(0, campaign.issueCount - currentTotal);
    for (let i = 0; i < remaining; i += 1) {
      seq += 1;
      const token = generateCouponToken();
      toCreate.push({
        campaignId: campaign.id,
        serialNo: `${campaign.code}-${padSerial(seq)}`,
        tokenHash: hashCouponToken(token),
        tokenEncrypted: encryptCouponToken(token),
        tokenHint: couponTokenHint(token),
        status: coupon.isActive ? "AVAILABLE" : "DISABLED",
        claimedByUserId: null,
        claimedAt: null,
        redeemedByUserId: null,
        redeemedAt: null,
        redeemedOrderId: null,
        reservedOrderId: null,
        reservedAt: null,
        legacyCouponId: coupon.id,
        legacyRedemptionId: null,
        disabledAt: coupon.isActive ? null : new Date(),
      });
    }

    if (toCreate.length > 0) {
      const chunk = 200;
      for (let i = 0; i < toCreate.length; i += chunk) {
        await db.couponInstance.createMany({
          data: toCreate.slice(i, i + chunk),
        });
      }
      instances += toCreate.length;
      await db.couponCampaign.update({
        where: { id: campaign.id },
        data: { serialSeq: seq },
      });
    }

    const attachOrders = await db.order.findMany({
      where: {
        couponId: coupon.id,
        couponInstanceId: null,
      },
      select: { id: true },
    });
    for (const order of attachOrders) {
      const inst = await db.couponInstance.findFirst({
        where: {
          campaignId: campaign.id,
          OR: [{ redeemedOrderId: order.id }, { reservedOrderId: order.id }],
        },
        select: { id: true },
      });
      if (inst) {
        await db.order.update({
          where: { id: order.id },
          data: { couponInstanceId: inst.id },
        });
      }
    }

    if (coupon.usedCount > coupon.redemptions.length) {
      notes.push(
        `旧券 ${coupon.code} 的 usedCount=${coupon.usedCount} 大于核销记录 ${coupon.redemptions.length}，多出的次数无法还原领取人，已按剩余库存生成未领取实例。`,
      );
    }
  }

  return { coupons: coupons.length, campaigns, instances, notes };
}

type PrismaInstanceRow = {
  campaignId: string;
  serialNo: string;
  tokenHash: string;
  tokenEncrypted: string;
  tokenHint: string;
  status: string;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  redeemedByUserId: string | null;
  redeemedAt: Date | null;
  redeemedOrderId: string | null;
  reservedOrderId: string | null;
  reservedAt: Date | null;
  legacyCouponId: string | null;
  legacyRedemptionId: string | null;
  disabledAt?: Date | null;
};
