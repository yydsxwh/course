import { NextResponse } from "next/server";
import { getSession } from "@andyyyds/shared/auth";
import { listMyCouponInstances } from "@andyyyds/shared/coupon-availability";
import { prisma } from "@andyyyds/shared/db";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  const coupons = await listMyCouponInstances(prisma, session.id);
  return NextResponse.json({ coupons });
}
