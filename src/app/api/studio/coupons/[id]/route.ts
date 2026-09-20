import { NextResponse } from "next/server";
import { z } from "zod";
import { writeCouponAudit } from "@andyyyds/shared/coupon-audit";
import {
  campaignStats,
  resizeCampaignIssueCount,
  softDeleteCampaign,
} from "@andyyyds/shared/coupon-campaign";
import {
  campaignProductsInclude,
  serializeCampaign,
} from "@andyyyds/shared/coupon-campaign-serialize";
import { prisma } from "@andyyyds/shared/db";
import { logOrderError, orderErrorPayload } from "@andyyyds/shared/order-errors";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";
import { requireStudioUser, studioErrorResponse } from "@andyyyds/shared/studio";

type Ctx = { params: Promise<{ id: string }> };

async function loadOwnedCampaign(id: string, userId: string, role: string) {
  const campaign = await prisma.couponCampaign.findUnique({
    where: { id },
    include: campaignProductsInclude,
  });
  if (!campaign || campaign.deletedAt) {
    return { error: "优惠券活动不存在" as const, campaign: null };
  }
  if (!canViewAllStudioData(role) && campaign.createdById !== userId) {
    return { error: "无权操作该优惠券" as const, campaign: null };
  }
  return { error: null, campaign };
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const { id } = await ctx.params;
    const owned = await loadOwnedCampaign(id, session.id, session.role);
    if (!owned.campaign) {
      return NextResponse.json({ error: owned.error }, { status: 404 });
    }
    const stats = await campaignStats(prisma, id);
    await writeCouponAudit(prisma, {
      actorId: session.id,
      action: "VIEW_CAMPAIGN",
      campaignId: id,
    });
    return NextResponse.json({
      campaign: serializeCampaign(owned.campaign, stats || {}),
      stats,
    });
  } catch (error) {
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  issueCount: z.number().int().min(1).max(2000).optional(),
  maxUses: z.number().int().min(1).max(2000).optional(),
});

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const { id } = await ctx.params;
    const owned = await loadOwnedCampaign(id, session.id, session.role);
    if (!owned.campaign) {
      return NextResponse.json({ error: owned.error }, { status: 404 });
    }
    const body = patchSchema.parse(await req.json());
    const nextIssue = body.issueCount ?? body.maxUses;
    if (nextIssue !== undefined) {
      await resizeCampaignIssueCount(prisma, {
        campaignId: id,
        issueCount: nextIssue,
        actorId: session.id,
      });
    }
    const campaign = await prisma.couponCampaign.update({
      where: { id },
      data: {
        ...(body.name || body.title
          ? { name: (body.name || body.title || "").trim() }
          : {}),
        ...(body.description !== undefined
          ? { description: body.description.trim() }
          : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      include: campaignProductsInclude,
    });
    if (body.isActive === false) {
      await prisma.couponInstance.updateMany({
        where: { campaignId: id, status: "AVAILABLE" },
        data: {
          status: "DISABLED",
          disabledAt: new Date(),
          version: { increment: 1 },
        },
      });
    }
    const stats = await campaignStats(prisma, id);
    const serialized = serializeCampaign(campaign, stats || {});
    return NextResponse.json({ campaign: serialized, coupon: serialized, stats });
  } catch (error) {
    logOrderError("studio:coupons:patch", error);
    const mapped = orderErrorPayload(error);
    if (mapped.error !== "下单失败，请稍后重试") {
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const { id } = await ctx.params;
    const owned = await loadOwnedCampaign(id, session.id, session.role);
    if (!owned.campaign) {
      return NextResponse.json({ error: owned.error }, { status: 404 });
    }
    await softDeleteCampaign(prisma, { campaignId: id, actorId: session.id });
    return NextResponse.json({
      ok: true,
      deactivated: true,
      message: "已停用活动并保留领取/核销历史",
    });
  } catch (error) {
    logOrderError("studio:coupons:delete", error);
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
