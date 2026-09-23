/**
 * 创建课程/资料订单。
 * 买家身份只认调用方传入的会话 userId；价格与优惠全部服务端重算。
 */

import type { PrismaClient } from "@prisma/client";
import {
  grantProductAccess,
  notifyCourseAccessGroups,
} from "@andyyyds/courses/lib/course-bundle";
import { calcCouponDiscount } from "./coupons";
import {
  cancelPendingOrder,
  expireStalePendingOrders,
} from "./coupon-reservation";
import {
  campaignToDiscountInput,
  loadCampaignRule,
  redeemInstanceForOrder,
  reserveInstanceInTx,
} from "./coupon-instance";
import { fromMeetupPeopleDb, MEETUP_PRODUCT_TYPE } from "@andyyyds/meetup/lib/meetup";
import { sumMeetupPartySize } from "@andyyyds/meetup/lib/meetup-service-contact";
import {
  DEFAULT_ORDER_FORM,
  stringifyStoredAnswers,
  validateOrderFormAnswers,
  type OrderFormAnswers,
  type OrderFormConfig,
} from "./order-form";
import { OrderBusinessError } from "./order-errors";
import { isMathcodeProductType } from "./product-types";
import { buildSpecLabel, parseSpecs, SHOP_PRODUCT_TYPE } from "./shop";
import { makeOrderNo } from "./utils";

type Db = PrismaClient;

export type CreateProductOrderInput = {
  /** 当前登录用户稳定 ID，禁止用前端传来的 userId 覆盖 */
  userId: string;
  courseId: string;
  couponInstanceId?: string;
  couponCode?: string;
  couponId?: string;
  formAnswers?: OrderFormAnswers;
  quantity?: number;
  specSelected?: Record<string, string>;
  specLabel?: string;
  referralCode?: string;
  orderForm?: OrderFormConfig;
  now?: Date;
  skipChat?: boolean;
};

export type CreateProductOrderResult =
  | {
      enrolled: true;
      zeroPay?: boolean;
      slug: string;
      productType: string;
      orderId?: string;
      amount?: number;
      discount?: number;
    }
  | {
      enrolled?: false;
      orderId: string;
      amount: number;
      discount: number;
      productType: string;
    };

type OrderIntent = {
  userId: string;
  courseId: string;
  quantity: number;
  specLabel: string;
  couponInstanceId: string;
  linePrice: number;
  discount: number;
  amount: number;
  formAnswersJson: string;
};

const INTERNAL_PAY_MARKS = new Set(["", "FREE", "COUPON", "TIMEOUT", "USER", "SUPERSEDED"]);

/** 应付大于 0 且仍待支付时，才允许调微信/支付宝。0 元单必须在此之前被拦住。 */
export function orderRequiresExternalPayment(order: {
  status: string;
  amount: number;
}) {
  return order.status === "PENDING" && order.amount > 0;
}

/** 已经向支付机构要过二维码、链接或交易号的订单，不能静默改价或复用商户单号。 */
export function paymentInstitutionStarted(order: {
  payChannel?: string | null;
  codeUrl?: string | null;
  providerTradeNo?: string | null;
}) {
  if ((order.providerTradeNo || "").trim()) return true;
  if ((order.codeUrl || "").trim()) return true;
  const channel = (order.payChannel || "").trim();
  return !INTERNAL_PAY_MARKS.has(channel);
}

function sameOrderIntent(
  order: {
    userId: string;
    courseId: string;
    quantity: number;
    specLabel: string;
    couponInstanceId: string | null;
    amount: number;
    discount: number;
    formAnswersJson: string;
  },
  intent: OrderIntent,
) {
  return (
    order.userId === intent.userId &&
    order.courseId === intent.courseId &&
    order.quantity === intent.quantity &&
    (order.specLabel || "") === intent.specLabel &&
    (order.couponInstanceId || "") === intent.couponInstanceId &&
    order.amount + order.discount === intent.linePrice &&
    order.discount === intent.discount &&
    order.amount === intent.amount &&
    (order.formAnswersJson || "") === intent.formAnswersJson
  );
}

function rejectedClientTotals(body: Record<string, unknown>) {
  // 前端若仍传价格/优惠/他人 userId，一律忽略；出现则记日志便于排查伪造。
  const forged = ["userId", "amount", "price", "discount", "discountCents"].filter(
    (key) => key in body && body[key] !== undefined,
  );
  if (forged.length) {
    console.warn("[create-order] ignored client-supplied fields", forged);
  }
}

