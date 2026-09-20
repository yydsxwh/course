/**
 * GET /api/coupons/available?courseId= —— 当前用户对该课可用/不可用优惠券
 * 用于购买页点选；最终仍以 POST /api/orders 服务端校验为准。
 */

import { NextResponse } from "next/server";
import { getSession } from "@andyyyds/shared/auth";
import { listCouponsForBuyer } from "@andyyyds/shared/coupon-availability";
import { prisma } from "@andyyyds/shared/db";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const courseId = new URL(req.url).searchParams.get("courseId") || "";
  if (!courseId) {
    return NextResponse.json({ error: "缺少课程" }, { status: 400 });
  }

  const data = await listCouponsForBuyer(prisma, {
    userId: session.id,
    courseId,
  });
  return NextResponse.json(data);
}
