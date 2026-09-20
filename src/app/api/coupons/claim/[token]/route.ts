import { NextResponse } from "next/server";
import { previewInstanceByToken } from "@andyyyds/shared/coupon-instance";
import { allowRateLimit, clientIpFromRequest } from "@andyyyds/shared/coupon-rate-limit";
import { getSession } from "@andyyyds/shared/auth";
import { prisma } from "@andyyyds/shared/db";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const ip = clientIpFromRequest(req);
  if (!allowRateLimit(`claim-get:${ip}`, 40, 60_000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { token } = await ctx.params;
  const session = await getSession();
  const preview = await previewInstanceByToken(prisma, token, session?.id);
  if ("error" in preview && preview.error && !("campaign" in preview)) {
    return NextResponse.json({ error: preview.error }, { status: preview.status || 404 });
  }
  return NextResponse.json(preview);
}