export async function createProductOrder(
  db: Db,
  input: CreateProductOrderInput,
  rawBody?: Record<string, unknown>,
): Promise<CreateProductOrderResult> {
  if (rawBody) rejectedClientTotals(rawBody);

  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, referredById: true },
  });
  if (!user) {
    throw new OrderBusinessError("请先登录", { status: 401 });
  }

  await expireStalePendingOrders(db, input.now);

  const course = await db.course.findUnique({ where: { id: input.courseId } });
  if (!course) {
    throw new OrderBusinessError("商品不存在", { status: 404 });
  }
  if (course.status !== "PUBLISHED") {
    throw new OrderBusinessError("课程已下架，无法购买", { status: 400 });
  }
  if (isMathcodeProductType(course.productType)) {
    throw new OrderBusinessError("请从识图转 LaTeX 页面购买会员或页数");
  }

  const isShopProduct = course.productType === SHOP_PRODUCT_TYPE;
  const isMeetupProduct = course.productType === MEETUP_PRODUCT_TYPE;
  const quantity = isMeetupProduct
    ? Math.min(10, Math.max(1, input.quantity ?? 1))
    : isShopProduct
      ? Math.min(99, Math.max(1, input.quantity ?? 1))
      : 1;

  if (isMeetupProduct) {
    const meetup = await db.meetup.findFirst({
      where: { productCourseId: course.id },
      include: { joins: { select: { partySize: true } } },
    });
    if (!meetup || meetup.status === "CANCELLED") {
      throw new OrderBusinessError("活动不可报名");
    }
    if (meetup.status !== "OPEN") {
      throw new OrderBusinessError(
        meetup.status === "FULL" ? "已满员" : "报名已截止",
      );
    }
    const occupied = sumMeetupPartySize(meetup.joins);
    const maxPeople = fromMeetupPeopleDb(meetup.maxPeople);
    if (occupied + quantity > maxPeople) {
      throw new OrderBusinessError("余位不足，请减少人数后再试");
    }
  }

  if (!isShopProduct) {
    const existing = await db.enrollment.findUnique({
      where: {
        userId_courseId: { userId: user.id, courseId: course.id },
      },
    });
    if (existing) {
      await grantProductAccess(db, {
        userId: user.id,
        productId: course.id,
      }, { skipChat: input.skipChat });
      return { enrolled: true, slug: course.slug, productType: course.productType };
    }

    const paidOrder = await db.order.findFirst({
      where: {
        userId: user.id,
        courseId: course.id,
        status: "PAID",
      },
      orderBy: { createdAt: "asc" },
    });
    if (paidOrder) {
      await grantProductAccess(db, {
        userId: user.id,
        productId: course.id,
      }, { skipChat: input.skipChat });
      return {
        enrolled: true,
        slug: course.slug,
        productType: course.productType,
        orderId: paidOrder.id,
        amount: paidOrder.amount,
        discount: paidOrder.discount,
      };
    }
  }

  let specLabel = (input.specLabel || "").trim();
  if (!specLabel) {
    const specs = parseSpecs(course.specsJson);
    const built = buildSpecLabel(specs, input.specSelected);
    if (!built.ok) {
      throw new OrderBusinessError(built.error);
    }
    specLabel = built.label;
  }

  const orderForm = input.orderForm || DEFAULT_ORDER_FORM;
  const answersCheck = validateOrderFormAnswers(orderForm, input.formAnswers);
  if (!answersCheck.ok) {
    throw new OrderBusinessError(answersCheck.error);
  }
  const formAnswersJson = stringifyStoredAnswers(answersCheck.stored);

  const linePrice = course.isFree ? 0 : course.price * quantity;
  if (input.couponCode?.trim() || input.couponId?.trim()) {
    throw new OrderBusinessError("公共券码已停用，请使用已领取的独立优惠券");
  }
  const instanceId = input.couponInstanceId?.trim() || "";

  let instanceCampaignId: string | null = null;
  let legacyCouponId: string | undefined;
  if (instanceId && linePrice > 0) {
    const instance = await db.couponInstance.findUnique({
      where: { id: instanceId },
      select: {
        id: true,
        campaignId: true,
        claimedByUserId: true,
        status: true,
        campaign: { select: { legacyCouponId: true } },
      },
    });
    if (!instance) throw new OrderBusinessError("优惠券不存在");
    if (instance.claimedByUserId !== user.id) {
      throw new OrderBusinessError("不能使用他人的优惠券");
    }
    const campaign = await loadCampaignRule(db, instance.campaignId);
    if (!campaign) throw new OrderBusinessError("优惠券不存在");
    instanceCampaignId = campaign.id;
    legacyCouponId = instance.campaign.legacyCouponId || undefined;
    const preview = calcCouponDiscount(linePrice, campaignToDiscountInput(campaign));
    if (preview < 0) {
      throw new OrderBusinessError("优惠券不可用");
    }
  }

  let discount = 0;
  if (instanceCampaignId && linePrice > 0) {
    const campaign = await loadCampaignRule(db, instanceCampaignId);
    discount = campaign
      ? calcCouponDiscount(linePrice, campaignToDiscountInput(campaign))
      : 0;
  }
  const amount = Math.max(linePrice - discount, 0);
  const appliedInstanceId = instanceId && linePrice > 0 ? instanceId : "";
  const intent: OrderIntent = {
    userId: user.id,
    courseId: course.id,
    quantity,
    specLabel,
    couponInstanceId: appliedInstanceId,
    linePrice,
    discount,
    amount,
    formAnswersJson,
  };

  const fromBody = (input.referralCode || "").trim().slice(0, 32);
  let referralCode: string | undefined = fromBody || undefined;
  if (!referralCode && user.referredById) {
    const inviter = await db.user.findUnique({
      where: { id: user.referredById },
      select: { referralCode: true },
    });
    referralCode = inviter?.referralCode || undefined;
  }

  const result = await db.$transaction(
    async (tx) => {
      if (!isShopProduct) {
        const enrolledNow = await tx.enrollment.findUnique({
          where: {
            userId_courseId: { userId: user.id, courseId: course.id },
          },
        });
        if (enrolledNow) {
          return {
            enrolled: true as const,
            slug: course.slug,
            productType: course.productType,
          };
        }
        const paidNow = await tx.order.findFirst({
          where: {
            userId: user.id,
            courseId: course.id,
            status: "PAID",
          },
          orderBy: { createdAt: "asc" },
        });
        if (paidNow) {
          await grantProductAccess(
            tx,
            { userId: user.id, productId: course.id },
            { skipChat: true },
          );
          return {
            enrolled: true as const,
            slug: course.slug,
            productType: course.productType,
            orderId: paidNow.id,
            amount: paidNow.amount,
            discount: paidNow.discount,
          };
        }

        const pending = await tx.order.findMany({
          where: {
            userId: user.id,
            courseId: course.id,
            status: "PENDING",
          },
          orderBy: { createdAt: "asc" },
        });
        const same = pending.filter((row) => sameOrderIntent(row, intent));
        const different = pending.filter((row) => !sameOrderIntent(row, intent));
        const blocking = different.find((row) => paymentInstitutionStarted(row));
        if (blocking) {
          throw new OrderBusinessError(
            "已有支付中的订单，不能改用新的优惠。请继续支付原订单，或确认未付款后再取消。",
            {
              status: 409,
              code: "PAYMENT_IN_PROGRESS",
              conflict: {
                orderId: blocking.id,
                orderNo: blocking.orderNo,
                amount: blocking.amount,
                discount: blocking.discount,
                payChannel: blocking.payChannel,
              },
            },
          );
        }
        for (const old of different) {
          await cancelPendingOrder(tx, old.id, "SUPERSEDED");
          console.info("[create-order] superseded pending order", {
            orderId: old.id,
            userId: user.id,
            courseId: course.id,
          });
        }
        const reusable = same[0];
        if (reusable) {
          if (reusable.amount === 0) {
            return completeZeroPayInTx(tx, reusable, {
              slug: course.slug,
              productType: course.productType,
              now: input.now,
            });
          }
          return {
            orderId: reusable.id,
            amount: reusable.amount,
            discount: reusable.discount,
            productType: course.productType,
          };
        }
      }

      const order = await tx.order.create({
        data: {
          orderNo: makeOrderNo(),
          userId: user.id,
          courseId: course.id,
          quantity,
          specLabel,
          amount,
          discount,
          couponId: legacyCouponId,
          couponInstanceId: appliedInstanceId || undefined,
          formAnswersJson,
          referralCode,
          status: amount === 0 ? "PAID" : "PENDING",
          paidAt: amount === 0 ? new Date() : undefined,
          payChannel:
            amount === 0 ? (appliedInstanceId ? "COUPON" : "FREE") : undefined,
        },
      });

      if (appliedInstanceId) {
        await reserveInstanceInTx(tx, {
          instanceId: appliedInstanceId,
          userId: user.id,
          orderId: order.id,
          priceCents: linePrice,
          courseId: course.id,
          now: input.now,
        });
      }

      if (amount === 0) {
        return completeZeroPayInTx(tx, order, {
          slug: course.slug,
          productType: course.productType,
          now: input.now,
          shopQuantity: isShopProduct ? quantity : 0,
        });
      }

      return {
        orderId: order.id,
        amount: order.amount,
        discount: order.discount,
        productType: course.productType,
      };
    },
    { timeout: 15000 },
  );

  if (result && "enrolled" in result && result.enrolled && !input.skipChat) {
    await notifyCourseAccessGroups({
      userId: input.userId,
      productId: input.courseId,
    });
  }

  return result;
}

