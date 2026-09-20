import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createProductOrder } from "./create-order";
import { listCouponsForBuyer } from "./coupon-availability";
import { OrderBusinessError } from "./order-errors";
import { DEFAULT_ORDER_FORM } from "./order-form";

const dbFile = path.join(process.cwd(), "prisma", "coupon-order-test.db");
const dbUrl = `file:${dbFile}`;

let db: PrismaClient;
let adminId = "";
let studentId = "";
let otherStudentId = "";
let courseId = "";
let otherCourseId = "";

async function resetWorld() {
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

async function createCoupon(
  data: Partial<{
    code: string;
    title: string;
    type: string;
    discountCents: number;
    percentOff: number;
    minAmount: number;
    maxUses: number;
    maxPerUser: number;
    isActive: boolean;
    startsAt: Date | null;
    expiresAt: Date | null;
    productScope: string;
    productIds: string[];
  }>,
) {
  const productIds = data.productIds || [];
  const productScope = data.productScope || "ALL";
  return db.coupon.create({
    data: {
      code: data.code || "TEST20",
      title: data.title || "测试券",
      type: data.type || "FIXED",
      discountCents: data.discountCents ?? 2000,
      percentOff: data.percentOff ?? 0,
      minAmount: data.minAmount ?? 0,
      maxUses: data.maxUses ?? 100,
      maxPerUser: data.maxPerUser ?? 1,
      isActive: data.isActive ?? true,
      startsAt: data.startsAt ?? null,
      expiresAt: data.expiresAt ?? null,
      productScope,
      createdById: adminId,
      ...(productScope === "SELECTED"
        ? { products: { create: productIds.map((id) => ({ courseId: id })) } }
        : {}),
    },
  });
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

test("普通用户使用有效优惠券购买单课成功", async () => {
  await resetWorld();
  await createCoupon({
    code: "SAVE20",
    discountCents: 2000,
    productScope: "SELECTED",
    productIds: [courseId],
  });
  const listed = await listCouponsForBuyer(db, { userId: studentId, courseId });
  assert.equal(listed.coupons.some((c) => c.code === "SAVE20"), true);

  const result = await buy(studentId, { couponCode: "SAVE20" });
  assert.equal("orderId" in result && !!result.orderId, true);
  assert.equal("amount" in result && result.amount, 7900);
  assert.equal("discount" in result && result.discount, 2000);

  const order = await db.order.findFirst({
    where: { userId: studentId, courseId },
  });
  assert.equal(order?.status, "PENDING");
  assert.equal(order?.userId, studentId);
  assert.equal(order?.amount, 7900);
  const coupon = await db.coupon.findUnique({ where: { code: "SAVE20" } });
  assert.equal(coupon?.usedCount, 1);
});

test("0 元券完成后立即获得课程权限", async () => {
  await resetWorld();
  await createCoupon({
    code: "FREE99",
    discountCents: 9900,
    productScope: "SELECTED",
    productIds: [courseId],
  });
  const result = await buy(studentId, { couponCode: "FREE99" });
  assert.equal(result.enrolled, true);
  assert.equal("zeroPay" in result && result.zeroPay, true);

  const enrollment = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: studentId, courseId } },
  });
  assert.ok(enrollment);
  const order = await db.order.findFirst({
    where: { userId: studentId, courseId },
  });
  assert.equal(order?.status, "PAID");
  assert.equal(order?.amount, 0);
  assert.equal(order?.payChannel, "COUPON");
});

