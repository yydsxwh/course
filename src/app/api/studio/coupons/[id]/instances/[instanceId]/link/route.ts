import { NextResponse } from "next/server";
import { writeCouponAudit } from "@andyyyds/shared/coupon-audit";
import { decryptInstanceLink } from "@andyyyds/shared/coupon-instance";
import { allowRateLimit, clientIpFromRequest } from "@andyyyds/shared/coupon-rate-limit";
import { prisma } from "@andyyyds/shared/db";
import { logOrderError, orderErrorPayload } from "@andyyyds/shared/order-errors";
import { getPublicSiteUrl } from "@andyyyds/shared/payments";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";
import { requireStudioUser, studioErrorResponse } from "@andyyyds/shared/studio";

type Ctx = { params: Promise<{ id: string; instanceId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const ip = clientIpFromRequest(req);
    if (!allowRateLimit(`copy-link:${session.id}:${ip}`, 40, 60_000)) {
      return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
    }
    const { id, instanceId } = await ctx.params;
    const instance = await prisma.couponInstance.findUnique({
      where: { id: instanceId },
      include: { campaign: { select: { id: true, createdById: true, deletedAt: true } } },
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
    const base = await getPublicSiteUrl();
    const url = await decryptInstanceLink(prisma, instanceId, base);
    await writeCouponAudit(prisma, {
      actorId: session.id,
      action: "COPY_LINK",
      campaignId: id,
      instanceId,
      detail: instance.serialNo,
    });
    return NextResponse.json({ url, serialNo: instance.serialNo });
  } catch (error) {
    logOrderError("studio:coupon-link", error);
    const mapped = orderErrorPayload(error);
    if (mapped.error !== "下单失败，请稍后重试") {
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