/** 用户主动取消自己的待支付订单并释放优惠券。 */
export async function cancelOwnPendingOrder(
  db: Db,
  input: { userId: string; orderId: string },
) {
  const order = await db.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.userId !== input.userId) {
    throw new OrderBusinessError("订单不存在", { status: 404 });
  }
  if (order.status !== "PENDING") {
    throw new OrderBusinessError("订单状态不可取消");
  }
  if (paymentInstitutionStarted(order)) {
    throw new OrderBusinessError(
      "原订单已向支付机构下单。请先在结账页确认未支付，再取消并改用当前优惠。",
      {
        status: 409,
        code: "PAYMENT_IN_PROGRESS",
        conflict: {
          orderId: order.id,
          orderNo: order.orderNo,
          amount: order.amount,
          discount: order.discount,
          payChannel: order.payChannel,
        },
      },
    );
  }
  await db.$transaction(async (tx) => {
    await cancelPendingOrder(tx, order.id, "USER");
  });
  return { ok: true };
}

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** 0 元单在同一事务内核销券并发放权限，不调用微信/支付宝。 */
async function completeZeroPayInTx(
  tx: Tx,
  order: {
    id: string;
    userId: string;
    courseId: string;
    amount: number;
    discount: number;
    status: string;
    couponInstanceId: string | null;
    payChannel: string;
    quantity: number;
  },
  input: {
    slug: string;
    productType: string;
    now?: Date;
    shopQuantity?: number;
  },
) {
  const now = input.now || new Date();
  if (order.status !== "PAID") {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "PAID",
        amount: 0,
        paidAt: now,
        payChannel: order.couponInstanceId ? "COUPON" : order.payChannel || "FREE",
      },
    });
  }
  if (order.couponInstanceId) {
    await redeemInstanceForOrder(tx, {
      orderId: order.id,
      userId: order.userId,
      now,
    });
  }
  await grantProductAccess(
    tx,
    { userId: order.userId, productId: order.courseId },
    { skipChat: true },
  );
  if ((input.shopQuantity || 0) > 0) {
    await tx.course.update({
      where: { id: order.courseId },
      data: { studentCount: { increment: input.shopQuantity } },
    });
  }
  console.info("[create-order] zero-pay fulfilled", {
    orderId: order.id,
    userId: order.userId,
    courseId: order.courseId,
    discount: order.discount,
  });
  return {
    enrolled: true as const,
    zeroPay: true,
    slug: input.slug,
    productType: input.productType,
    orderId: order.id,
    amount: 0,
    discount: order.discount,
  };
}

/**
 * 历史 PENDING 且应付为 0 的订单：结账或支付接口幂等履约，绝不展示支付方式。
 */
export async function fulfillPendingZeroOrder(
  db: Db,
  orderId: string,
  options?: { now?: Date; skipNotify?: boolean },
) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { course: { select: { slug: true, productType: true } } },
  });
  if (!order) {
    throw new OrderBusinessError("订单不存在", { status: 404 });
  }
  if (order.amount > 0) return order;
  if (order.status === "PAID") {
    await grantProductAccess(
      db,
      { userId: order.userId, productId: order.courseId },
      { skipChat: true },
    );
    return order;
  }
  if (order.status !== "PENDING") return order;

  await db.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: orderId } });
    if (!current || current.status !== "PENDING" || current.amount > 0) return;
    await completeZeroPayInTx(tx, current, {
      slug: order.course.slug,
      productType: order.course.productType,
      now: options?.now,
    });
  });

  if (!options?.skipNotify) {
    await notifyCourseAccessGroups({
      userId: order.userId,
      productId: order.courseId,
    });
  }
  return db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { course: { select: { slug: true, productType: true } } },
  });
}
