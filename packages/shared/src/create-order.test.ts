import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  cancelOwnPendingOrder,
  createProductOrder,
  fulfillPendingZeroOrder,
  orderRequiresExternalPayment,
} from "./create-order";
import { reserveInstanceInTx } from "./coupon-instance";
import { OrderBusinessError } from "./order-errors";
import { fulfillPaidOrder } from "./orders";
import { listCouponsForBuyer } from "./coupon-availability";
import { createCouponCampaign } from "./coupon-campaign";
import { claimInstanceByToken } from "./coupon-instance";
import { decryptCouponToken } from "./coupon-token";
import { DEFAULT_ORDER_FORM } from "./order-form";

const dbFile = path.join(process.cwd(), "prisma", "coupon-order-test.db");
const dbUrl = `file:${dbFile}`;

if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = "test-auth-secret";

let db: PrismaClient;
let adminId = "";
let studentId = "";
let otherStudentId = "";
let courseId = "";
let otherCourseId = "";

async function resetWorld() {
  await db.couponAuditLog.deleteMany();
  await db.couponInstance.deleteMany();
  await db.couponCampaignProduct.deleteMany();
  await db.couponCampaign.deleteMany();
  await db.couponRedemption.deleteMany();
  await db.lessonProgress.deleteMany();
  await db.enrollment.deleteMany();
  await db.order.deleteMany();
  await db.couponProduct.deleteMany();
  await db.coupon.deleteMany();
  await db.lesson.deleteMany();
  await db.chapter.deleteMany();
  await db.course.deleteMany();
  await db.user.deleteMany();

  const admin = await db.user.create({
    data: {
      email: "admin@test.local",
      passwordHash: "x",
      name: "站长",
      role: "ADMIN",
      referralCode: "ADMTEST1",
    },
  });
  const student = await db.user.create({
    data: {
      email: "student@test.local",
      passwordHash: "x",
      name: "学员",
      role: "STUDENT",
      referralCode: "STUTEST1",
    },
  });
  const other = await db.user.create({
    data: {
      email: "student2@test.local",
      passwordHash: "x",
      name: "学员乙",
      role: "STUDENT",
      referralCode: "STUTEST2",
    },
  });
  const course = await db.course.create({
    data: {
      title: "管理员创建的单课",
      slug: "admin-single-course",
      description: "测试课",
      price: 9900,
      status: "PUBLISHED",
      productType: "COURSE",
      teacherId: admin.id,
    },
  });
  const otherCourse = await db.course.create({
    data: {
      title: "另一门课",
      slug: "other-course",
      description: "不适用券",
      price: 19900,
      status: "PUBLISHED",
      productType: "COURSE",
      teacherId: admin.id,
    },
  });
  adminId = admin.id;
  studentId = student.id;
  otherStudentId = other.id;
  courseId = course.id;
  otherCourseId = otherCourse.id;
}

async function issueAndClaim(input: {
  userId: string;
  discountCents?: number;
  productIds?: string[];
  expiresAt?: Date | null;
  isActive?: boolean;
  issueCount?: number;
  name?: string;
}) {
  const campaign = await createCouponCampaign(db, {
    name: input.name || "测试活动",
    type: "FIXED",
    discountCents: input.discountCents ?? 2000,
    percentOff: 0,
    issueCount: input.issueCount ?? 1,
    expiresAt: input.expiresAt,
    productScope: input.productIds ? "SELECTED" : "ALL",
    productIds: input.productIds,
    createdById: adminId,
  });
  if (input.isActive === false) {
    await db.couponCampaign.update({
      where: { id: campaign.id },
      data: { isActive: false },
    });
  }
  const instance = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: campaign.id, status: "AVAILABLE" },
    orderBy: { serialNo: "asc" },
  });
  const token = decryptCouponToken(instance.tokenEncrypted);
  if (input.userId) {
    await claimInstanceByToken(db, { token, userId: input.userId });
  }
  return { campaign, instance, token };
}

async function buy(
  userId: string,
  extra: Partial<Parameters<typeof createProductOrder>[1]> = {},
  rawBody?: Record<string, unknown>,
) {
  return createProductOrder(
    db,
    {
      userId,
      courseId,
      orderForm: DEFAULT_ORDER_FORM,
      skipChat: true,
      ...extra,
    },
    rawBody,
  );
}

before(async () => {
  process.env.DATABASE_URL = dbUrl;
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  await db.$connect();
});

after(async () => {
  await db.$disconnect();
});

