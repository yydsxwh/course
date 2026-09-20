/**
 * GET/POST /api/studio/coupons —— 优惠券活动列表与创建（生成独立实例）
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { writeCouponAudit } from "@andyyyds/shared/coupon-audit";
import { createCouponCampaign } from "@andyyyds/shared/coupon-campaign";
import {
  campaignProductsInclude,
  serializeCampaign,
} from "@andyyyds/shared/coupon-campaign-serialize";
import { isCouponProductScope, isCouponType } from "@andyyyds/shared/coupons";
import { prisma } from "@andyyyds/shared/db";
import { logOrderError, orderErrorPayload } from "@andyyyds/shared/order-errors";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";
import { requireStudioUser, studioErrorResponse } from "@andyyyds/shared/studio";

export async function GET() {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const seeAll = canViewAllStudioData(session.role);
    const campaigns = await prisma.couponCampaign.findMany({
      where: {
        deletedAt: null,
        ...(seeAll ? {} : { createdById: session.id }),
      },
      include: campaignProductsInclude,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return NextResponse.json({
      campaigns: campaigns.map((c) => serializeCampaign(c)),
      coupons: campaigns.map((c) => serializeCampaign(c)),
    });
  } catch (error) {
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  type: z.string(),
  discountYuan: z.number().optional(),
  percentOff: z.number().int().optional(),
  minAmountYuan: z.number().optional(),
  issueCount: z.number().int().min(1).max(2000).optional(),
  maxUses: z.number().int().min(1).max(2000).optional(),
  maxPerUser: z.number().int().min(1).max(100).optional(),
  startsAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  claimStartsAt: z.string().nullable().optional(),
  claimEndsAt: z.string().nullable().optional(),
  productScope: z.string().optional(),
  productIds: z.array(z.string()).optional(),
});

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("DATE_INVALID");
  return d;
}

export async function POST(req: Request) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }

    const body = createSchema.parse(await req.json());
    if (!isCouponType(body.type)) {
      return NextResponse.json({ error: "优惠类型无效" }, { status: 400 });
    }
    const productScope = body.productScope || "ALL";
    if (!isCouponProductScope(productScope)) {
      return NextResponse.json({ error: "商品适用范围无效" }, { status: 400 });
    }
    const productIds = Array.from(
      new Set((body.productIds || []).map((id) => id.trim()).filter(Boolean)),
    );
    if (productScope === "SELECTED" && productIds.length > 0) {
      const seeAll = canViewAllStudioData(session.role);
      const ownedCount = await prisma.course.count({
        where: {
          id: { in: productIds },
          ...(seeAll ? {} : { teacherId: session.id }),
        },
      });
      if (ownedCount !== productIds.length) {
        return NextResponse.json(
          { error: "部分商品不存在或无权设置优惠券" },
          { status: 400 },
        );
      }
    }

    let startsAt: Date | null = null;
    let expiresAt: Date | null = null;
    let claimStartsAt: Date | null = null;
    let claimEndsAt: Date | null = null;
    try {
      startsAt = parseOptionalDate(body.startsAt);
      expiresAt = parseOptionalDate(body.expiresAt);
      claimStartsAt = parseOptionalDate(body.claimStartsAt) ?? startsAt;
      claimEndsAt = parseOptionalDate(body.claimEndsAt) ?? expiresAt;
    } catch {
      return NextResponse.json({ error: "有效期格式无效" }, { status: 400 });
    }

    const campaign = await createCouponCampaign(prisma, {
      name: (body.name || body.title || "").trim(),
      description: body.description,
      type: body.type,
      discountCents:
        body.type === "FIXED" ? Math.round((body.discountYuan ?? 0) * 100) : 0,
      percentOff: body.type === "PERCENT" ? (body.percentOff ?? 0) : 0,
      issueCount: body.issueCount ?? body.maxUses ?? 1,
      maxPerUser: body.maxPerUser,
      minAmount: Math.max(0, Math.round((body.minAmountYuan ?? 0) * 100)),
      productScope,
      productIds,
      startsAt,
      expiresAt,
      claimStartsAt,
      claimEndsAt,
      createdById: session.id,
    });

    const full = await prisma.couponCampaign.findUniqueOrThrow({
      where: { id: campaign.id },
      include: campaignProductsInclude,
    });
    await writeCouponAudit(prisma, {
      actorId: session.id,
      action: "CREATE_CAMPAIGN_API",
      campaignId: campaign.id,
    });
    const serialized = serializeCampaign(full);
    return NextResponse.json({ campaign: serialized, coupon: serialized });
  } catch (error) {
    logOrderError("studio:coupons:create", error);
    const mapped = orderErrorPayload(error);
    if (mapped.error !== "下单失败，请稍后重试") {
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
