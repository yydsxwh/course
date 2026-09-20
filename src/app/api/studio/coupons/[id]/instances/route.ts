import { NextResponse } from "next/server";
import { maskEmail, maskName, maskPhone } from "@andyyyds/shared/coupon-privacy";
import { prisma } from "@andyyyds/shared/db";
import { canManageCoupons, canViewAllStudioData } from "@andyyyds/shared/roles";
import { requireStudioUser, studioErrorResponse } from "@andyyyds/shared/studio";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const session = await requireStudioUser();
    if (!canManageCoupons(session.role)) {
      return NextResponse.json({ error: "无权管理优惠券" }, { status: 403 });
    }
    const { id } = await ctx.params;
    const campaign = await prisma.couponCampaign.findUnique({
      where: { id },
    });
    if (!campaign || campaign.deletedAt) {
      return NextResponse.json({ error: "优惠券活动不存在" }, { status: 404 });
    }
    if (!canViewAllStudioData(session.role) && campaign.createdById !== session.id) {
      return NextResponse.json({ error: "无权操作该优惠券" }, { status: 403 });
    }

    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "";
    const userQ = (url.searchParams.get("user") || "").trim();
    const orderQ = (url.searchParams.get("order") || "").trim();
    const take = Math.min(200, Math.max(1, Number(url.searchParams.get("take") || 50)));
    const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));

    const where = {
      campaignId: id,
      ...(status ? { status } : {}),
      ...(userQ
        ? {
            claimedBy: {
              OR: [
                { id: userQ },
                { name: { contains: userQ } },
                { email: { contains: userQ } },
                { phone: { contains: userQ } },
              ],
            },
          }
        : {}),
      ...(orderQ
        ? {
            OR: [
              { redeemedOrderId: orderQ },
              { reservedOrderId: orderQ },
              { orders: { some: { orderNo: { contains: orderQ } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.couponInstance.count({ where }),
      prisma.couponInstance.findMany({
        where,
        include: {
          claimedBy: { select: { id: true, name: true, email: true, phone: true } },
          orders: { select: { id: true, orderNo: true, status: true, courseId: true }, take: 3 },
        },
        orderBy: { serialNo: "asc" },
        skip,
        take,
      }),
    ]);

    return NextResponse.json({
      total,
      instances: rows.map((row) => ({
        id: row.id,
        serialNo: row.serialNo,
        tokenHint: row.tokenHint,
        status: row.status,
        claimedByUserId: row.claimedByUserId,
        claimedBy: row.claimedBy
          ? {
              id: row.claimedBy.id,
              name: maskName(row.claimedBy.name),
              email: maskEmail(row.claimedBy.email),
              phone: maskPhone(row.claimedBy.phone),
            }
          : null,
        claimedAt: row.claimedAt?.toISOString() ?? null,
        redeemedByUserId: row.redeemedByUserId,
        redeemedAt: row.redeemedAt?.toISOString() ?? null,
        redeemedOrderId: row.redeemedOrderId,
        reservedOrderId: row.reservedOrderId,
        orders: row.orders,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    const { status, error: message } = studioErrorResponse(error);
    return NextResponse.json({ error: message }, { status });
  }
}
