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
    }
  | {
      enrolled?: false;
      orderId: string;
      amount: number;
      discount: number;
      productType: string;
    };

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

    const openOrder = await db.order.findFirst({
      where: {
        userId: user.id,
        courseId: course.id,
        status: { in: ["PENDING", "PAID"] },
      },
      orderBy: { createdAt: "asc" },
    });
    if (openOrder?.status === "PAID") {
      await grantProductAccess(db, {
        userId: user.id,
        productId: course.id,
      }, { skipChat: input.skipChat });
      return {
        enrolled: true,
        slug: course.slug,
        productType: course.productType,
        orderId: openOrder.id,
      };
    }
    if (openOrder?.status === "PENDING") {
      return {
        orderId: openOrder.id,
        amount: openOrder.amount,
        discount: openOrder.discount,
        productType: course.productType,
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
        const twin = await tx.order.findFirst({
          where: {
            userId: user.id,
            courseId: course.id,
            status: { in: ["PENDING", "PAID"] },
          },
          orderBy: { createdAt: "asc" },
        });
        if (twin?.status === "PAID") {
          await grantProductAccess(
            tx,
            { userId: user.id, productId: course.id },
            { skipChat: true },
          );
          return {
            enrolled: true as const,
            slug: course.slug,
            productType: course.productType,
            orderId: twin.id,
          };
        }
        if (twin?.status === "PENDING") {
          return {
            orderId: twin.id,
            amount: twin.amount,
            discount: twin.discount,
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
          couponInstanceId: instanceId || undefined,
          formAnswersJson,
          referralCode,
          status: amount === 0 ? "PAID" : "PENDING",
          paidAt: amount === 0 ? new Date() : undefined,
          payChannel:
            amount === 0 ? (instanceId ? "COUPON" : "FREE") : undefined,
        },
      });

      if (instanceId) {
        await reserveInstanceInTx(tx, {
          instanceId,
          userId: user.id,
          orderId: order.id,
          priceCents: linePrice,
          courseId: course.id,
          now: input.now,
        });
      }

      if (amount === 0) {
        if (instanceId) {
          await redeemInstanceForOrder(tx, {
            orderId: order.id,
            userId: user.id,
            now: input.now,
          });
        }
        await grantProductAccess(
          tx,
          { userId: user.id, productId: course.id },
          { skipChat: true },
        );
        if (isShopProduct) {
          await tx.course.update({
            where: { id: course.id },
            data: { studentCount: { increment: quantity } },
          });
        }
        return {
          enrolled: true as const,
          zeroPay: true,
          slug: course.slug,
          productType: course.productType,
          orderId: order.id,
        };
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
  await db.$transaction(async (tx) => {
    await cancelPendingOrder(tx, order.id, "USER");
  });
  return { ok: true };
}
