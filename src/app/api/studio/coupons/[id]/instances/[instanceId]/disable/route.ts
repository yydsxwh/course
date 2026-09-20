import { NextResponse } from "next/server";
import { disableUnusedInstance } from "@andyyyds/shared/coupon-campaign";
import { prisma } from "@andyyyds/shared/db";
import { logOrderError, orderErrorPayload } from "@andyyyds/shared/order-errors";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";
import { requireStudioUser, studioErrorResponse } from "@andyyyds/shared/studio";

type Ctx = { params: Promise<{ id: string; instanceId: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const { id, instanceId } = await ctx.params;
    const instance = await prisma.couponInstance.findUnique({
      where: { id: instanceId },
      include: { campaign: { select: { createdById: true, deletedAt: true } } },
    });
    if (!instance || instance.campaignId !== id || instance.campaign.deletedAt) {
      return NextResponse.json({ error: "优惠券不存在" }, { status: 404 });
    }
    if (
      !canViewAllStudioData(session.role) &&
      instance.campaign.createdById !== session.id
    ) {
      return NextResponse.json({ error: "无权操作该优惠券" }, { status: 403 });
    }
    await disableUnusedInstance(prisma, { instanceId, actorId: session.id });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logOrderError("studio:coupon-disable", error);
    const mapped = orderErrorPayload(error);
    if (mapped.error !== "下单失败，请稍后重试") {
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
