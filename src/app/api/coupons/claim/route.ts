import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@andyyyds/shared/auth";
import { claimInstanceByToken } from "@andyyyds/shared/coupon-instance";
import { allowRateLimit, clientIpFromRequest } from "@andyyyds/shared/coupon-rate-limit";
import { prisma } from "@andyyyds/shared/db";
import { logOrderError, orderErrorPayload } from "@andyyyds/shared/order-errors";

const schema = z.object({
  token: z.string().min(8).max(128),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  const ip = clientIpFromRequest(req);
  if (!allowRateLimit(`claim-post:${session.id}:${ip}`, 12, 60_000)) {
    return NextResponse.json({ error: "领取过于频繁，请稍后再试" }, { status: 429 });
  }
  try {
    const body = schema.parse(await req.json());
    const result = await claimInstanceByToken(prisma, {
      token: body.token,
      userId: session.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    logOrderError("coupons:claim", error);
    const { status, error: message } = orderErrorPayload(error);
    return NextResponse.json({ error: message }, { status });
  }
}
