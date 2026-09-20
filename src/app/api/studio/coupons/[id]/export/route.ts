import { NextResponse } from "next/server";
import { writeCouponAudit } from "@andyyyds/shared/coupon-audit";
import { campaignCsv, exportCampaignLinks } from "@andyyyds/shared/coupon-instance";
import { allowRateLimit, clientIpFromRequest } from "@andyyyds/shared/coupon-rate-limit";
import { prisma } from "@andyyyds/shared/db";
import { getPublicSiteUrl } from "@andyyyds/shared/payments";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";
import { requireStudioUser, studioErrorResponse } from "@andyyyds/shared/studio";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const ip = clientIpFromRequest(req);
    if (!allowRateLimit(`export:${session.id}:${ip}`, 8, 60_000)) {
      return NextResponse.json({ error: "导出过于频繁，请稍后再试" }, { status: 429 });
    }
    const { id } = await ctx.params;
    const campaign = await prisma.couponCampaign.findUnique({ where: { id } });
    if (!campaign || campaign.deletedAt) {
      return NextResponse.json({ error: "优惠券活动不存在" }, { status: 404 });
    }
    if (!canViewAllStudioData(session.role) && campaign.createdById !== session.id) {
      return NextResponse.json({ error: "无权操作该优惠券" }, { status: 403 });
    }
    const base = await getPublicSiteUrl();
    const rows = await exportCampaignLinks(prisma, id, base);
    await writeCouponAudit(prisma, {
      actorId: session.id,
      action: "EXPORT_LINKS",
      campaignId: id,
      detail: `count=${rows.length}`,
    });
    const csv = campaignCsv(rows);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${campaign.code}-coupons.csv"`,
      },
    });
  } catch (error) {
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
