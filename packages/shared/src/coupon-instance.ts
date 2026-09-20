/**
 * 独立优惠券实例：生成、领取、预占、核销、释放。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { calcCouponDiscount, couponAppliesToProduct } from "./coupons";
import { OrderBusinessError } from "./order-errors";
import {
  couponClaimAbsoluteUrl,
  couponTokenHint,
  decryptCouponToken,
  encryptCouponToken,
  generateCouponToken,
  hashCouponToken,
} from "./coupon-token";

type Db = PrismaClient | Prisma.TransactionClient;

export const COUPON_INSTANCE_STATUS = [
  "AVAILABLE",
  "CLAIMED",
  "RESERVED",
  "REDEEMED",
  "EXPIRED",
  "DISABLED",
] as const;
export type CouponInstanceStatus = (typeof COUPON_INSTANCE_STATUS)[number];

export const MAX_CAMPAIGN_ISSUE = 2000;

export type CampaignRule = {
  id: string;
  code: string;
  name: string;
  description: string;
  type: string;
  discountCents: number;
  percentOff: number;
  minAmount: number;
  maxPerUser: number;
  productScope: string;
  productIds: string[];
  claimStartsAt: Date | null;
  claimEndsAt: Date | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  deletedAt: Date | null;
};

export function campaignToDiscountInput(campaign: CampaignRule) {
  return {
    type: campaign.type,
    discountCents: campaign.discountCents,
    percentOff: campaign.percentOff,
    minAmount: campaign.minAmount,
    maxUses: Number.MAX_SAFE_INTEGER,
    usedCount: 0,
    isActive: campaign.isActive && !campaign.deletedAt,
    startsAt: campaign.startsAt,
    expiresAt: campaign.expiresAt,
    productScope: campaign.productScope,
    productIds: campaign.productIds,
  };
}

export function isCampaignClaimOpen(campaign: CampaignRule, now: Date): string | null {
  if (campaign.deletedAt) return "优惠券活动已删除";
  if (!campaign.isActive) return "优惠券活动已停用";
  const claimStart = campaign.claimStartsAt || campaign.startsAt;
  const claimEnd = campaign.claimEndsAt || campaign.expiresAt;
  if (claimStart && claimStart > now) return "尚未开始领取";
  if (claimEnd && claimEnd < now) return "领取已结束";
  return null;
}

export function isCampaignUsable(campaign: CampaignRule, now: Date, courseId?: string): string | null {
  if (campaign.deletedAt) return "优惠券活动已删除";
  if (!campaign.isActive) return "优惠券活动已停用";
  if (campaign.startsAt && campaign.startsAt > now) return "优惠券尚未开始";
  if (campaign.expiresAt && campaign.expiresAt < now) return "优惠券已过期";
  if (courseId && !couponAppliesToProduct(campaign, courseId)) {
    return "该优惠券不适用于当前商品";
  }
  return null;
}

export function effectiveInstanceStatus(
  status: string,
  campaign: Pick<CampaignRule, "expiresAt">,
  now: Date,
): CouponInstanceStatus {
  if (status === "DISABLED" || status === "REDEEMED") {
    return status;
  }
  if (campaign.expiresAt && campaign.expiresAt < now) {
    return "EXPIRED";
  }
  if (
    status === "AVAILABLE" ||
    status === "CLAIMED" ||
    status === "RESERVED" ||
    status === "EXPIRED"
  ) {
    return status;
  }
  return "DISABLED";
}

function padSerial(n: number) {
  return String(n).padStart(6, "0");
}

export function makeInstancePayloads(
  campaign: { id: string; code: string; serialSeq: number },
  count: number,
) {
  const rows: Array<{
    campaignId: string;
    serialNo: string;
    tokenHash: string;
    tokenEncrypted: string;
    tokenHint: string;
    status: string;
  }> = [];
  const tokens: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const token = generateCouponToken();
    tokens.push(token);
    rows.push({
      campaignId: campaign.id,
      serialNo: `${campaign.code}-${padSerial(campaign.serialSeq + i)}`,
      tokenHash: hashCouponToken(token),
      tokenEncrypted: encryptCouponToken(token),
      tokenHint: couponTokenHint(token),
      status: "AVAILABLE",
    });
  }
  return { rows, tokens, nextSeq: campaign.serialSeq + count };
}

export async function generateInstances(
  db: Db,
  campaign: { id: string; code: string; serialSeq: number },
  count: number,
) {
  if (count <= 0) return { created: 0, tokens: [] as string[] };
  if (count > MAX_CAMPAIGN_ISSUE) {
    throw new OrderBusinessError(`单次最多生成 ${MAX_CAMPAIGN_ISSUE} 张`);
  }
  const { rows, tokens, nextSeq } = makeInstancePayloads(campaign, count);
  await db.couponInstance.createMany({ data: rows });
  await db.couponCampaign.update({
    where: { id: campaign.id },
    data: { serialSeq: nextSeq },
  });
  return { created: rows.length, tokens };
}

export async function loadCampaignRule(
  db: Db,
  campaignId: string,
): Promise<CampaignRule | null> {
  const row = await db.couponCampaign.findUnique({
    where: { id: campaignId },
    include: { products: { select: { courseId: true } } },
  });
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    type: row.type,
    discountCents: row.discountCents,
    percentOff: row.percentOff,
    minAmount: row.minAmount,
    maxPerUser: row.maxPerUser,
    productScope: row.productScope,
    productIds: row.products.map((p) => p.courseId),
    claimStartsAt: row.claimStartsAt,
    claimEndsAt: row.claimEndsAt,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    isActive: row.isActive,
    deletedAt: row.deletedAt,
  };
}

export async function findInstanceByToken(db: Db, token: string) {
  const tokenHash = hashCouponToken(token.trim());
  return db.couponInstance.findUnique({
    where: { tokenHash },
    include: {
      campaign: { include: { products: { select: { courseId: true } } } },
    },
  });
}

export async function previewInstanceByToken(db: Db, token: string, viewerId?: string) {
  const row = await findInstanceByToken(db, token);
  if (!row) return { error: "优惠券不存在", status: 404 as const };
  const campaign: CampaignRule = {
    id: row.campaign.id,
    code: row.campaign.code,
    name: row.campaign.name,
    description: row.campaign.description,
    type: row.campaign.type,
    discountCents: row.campaign.discountCents,
    percentOff: row.campaign.percentOff,
    minAmount: row.campaign.minAmount,
    maxPerUser: row.campaign.maxPerUser,
    productScope: row.campaign.productScope,
    productIds: row.campaign.products.map((p) => p.courseId),
    claimStartsAt: row.campaign.claimStartsAt,
    claimEndsAt: row.campaign.claimEndsAt,
    startsAt: row.campaign.startsAt,
    expiresAt: row.campaign.expiresAt,
    isActive: row.campaign.isActive,
    deletedAt: row.campaign.deletedAt,
  };
  const now = new Date();
  const effective = effectiveInstanceStatus(row.status, campaign, now);
  const mine = Boolean(viewerId && row.claimedByUserId === viewerId);
  let claimState: "open" | "mine" | "taken" | "blocked" = "open";
  let message = "";
  if (effective === "DISABLED") {
    claimState = "blocked";
    message = "该优惠券已停用";
  } else if (effective === "EXPIRED") {
    claimState = "blocked";
    message = "优惠券已过期";
  } else if (effective === "REDEEMED") {
    claimState = mine ? "mine" : "taken";
    message = mine ? "你已领取并使用" : "该优惠券已被领取";
  } else if (effective === "CLAIMED" || effective === "RESERVED") {
    claimState = mine ? "mine" : "taken";
    message = mine ? "你已领取" : "该优惠券已被领取";
  } else {
    const closed = isCampaignClaimOpen(campaign, now);
    if (closed) {
      claimState = "blocked";
      message = closed;
    }
  }
  return {
    instanceId: row.id,
    serialNo: row.serialNo,
    tokenHint: row.tokenHint,
    status: effective,
    claimState,
    message,
    alreadyClaimedByMe: mine,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      type: campaign.type,
      discountCents: campaign.discountCents,
      percentOff: campaign.percentOff,
      minAmount: campaign.minAmount,
      productScope: campaign.productScope,
      productIds: campaign.productIds,
      claimStartsAt: campaign.claimStartsAt?.toISOString() ?? null,
      claimEndsAt: campaign.claimEndsAt?.toISOString() ?? null,
      startsAt: campaign.startsAt?.toISOString() ?? null,
      expiresAt: campaign.expiresAt?.toISOString() ?? null,
    },
  };
}

export async function claimInstanceByToken(
  db: PrismaClient,
  input: { token: string; userId: string; now?: Date },
) {
  const now = input.now || new Date();
  const token = input.token.trim();
  if (!token) throw new OrderBusinessError("领取链接无效");

  return db.$transaction(async (tx) => {
    const row = await findInstanceByToken(tx, token);
    if (!row) throw new OrderBusinessError("优惠券不存在", { status: 404 });

    const campaign: CampaignRule = {
      id: row.campaign.id,
      code: row.campaign.code,
      name: row.campaign.name,
      description: row.campaign.description,
      type: row.campaign.type,
      discountCents: row.campaign.discountCents,
      percentOff: row.campaign.percentOff,
      minAmount: row.campaign.minAmount,
      maxPerUser: row.campaign.maxPerUser,
      productScope: row.campaign.productScope,
      productIds: row.campaign.products.map((p) => p.courseId),
      claimStartsAt: row.campaign.claimStartsAt,
      claimEndsAt: row.campaign.claimEndsAt,
      startsAt: row.campaign.startsAt,
      expiresAt: row.campaign.expiresAt,
      isActive: row.campaign.isActive,
      deletedAt: row.campaign.deletedAt,
    };

    if (row.claimedByUserId === input.userId) {
      return { ok: true as const, already: true, instanceId: row.id, campaignId: campaign.id };
    }
    if (row.status !== "AVAILABLE") {
      throw new OrderBusinessError("该优惠券已被领取");
    }
    const closed = isCampaignClaimOpen(campaign, now);
    if (closed) throw new OrderBusinessError(closed);
    if (campaign.expiresAt && campaign.expiresAt < now) {
      throw new OrderBusinessError("优惠券已过期");
    }

    const usedByUser = await tx.couponInstance.count({
      where: {
        campaignId: campaign.id,
        claimedByUserId: input.userId,
        status: { in: ["CLAIMED", "RESERVED", "REDEEMED"] },
      },
    });
    if (usedByUser >= Math.max(1, campaign.maxPerUser)) {
      throw new OrderBusinessError("已达到领取上限");
    }

    const updated = await tx.couponInstance.updateMany({
      where: { id: row.id, status: "AVAILABLE", claimedByUserId: null },
      data: {
        status: "CLAIMED",
        claimedByUserId: input.userId,
        claimedAt: now,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw new OrderBusinessError("该优惠券已被领取");
    }
    return { ok: true as const, already: false, instanceId: row.id, campaignId: campaign.id };
  });
}

export async function reserveInstanceInTx(
  db: Db,
  input: {
    instanceId: string;
    userId: string;
    orderId: string;
    priceCents: number;
    courseId: string;
    now?: Date;
  },
) {
  const now = input.now || new Date();
  const row = await db.couponInstance.findUnique({
    where: { id: input.instanceId },
    include: { campaign: { include: { products: { select: { courseId: true } } } } },
  });
  if (!row) throw new OrderBusinessError("优惠券不存在");
  const campaign: CampaignRule = {
    id: row.campaign.id,
    code: row.campaign.code,
    name: row.campaign.name,
    description: row.campaign.description,
    type: row.campaign.type,
    discountCents: row.campaign.discountCents,
    percentOff: row.campaign.percentOff,
    minAmount: row.campaign.minAmount,
    maxPerUser: row.campaign.maxPerUser,
    productScope: row.campaign.productScope,
    productIds: row.campaign.products.map((p) => p.courseId),
    claimStartsAt: row.campaign.claimStartsAt,
    claimEndsAt: row.campaign.claimEndsAt,
    startsAt: row.campaign.startsAt,
    expiresAt: row.campaign.expiresAt,
    isActive: row.campaign.isActive,
    deletedAt: row.campaign.deletedAt,
  };
  if (row.claimedByUserId !== input.userId) {
    throw new OrderBusinessError("不能使用他人的优惠券");
  }
  if (row.status === "REDEEMED") {
    throw new OrderBusinessError("该优惠券已使用过");
  }
  if (row.status === "DISABLED") {
    throw new OrderBusinessError("优惠券已停用");
  }
  if (row.status === "RESERVED" && row.reservedOrderId && row.reservedOrderId !== input.orderId) {
    throw new OrderBusinessError("该优惠券正在其他订单中使用");
  }
  if (row.status !== "CLAIMED" && row.status !== "RESERVED") {
    throw new OrderBusinessError("请先领取优惠券");
  }
  const usable = isCampaignUsable(campaign, now, input.courseId);
  if (usable) throw new OrderBusinessError(usable);
  if (input.priceCents < campaign.minAmount) {
    throw new OrderBusinessError(
      campaign.minAmount > 0
        ? `未满最低消费 ¥${(campaign.minAmount / 100).toFixed(campaign.minAmount % 100 === 0 ? 0 : 2)}`
        : "优惠券不可用",
    );
  }

  const reserved = await db.couponInstance.updateMany({
    where: {
      id: row.id,
      claimedByUserId: input.userId,
      status: { in: ["CLAIMED", "RESERVED"] },
      OR: [{ reservedOrderId: null }, { reservedOrderId: input.orderId }],
    },
    data: {
      status: "RESERVED",
      reservedOrderId: input.orderId,
      reservedAt: now,
      version: { increment: 1 },
    },
  });
  if (reserved.count === 0) {
    throw new OrderBusinessError("优惠券占用失败，请重试");
  }
  return {
    campaign,
    discount: calcCouponDiscount(input.priceCents, campaignToDiscountInput(campaign)),
  };
}

export async function redeemInstanceForOrder(
  db: Db,
  input: { orderId: string; userId: string; now?: Date },
) {
  const now = input.now || new Date();
  const reserved = await db.couponInstance.findFirst({
    where: { reservedOrderId: input.orderId },
  });
  const already = await db.couponInstance.findFirst({
    where: { redeemedOrderId: input.orderId },
  });
  if (already) return already;
  if (!reserved) return null;
  if (reserved.claimedByUserId !== input.userId) {
    throw new OrderBusinessError("不能核销他人的优惠券");
  }
  const updated = await db.couponInstance.updateMany({
    where: {
      id: reserved.id,
      status: "RESERVED",
      reservedOrderId: input.orderId,
    },
    data: {
      status: "REDEEMED",
      redeemedByUserId: input.userId,
      redeemedAt: now,
      redeemedOrderId: input.orderId,
      reservedOrderId: null,
      reservedAt: null,
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) {
    return db.couponInstance.findFirst({ where: { redeemedOrderId: input.orderId } });
  }
  return db.couponInstance.findUnique({ where: { id: reserved.id } });
}

export async function releaseInstanceForOrder(db: Db, orderId: string) {
  await db.couponInstance.updateMany({
    where: { reservedOrderId: orderId, status: "RESERVED" },
    data: {
      status: "CLAIMED",
      reservedOrderId: null,
      reservedAt: null,
      version: { increment: 1 },
    },
  });
}

export async function decryptInstanceLink(
  db: Db,
  instanceId: string,
  baseUrl: string,
) {
  const row = await db.couponInstance.findUnique({
    where: { id: instanceId },
    select: { tokenEncrypted: true },
  });
  if (!row) throw new OrderBusinessError("优惠券不存在", { status: 404 });
  const token = decryptCouponToken(row.tokenEncrypted);
  return couponClaimAbsoluteUrl(token, baseUrl);
}

export async function exportCampaignLinks(
  db: Db,
  campaignId: string,
  baseUrl: string,
) {
  const rows = await db.couponInstance.findMany({
    where: { campaignId },
    orderBy: { serialNo: "asc" },
    select: {
      id: true,
      serialNo: true,
      status: true,
      tokenEncrypted: true,
      claimedByUserId: true,
      claimedAt: true,
      redeemedOrderId: true,
      redeemedAt: true,
    },
  });
  return rows.map((row) => {
    const token = decryptCouponToken(row.tokenEncrypted);
    return {
      id: row.id,
      serialNo: row.serialNo,
      status: row.status,
      url: couponClaimAbsoluteUrl(token, baseUrl),
      claimedByUserId: row.claimedByUserId,
      claimedAt: row.claimedAt,
      redeemedOrderId: row.redeemedOrderId,
      redeemedAt: row.redeemedAt,
    };
  });
}

export function campaignCsv(rows: Array<{
  serialNo: string;
  url: string;
  status: string;
  claimedByUserId: string | null;
  claimedAt: Date | null;
  redeemedOrderId: string | null;
  redeemedAt: Date | null;
}>) {
  const header = [
    "serialNo",
    "claimUrl",
    "status",
    "claimedByUserId",
    "claimedAt",
    "redeemedOrderId",
    "redeemedAt",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.serialNo,
        row.url,
        row.status,
        row.claimedByUserId || "",
        row.claimedAt?.toISOString() || "",
        row.redeemedOrderId || "",
        row.redeemedAt?.toISOString() || "",
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