test("无效、过期、未开始、超限、不适用、已使用优惠券被拒绝", async () => {
  await resetWorld();
  await createCoupon({ code: "OFF", isActive: false, discountCents: 2000 });
  await createCoupon({
    code: "EXPIRED",
    discountCents: 2000,
    expiresAt: new Date(Date.now() - 60_000),
  });
  await createCoupon({
    code: "FUTURE",
    discountCents: 2000,
    startsAt: new Date(Date.now() + 60_000),
  });
  await createCoupon({ code: "LIMIT", discountCents: 2000, maxUses: 1 });
  await db.coupon.update({
    where: { code: "LIMIT" },
    data: { usedCount: 1 },
  });
  await createCoupon({
    code: "OTHER",
    discountCents: 2000,
    productScope: "SELECTED",
    productIds: [otherCourseId],
  });
  await createCoupon({
    code: "ONCE",
    discountCents: 9900,
    maxPerUser: 1,
  });

  async function reject(code: string, message: string) {
    await assert.rejects(
      () => buy(studentId, { couponCode: code }),
      (err: unknown) => {
        assert.ok(err instanceof OrderBusinessError);
        assert.match(err.userMessage, new RegExp(message));
        return true;
      },
    );
  }

  await reject("NOPE", "优惠券不存在");
  await reject("OFF", "已停用");
  await reject("EXPIRED", "已过期");
  await reject("FUTURE", "尚未开始");
  await reject("LIMIT", "已领完");
  await reject("OTHER", "不适用于当前商品");

  await buy(studentId, { couponCode: "ONCE" });
  await db.enrollment.deleteMany({ where: { userId: studentId } });
  await db.order.updateMany({
    where: { userId: studentId },
    data: { status: "CANCELLED" },
  });
  await reject("ONCE", "已使用过");
});

test("非管理员不能伪造其他 userId、价格或优惠金额", async () => {
  await resetWorld();
  await createCoupon({ code: "SAVE20", discountCents: 2000 });
  const result = await buy(
    studentId,
    { couponCode: "SAVE20" },
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
  assert.equal(order?.amount, 7900);
  assert.equal(order?.discount, 2000);
});

test("同一优惠券并发/重复下单不会超用或重复开通", async () => {
  await resetWorld();
  await createCoupon({
    code: "LASTONE",
    discountCents: 2000,
    maxUses: 1,
  });

  const [a, b] = await Promise.allSettled([
    buy(studentId, { couponCode: "LASTONE" }),
    buy(otherStudentId, { couponCode: "LASTONE" }),
  ]);
  const wins = [a, b].filter((x) => x.status === "fulfilled");
  const losses = [a, b].filter((x) => x.status === "rejected");
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);
  const coupon = await db.coupon.findUnique({ where: { code: "LASTONE" } });
  assert.equal(coupon?.usedCount, 1);
  assert.equal(await db.order.count({ where: { status: "PENDING" } }), 1);

  await resetWorld();
  await createCoupon({ code: "DUP", discountCents: 2000 });
  const first = await buy(studentId, { couponCode: "DUP" });
  const second = await buy(studentId, { couponCode: "DUP" });
  assert.equal("orderId" in first && "orderId" in second, true);
  if ("orderId" in first && "orderId" in second) {
    assert.equal(first.orderId, second.orderId);
  }
  assert.equal(await db.order.count({ where: { userId: studentId, courseId } }), 1);
});

test("管理员创建课程和优惠券后，普通用户可以正常读取并下单", async () => {
  await resetWorld();
  const adminCourse = await db.course.findUnique({ where: { id: courseId } });
  assert.equal(adminCourse?.teacherId, adminId);
  assert.equal(adminCourse?.status, "PUBLISHED");

  await createCoupon({
    code: "ADMINSEL",
    title: "站长指定单课券",
    discountCents: 9900,
    productScope: "SELECTED",
    productIds: [courseId],
  });

  const listed = await listCouponsForBuyer(db, { userId: studentId, courseId });
  const hit = listed.coupons.find((c) => c.code === "ADMINSEL");
  assert.ok(hit, "普通用户应能看到管理员创建的指定商品券");

  const result = await buy(studentId, { couponId: hit!.id });
  assert.equal(result.enrolled, true);
  const enrollment = await db.enrollment.findUnique({
    where: { userId_courseId: { userId: studentId, courseId } },
  });
  assert.ok(enrollment);
});