test("普通用户使用已领取的独立优惠券购买单课成功", async () => {
  await resetWorld();
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
    productIds: [courseId],
  });
  const listed = await listCouponsForBuyer(db, { userId: studentId, courseId });
  assert.equal(listed.coupons.some((c) => c.instanceId === instance.id), true);

  const result = await buy(studentId, { couponInstanceId: instance.id });
  assert.equal("orderId" in result && !!result.orderId, true);
  assert.equal("amount" in result && result.amount, 7900);
  const order = await db.order.findFirst({ where: { userId: studentId, courseId } });
  assert.equal(order?.status, "PENDING");
  assert.equal(order?.userId, studentId);
  const reserved = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(reserved.status, "RESERVED");
});

test("0 元券完成后立即获得课程权限并核销", async () => {
  await resetWorld();
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 9900,
    productIds: [courseId],
  });
  const result = await buy(studentId, { couponInstanceId: instance.id });
  assert.equal(result.enrolled, true);
  assert.equal("zeroPay" in result && result.zeroPay, true);
  const enrollment = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: studentId, courseId } },
  });
  assert.ok(enrollment);
  const inst = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(inst.status, "REDEEMED");
});

test("公共券码、过期、不适用、已使用优惠券被拒绝", async () => {
  await resetWorld();
  await assert.rejects(
    () => buy(studentId, { couponCode: "YYDS20" }),
    /公共券码已停用/,
  );

  const expired = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
  });
  await db.couponCampaign.update({
    where: { id: expired.campaign.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await assert.rejects(
    () => buy(studentId, { couponInstanceId: expired.instance.id }),
    /过期/,
  );

  const other = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
    productIds: [otherCourseId],
    name: "别的课",
  });
  await assert.rejects(
    () => buy(studentId, { couponInstanceId: other.instance.id }),
    /不适用于/,
  );

  const once = await issueAndClaim({
    userId: studentId,
    discountCents: 9900,
    name: "一次",
  });
  await buy(studentId, { couponInstanceId: once.instance.id });
  await db.enrollment.deleteMany({ where: { userId: studentId } });
  await db.order.updateMany({
    where: { userId: studentId },
    data: { status: "CANCELLED" },
  });
  await assert.rejects(
    () => buy(studentId, { couponInstanceId: once.instance.id }),
    /已使用/,
  );
});

test("非管理员不能伪造其他 userId、价格或优惠金额", async () => {
  await resetWorld();
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
  });
  const result = await buy(
    studentId,
    { couponInstanceId: instance.id },
    {
      userId: adminId,
      price: 1,
      amount: 1,
      discount: 9900,
      discountCents: 9900,
    },
  );
  assert.equal("amount" in result && result.amount, 7900);
  const order = await db.order.findFirst({ where: { courseId } });
  assert.equal(order?.userId, studentId);
  assert.notEqual(order?.userId, adminId);
});

test("同一独立券并发下单不会超用或重复开通", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "并发",
    type: "FIXED",
    discountCents: 2000,
    percentOff: 0,
    issueCount: 1,
    createdById: adminId,
  });
  const instance = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: campaign.id },
  });
  const token = decryptCouponToken(instance.tokenEncrypted);
  await claimInstanceByToken(db, { token, userId: studentId });

  const [a, b] = await Promise.allSettled([
    buy(studentId, { couponInstanceId: instance.id }),
    buy(otherStudentId, { couponInstanceId: instance.id }),
  ]);
  const wins = [a, b].filter((x) => x.status === "fulfilled");
  const losses = [a, b].filter((x) => x.status === "rejected");
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);

  await resetWorld();
  const { instance: inst } = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
  });
  const first = await buy(studentId, { couponInstanceId: inst.id });
  const second = await buy(studentId, { couponInstanceId: inst.id });
  if ("orderId" in first && "orderId" in second) {
    assert.equal(first.orderId, second.orderId);
  }
});

test("管理员创建活动后普通用户领取并下单", async () => {
  await resetWorld();
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 9900,
    productIds: [courseId],
    name: "站长指定单课券",
  });
  const listed = await listCouponsForBuyer(db, { userId: studentId, courseId });
  assert.ok(listed.coupons.some((c) => c.instanceId === instance.id));
  const result = await buy(studentId, { couponInstanceId: instance.id });
  assert.equal(result.enrolled, true);
  const enrollment = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: studentId, courseId } },
  });
  assert.ok(enrollment);
});

test("192000 分课程使用 192000 分定额券后 0 元开通且不产生支付单", async () => {
  await resetWorld();
  await db.course.update({ where: { id: courseId }, data: { price: 192000 } });
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 192000,
    productIds: [courseId],
  });
  const result = await buy(studentId, { couponInstanceId: instance.id });
  assert.equal(result.enrolled, true);
  assert.equal("zeroPay" in result && result.zeroPay, true);
  assert.equal("amount" in result && result.amount, 0);
  const order = await db.order.findFirstOrThrow({
    where: { userId: studentId, courseId, status: "PAID" },
  });
  assert.equal(order.amount, 0);
  assert.equal(order.discount, 192000);
  assert.equal(order.payChannel, "COUPON");
  assert.equal(order.codeUrl, "");
  assert.equal(order.providerTradeNo, "");
  assert.equal(orderRequiresExternalPayment(order), false);
  const inst = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(inst.status, "REDEEMED");
});

