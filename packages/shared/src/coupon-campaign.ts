/**
 * 优惠券活动：创建、调整发行量、统计、软删除。
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isCouponProductScope,
  isCouponType,
  validateCouponProductScopeInput,
  validateCouponValueInput,
} from "./coupons";
import { writeCouponAudit } from "./coupon-audit";
import {
  effectiveInstanceStatus,
  generateInstances,
  MAX_CAMPAIGN_ISSUE,
  type CampaignRule,
} from "./coupon-instance";
import { OrderBusinessError } from "./order-errors";

type Db = PrismaClient | Prisma.TransactionClient;

export type CreateCampaignInput = {
  name: string;
  description?: string;
  type: string;
  discountCents: number;
  percentOff: number;
  issueCount: number;
  maxPerUser?: number;
  minAmount?: number;
  productScope?: string;
  productIds?: string[];
  claimStartsAt?: Date | null;
  claimEndsAt?: Date | null;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  createdById: string;
  code?: string;
};

function randomCampaignCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `CPN${suffix}`;
}

export async function createCouponCampaign(
  db: PrismaClient,
  input: CreateCampaignInput,
) {
  if (!isCouponType(input.type)) {
    throw new OrderBusinessError("优惠类型无效");
  }
  const valueErr = validateCouponValueInput({
    type: input.type,
    discountCents: input.discountCents,
    percentOff: input.percentOff,
  });
  if (valueErr) throw new OrderBusinessError(valueErr);

  const issueCount = Math.floor(input.issueCount);
  if (!Number.isFinite(issueCount) || issueCount < 1) {
    throw new OrderBusinessError("发行数量至少为 1");
  }
  if (issueCount > MAX_CAMPAIGN_ISSUE) {
    throw new OrderBusinessError(`发行数量不能超过 ${MAX_CAMPAIGN_ISSUE}`);
  }

  const productScope = input.productScope || "ALL";
  if (!isCouponProductScope(productScope)) {
    throw new OrderBusinessError("商品适用范围无效");
  }
  const productIds = Array.from(
    new Set((input.productIds || []).map((id) => id.trim()).filter(Boolean)),
  );
  const scopeErr = validateCouponProductScopeInput({
    productScope,
    productIds,
  });
  if (scopeErr) throw new OrderBusinessError(scopeErr);

  const maxPerUser = Math.max(1, Math.floor(input.maxPerUser || 1));
  const minAmount = Math.max(0, Math.floor(input.minAmount || 0));
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new OrderBusinessError("请填写优惠券名称");
  }

  let code = (input.code || randomCampaignCode()).trim().toUpperCase();
  for (let i = 0; i < 6; i += 1) {
    const clash = await db.couponCampaign.findUnique({ where: { code } });
    if (!clash) break;
    code = randomCampaignCode();
  }

  const campaign = await db.$transaction(async (tx) => {
    const created = await tx.couponCampaign.create({
      data: {
        code,
        name,
        description: (input.description || "").trim().slice(0, 500),
        type: input.type,
        discountCents: input.discountCents,
        percentOff: input.percentOff,
        issueCount,
        maxPerUser,
        minAmount,
        productScope,
        claimStartsAt: input.claimStartsAt ?? null,
        claimEndsAt: input.claimEndsAt ?? null,
        startsAt: input.startsAt ?? null,
        expiresAt: input.expiresAt ?? null,
        createdById: input.createdById,
        ...(productScope === "SELECTED"
          ? { products: { create: productIds.map((courseId) => ({ courseId })) } }
          : {}),
      },
    });
    await generateInstances(tx, created, issueCount);
    await writeCouponAudit(tx, {
      actorId: input.createdById,
      action: "CREATE_CAMPAIGN",
      campaignId: created.id,
      detail: `issueCount=${issueCount}`,
    });
    return created;
  }, { timeout: 30000 });

  return campaign;
}

export async function resizeCampaignIssueCount(
  db: PrismaClient,
  input: { campaignId: string; issueCount: number; actorId: string },
) {
  const next = Math.floor(input.issueCount);
  if (!Number.isFinite(next) || next < 1) {
    throw new OrderBusinessError("发行数量至少为 1");
  }
  if (next > MAX_CAMPAIGN_ISSUE) {
    throw new OrderBusinessError(`发行数量不能超过 ${MAX_CAMPAIGN_ISSUE}`);
  }

  return db.$transaction(async (tx) => {
    const campaign = await tx.couponCampaign.findUnique({
      where: { id: input.campaignId },
    });
    if (!campaign || campaign.deletedAt) {
      throw new OrderBusinessError("优惠券活动不存在", { status: 404 });
    }
    const generated = await tx.couponInstance.count({
      where: { campaignId: campaign.id },
    });
    if (next > generated) {
      await generateInstances(tx, campaign, next - generated);
    } else if (next < generated) {
      const keepLocked = await tx.couponInstance.count({
        where: {
          campaignId: campaign.id,
          status: { in: ["CLAIMED", "RESERVED", "REDEEMED"] },
        },
      });
      if (next < keepLocked) {
        throw new OrderBusinessError(
          `已有 ${keepLocked} 张券被领取或核销，发行数量不能少于该数目`,
        );
      }
      const disableCount = generated - next;
      const unused = await tx.couponInstance.findMany({
        where: { campaignId: campaign.id, status: "AVAILABLE" },
        orderBy: { serialNo: "desc" },
        take: disableCount,
        select: { id: true },
      });
      if (unused.length < disableCount) {
        throw new OrderBusinessError("可停用的未领取券不足，无法减少发行量");
      }
      await tx.couponInstance.updateMany({
        where: { id: { in: unused.map((row) => row.id) }, status: "AVAILABLE" },
        data: {
          status: "DISABLED",
          disabledAt: new Date(),
          version: { increment: 1 },
        },
      });
    }
    const updated = await tx.couponCampaign.update({
      where: { id: campaign.id },
      data: { issueCount: next },
    });
    await writeCouponAudit(tx, {
      actorId: input.actorId,
      action: "CHANGE_ISSUE_COUNT",
      campaignId: campaign.id,
      detail: `${campaign.issueCount}->${next}`,
    });
    return updated;
  }, { timeout: 30000 });
}

export async function disableUnusedInstance(
  db: Db,
  input: { instanceId: string; actorId: string },
) {
  const row = await db.couponInstance.findUnique({
    where: { id: input.instanceId },
  });
  if (!row) throw new OrderBusinessError("优惠券不存在", { status: 404 });
  if (row.status !== "AVAILABLE") {
    throw new OrderBusinessError("只能停用尚未领取的优惠券");
  }
  await db.couponInstance.updateMany({
    where: { id: row.id, status: "AVAILABLE" },
    data: {
      status: "DISABLED",
      disabledAt: new Date(),
      version: { increment: 1 },
    },
  });
  await writeCouponAudit(db, {
    actorId: input.actorId,
    action: "DISABLE_INSTANCE",
    campaignId: row.campaignId,
    instanceId: row.id,
    detail: row.serialNo,
  });
}

export async function softDeleteCampaign(
  db: PrismaClient,
  input: { campaignId: string; actorId: string },
) {
  const campaign = await db.couponCampaign.findUnique({
    where: { id: input.campaignId },
  });
  if (!campaign) throw new OrderBusinessError("优惠券活动不存在", { status: 404 });
  await db.$transaction(async (tx) => {
    await tx.couponCampaign.update({
      where: { id: campaign.id },
      data: { isActive: false, deletedAt: campaign.deletedAt || new Date() },
    });
    await tx.couponInstance.updateMany({
      where: { campaignId: campaign.id, status: "AVAILABLE" },
      data: {
        status: "DISABLED",
        disabledAt: new Date(),
        version: { increment: 1 },
      },
    });
    await writeCouponAudit(tx, {
      actorId: input.actorId,
      action: "SOFT_DELETE_CAMPAIGN",
      campaignId: campaign.id,
    });
  });
}

export async function campaignStats(
  db: Db,
  campaignId: string,
  now = new Date(),
) {
  const campaign = await db.couponCampaign.findUnique({
    where: { id: campaignId },
    include: { products: { select: { courseId: true } } },
  });
  if (!campaign) return null;
  const rows = await db.couponInstance.findMany({
    where: { campaignId },
    select: { status: true },
  });
  const rule: CampaignRule = {
    id: campaign.id,
    code: campaign.code,
    name: campaign.name,
    description: campaign.description,
    type: campaign.type,
    discountCents: campaign.discountCents,
    percentOff: campaign.percentOff,
    minAmount: campaign.minAmount,
    maxPerUser: campaign.maxPerUser,
    productScope: campaign.productScope,
    productIds: campaign.products.map((p) => p.courseId),
    claimStartsAt: campaign.claimStartsAt,
    claimEndsAt: campaign.claimEndsAt,
    startsAt: campaign.startsAt,
    expiresAt: campaign.expiresAt,
    isActive: campaign.isActive,
    deletedAt: campaign.deletedAt,
  };
  const counts = {
    generated: rows.length,
    available: 0,
    claimed: 0,
    reserved: 0,
    redeemed: 0,
    expired: 0,
    disabled: 0,
  };
  for (const row of rows) {
    const status = effectiveInstanceStatus(row.status, rule, now);
    if (status === "AVAILABLE") counts.available += 1;
    else if (status === "CLAIMED") counts.claimed += 1;
    else if (status === "RESERVED") counts.reserved += 1;
    else if (status === "REDEEMED") counts.redeemed += 1;
    else if (status === "EXPIRED") counts.expired += 1;
    else counts.disabled += 1;
  }
  return {
    campaign,
    issueCount: campaign.issueCount,
    ...counts,
    claimedUnused: counts.claimed + counts.reserved,
  };
}
