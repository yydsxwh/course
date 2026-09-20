/**
 * POST /api/orders —— 创建订单并可选叠加优惠券。
 * 买家只认当前会话用户；价格/优惠全部服务端重算。
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@andyyyds/shared/auth";
import { createProductOrder } from "@andyyyds/shared/create-order";
import { prisma } from "@andyyyds/shared/db";
import { logOrderError, orderErrorPayload } from "@andyyyds/shared/order-errors";
import { getOrderFormConfig } from "@andyyyds/shared/site-settings";

const schema = z.object({
  courseId: z.string().min(1),
  couponInstanceId: z.string().optional(),
  couponCode: z.string().optional(),
  couponId: z.string().optional(),
  formAnswers: z.record(z.string(), z.string()).optional(),
  quantity: z.number().int().min(1).max(99).optional(),
  specSelected: z.record(z.string(), z.string()).optional(),
  specLabel: z.string().max(200).optional(),
  referralCode: z.string().max(32).optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  try {
    const raw = (await req.json()) as Record<string, unknown>;
    const body = schema.parse(raw);
    const orderForm = await getOrderFormConfig();
    const result = await createProductOrder(
      prisma,
      {
        userId: session.id,
        courseId: body.courseId,
        couponInstanceId: body.couponInstanceId,
        formAnswers: body.formAnswers,
        quantity: body.quantity,
        specSelected: body.specSelected,
        specLabel: body.specLabel,
        referralCode: body.referralCode,
        orderForm,
      },
      raw,
    );
    return NextResponse.json(result);
  } catch (error) {
    logOrderError("orders:create", error);
    const { status, error: message } = orderErrorPayload(error);
    return NextResponse.json({ error: message }, { status });
  }
}