test("先有原价待支付订单，再选满额券时旧单被替代并 0 元开通", async () => {
  await resetWorld();
  await db.course.update({ where: { id: courseId }, data: { price: 192000 } });
  const stale = await buy(studentId);
  if (!stale.orderId) throw new Error("expected pending order");
  assert.equal("amount" in stale && stale.amount, 192000);
  const staleId = stale.orderId;
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 192000,
    productIds: [courseId],
  });
  const result = await buy(studentId, { couponInstanceId: instance.id });
  assert.equal(result.enrolled, true);
  assert.equal("zeroPay" in result && result.zeroPay, true);
  assert.equal("amount" in result && result.amount, 0);
  const old = await db.order.findUniqueOrThrow({ where: { id: staleId } });
  assert.equal(old.status, "CANCELLED");
  const paid = await db.order.findFirstOrThrow({
    where: { userId: studentId, courseId, status: "PAID" },
  });
  assert.notEqual(paid.id, staleId);
  assert.equal(paid.amount, 0);
  assert.equal(paid.discount, 192000);
  assert.equal(paid.payChannel, "COUPON");
  assert.equal(paid.codeUrl, "");
  assert.equal(orderRequiresExternalPayment(paid), false);
  const pending = await db.order.count({
    where: { userId: studentId, courseId, status: "PENDING" },
  });
  assert.equal(pending, 0);
  const inst = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(inst.status, "REDEEMED");
  assert.equal(inst.redeemedOrderId, paid.id);
  const enrollment = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: studentId, courseId } },
  });
  assert.ok(enrollment);
});

test("改选另一张券时释放原券并占用新券", async () => {
  await resetWorld();
  const couponA = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
    name: "券A",
  });
  const couponB = await issueAndClaim({
    userId: studentId,
    discountCents: 3000,
    name: "券B",
  });
  const first = await buy(studentId, { couponInstanceId: couponA.instance.id });
  assert.equal("orderId" in first, true);
  const firstId = "orderId" in first ? first.orderId : "";
  const second = await buy(studentId, { couponInstanceId: couponB.instance.id });
  assert.equal("orderId" in second, true);
  const secondId = "orderId" in second ? second.orderId : "";
  assert.notEqual(secondId, firstId);
  assert.equal("amount" in second && second.amount, 6900);
  const old = await db.order.findUniqueOrThrow({ where: { id: firstId } });
  assert.equal(old.status, "CANCELLED");
  const released = await db.couponInstance.findUniqueOrThrow({
    where: { id: couponA.instance.id },
  });
  assert.equal(released.status, "CLAIMED");
  assert.equal(released.reservedOrderId, null);
  const reserved = await db.couponInstance.findUniqueOrThrow({
    where: { id: couponB.instance.id },
  });
  assert.equal(reserved.status, "RESERVED");
  assert.equal(reserved.reservedOrderId, secondId);
});

test("同一满额券重复提交只开通一次", async () => {
  await resetWorld();
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 9900,
  });
  const [a, b] = await Promise.allSettled([
    buy(studentId, { couponInstanceId: instance.id }),
    buy(studentId, { couponInstanceId: instance.id }),
  ]);
  assert.ok(a.status === "fulfilled" || b.status === "fulfilled");
  const paid = await db.order.count({
    where: { userId: studentId, courseId, status: "PAID" },
  });
  assert.equal(paid, 1);
  const enrollments = await db.enrollment.count({
    where: { userId: studentId, courseId },
  });
  assert.equal(enrollments, 1);
  const inst = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(inst.status, "REDEEMED");
});

test("折扣高于课程价时应付为 0 且不为负数", async () => {
  await resetWorld();
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 20000,
  });
  const result = await buy(studentId, { couponInstanceId: instance.id });
  assert.equal(result.enrolled, true);
  const order = await db.order.findFirstOrThrow({
    where: { userId: studentId, status: "PAID" },
  });
  assert.equal(order.amount, 0);
  assert.equal(order.discount, 9900);
  assert.ok(order.amount >= 0);
});

test("他人券、停用活动和未达门槛都不能下单", async () => {
  await resetWorld();
  const others = await issueAndClaim({
    userId: otherStudentId,
    discountCents: 2000,
    name: "别人的券",
  });
  await assert.rejects(
    () => buy(studentId, { couponInstanceId: others.instance.id }),
    /他人/,
  );

  const disabled = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
    name: "停用",
  });
  await db.couponCampaign.update({
    where: { id: disabled.campaign.id },
    data: { isActive: false },
  });
  await assert.rejects(
    () => buy(studentId, { couponInstanceId: disabled.instance.id }),
    /停用/,
  );

  const campaign = await createCouponCampaign(db, {
    name: "有门槛",
    type: "FIXED",
    discountCents: 1000,
    percentOff: 0,
    minAmount: 50000,
    issueCount: 1,
    createdById: adminId,
  });
  const gated = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: campaign.id },
  });
  await claimInstanceByToken(db, {
    token: decryptCouponToken(gated.tokenEncrypted),
    userId: studentId,
  });
  await assert.rejects(
    () => buy(studentId, { couponInstanceId: gated.id }),
    /未满/,
  );
  const leftover = await db.order.count({ where: { userId: studentId } });
  assert.equal(leftover, 0);
});

test("已向微信下单的待支付订单不能被静默改价", async () => {
  await resetWorld();
  const first = await buy(studentId);
  if (!first.orderId) throw new Error("expected pending order");
  const firstId = first.orderId;
  await db.order.update({
    where: { id: firstId },
    data: { payChannel: "WECHAT_NATIVE", codeUrl: "weixin://pay/test-only" },
  });
  const again = await buy(studentId);
  assert.equal("orderId" in again && again.orderId, firstId);
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 9900,
  });
  await assert.rejects(
    () => buy(studentId, { couponInstanceId: instance.id }),
    (err: unknown) => {
      assert.ok(err instanceof OrderBusinessError);
      assert.equal(err.httpStatus, 409);
      assert.equal(err.code, "PAYMENT_IN_PROGRESS");
      return true;
    },
  );
  const still = await db.order.findUniqueOrThrow({ where: { id: firstId } });
  assert.equal(still.status, "PENDING");
  assert.equal(still.amount, 9900);
  assert.equal(still.discount, 0);
  assert.equal(still.codeUrl, "weixin://pay/test-only");
  await assert.rejects(
    () => cancelOwnPendingOrder(db, { userId: studentId, orderId: firstId }),
    (err: unknown) => {
      assert.ok(err instanceof OrderBusinessError);
      assert.equal(err.httpStatus, 409);
      return true;
    },
  );
});

test("历史 0 元待支付订单在履约入口被幂等开通", async () => {
  await resetWorld();
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 9900,
  });
  const order = await db.order.create({
    data: {
      orderNo: `ZERO${Date.now()}`,
      userId: studentId,
      courseId,
      amount: 0,
      discount: 9900,
      status: "PENDING",
      couponInstanceId: instance.id,
    },
  });
  await reserveInstanceInTx(db, {
    instanceId: instance.id,
    userId: studentId,
    orderId: order.id,
    priceCents: 9900,
    courseId,
  });
  await fulfillPendingZeroOrder(db, order.id, { skipNotify: true });
  await fulfillPendingZeroOrder(db, order.id, { skipNotify: true });
  const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(paid.status, "PAID");
  assert.equal(paid.amount, 0);
  assert.equal(paid.payChannel, "COUPON");
  assert.equal(orderRequiresExternalPayment(paid), false);
  const inst = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(inst.status, "REDEEMED");
  const enrollments = await db.enrollment.count({
    where: { userId: studentId, courseId },
  });
  assert.equal(enrollments, 1);
});

test("支付回调重放不重复开通、不重复发佣金", async () => {
  await resetWorld();
  await db.user.update({
    where: { id: studentId },
    data: { referredById: otherStudentId },
  });
  const { instance } = await issueAndClaim({
    userId: studentId,
    discountCents: 2000,
  });
  const created = await buy(studentId, {
    couponInstanceId: instance.id,
    referralCode: "STUTEST2",
  });
  if (!created.orderId) throw new Error("expected pending order");
  const orderId = created.orderId;
  await fulfillPaidOrder(
    { orderId, payChannel: "WECHAT", providerTradeNo: "wx-replay", skipNotify: true },
    db,
  );
  const afterFirst = await db.course.findUniqueOrThrow({ where: { id: courseId } });
  const commissions = await db.commission.count({ where: { orderId } });
  const enrollments = await db.enrollment.count({
    where: { userId: studentId, courseId },
  });
  await fulfillPaidOrder(
    { orderId, payChannel: "WECHAT", providerTradeNo: "wx-replay", skipNotify: true },
    db,
  );
  const afterSecond = await db.course.findUniqueOrThrow({ where: { id: courseId } });
  assert.equal(afterSecond.studentCount, afterFirst.studentCount);
  assert.equal(await db.commission.count({ where: { orderId } }), commissions);
  assert.equal(
    await db.enrollment.count({ where: { userId: studentId, courseId } }),
    enrollments,
  );
  assert.equal(enrollments, 1);
  const inst = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(inst.status, "REDEEMED");
  const paid = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(paid.status, "PAID");
  assert.equal(paid.providerTradeNo, "wx-replay");
});
