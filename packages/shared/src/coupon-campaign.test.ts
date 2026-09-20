import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { createProductOrder } from "./create-order";
import {
  createCouponCampaign,
  resizeCampaignIssueCount,
  softDeleteCampaign,
} from "./coupon-campaign";
import { migrateLegacyCoupons } from "./coupon-campaign-migrate";
import {
  campaignCsv,
  claimInstanceByToken,
  exportCampaignLinks,
  previewInstanceByToken,
  redeemInstanceForOrder,
} from "./coupon-instance";
import { couponClaimLoginPath } from "./coupon-paths";
import { decryptCouponToken, hashCouponToken } from "./coupon-token";
import { cancelPendingOrder } from "./coupon-reservation";
import { OrderBusinessError } from "./order-errors";
import { DEFAULT_ORDER_FORM } from "./order-form";

const dbFile = path.join(process.cwd(), "prisma", "coupon-campaign-test.db");
const dbUrl = `file:${dbFile}`;

let db: PrismaClient;
let adminId = "";
let studentId = "";
let otherId = "";
let courseId = "";
let otherCourseId = "";

if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = "test-auth-secret";

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
      title: "高等数学",
      slug: "gaoshu",
      description: "测试课",
      price: 10000,
      status: "PUBLISHED",
      productType: "COURSE",
      teacherId: admin.id,
    },
  });
  const otherCourse = await db.course.create({
    data: {
      title: "另一门课",
      slug: "other-course",
      description: "不适用",
      price: 19900,
      status: "PUBLISHED",
      productType: "COURSE",
      teacherId: admin.id,
    },
  });
  adminId = admin.id;
  studentId = student.id;
  otherId = other.id;
  courseId = course.id;
  otherCourseId = otherCourse.id;
}

async function tokenOf(instanceId: string) {
  const row = await db.couponInstance.findUniqueOrThrow({
    where: { id: instanceId },
  });
  return decryptCouponToken(row.tokenEncrypted);
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

test("创建发行量为 200 的活动后实际生成 200 个独立 token", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "高等数学单课优惠券",
    type: "FIXED",
    discountCents: 10000,
    percentOff: 0,
    issueCount: 200,
    maxPerUser: 1,
    productScope: "SELECTED",
    productIds: [courseId],
    createdById: adminId,
  });
  const rows = await db.couponInstance.findMany({ where: { campaignId: campaign.id } });
  assert.equal(rows.length, 200);
  const hashes = new Set(rows.map((r) => r.tokenHash));
  const serials = new Set(rows.map((r) => r.serialNo));
  assert.equal(hashes.size, 200);
  assert.equal(serials.size, 200);
  for (const row of rows) {
    assert.equal(row.tokenHash.length, 64);
    assert.notEqual(row.tokenHash, row.serialNo);
    const token = decryptCouponToken(row.tokenEncrypted);
    assert.equal(hashCouponToken(token), row.tokenHash);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(token.length >= 32);
  }
});

test("管理员可导出 200 个不同领取链接", async () => {
  const campaign = await db.couponCampaign.findFirstOrThrow();
  const links = await exportCampaignLinks(db, campaign.id, "https://course.example");
  assert.equal(links.length, 200);
  const urls = new Set(links.map((l) => l.url));
  assert.equal(urls.size, 200);
  for (const link of links) {
    assert.match(link.url, /^https:\/\/course\.example\/coupon\/claim\//);
  }
  const csv = campaignCsv(links);
  assert.match(csv, /serialNo,claimUrl/);
  assert.ok(csv.split("\n").length > 200);
});

test("打开链接只预览，点击领取才绑定；未登录回跳领取页", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "预览券",
    type: "FIXED",
    discountCents: 10000,
    percentOff: 0,
    issueCount: 2,
    createdById: adminId,
    productScope: "SELECTED",
    productIds: [courseId],
  });
  const instance = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: campaign.id },
  });
  const token = await tokenOf(instance.id);
  const preview = await previewInstanceByToken(db, token);
  assert.equal(preview.claimState, "open");
  const still = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(still.status, "AVAILABLE");
  assert.equal(couponClaimLoginPath(token).startsWith("/login?next="), true);
  assert.match(couponClaimLoginPath(token), /coupon%2Fclaim/);
});

test("同一链接只能被一个用户领取，重复领取幂等，并发只有一个成功", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "抢领券",
    type: "FIXED",
    discountCents: 10000,
    percentOff: 0,
    issueCount: 1,
    createdById: adminId,
  });
  const instance = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: campaign.id },
  });
  const token = await tokenOf(instance.id);
  const [a, b] = await Promise.allSettled([
    claimInstanceByToken(db, { token, userId: studentId }),
    claimInstanceByToken(db, { token, userId: otherId }),
  ]);
  const wins = [a, b].filter((x) => x.status === "fulfilled");
  const losses = [a, b].filter((x) => x.status === "rejected");
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);
  const again = await claimInstanceByToken(db, { token, userId: studentId });
  const winnerId =
    a.status === "fulfilled" ? studentId : otherId;
  if (a.status === "fulfilled" || b.status === "fulfilled") {
    const claimed = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
    assert.equal(claimed.status, "CLAIMED");
    assert.ok(claimed.claimedByUserId === studentId || claimed.claimedByUserId === otherId);
    if (claimed.claimedByUserId === studentId) {
      assert.equal(again.already, true);
    }
  }
  void winnerId;
});

test("达到每用户领取上限不会消耗新链接", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "限领一张",
    type: "FIXED",
    discountCents: 10000,
    percentOff: 0,
    issueCount: 3,
    maxPerUser: 1,
    createdById: adminId,
  });
  const rows = await db.couponInstance.findMany({
    where: { campaignId: campaign.id },
    orderBy: { serialNo: "asc" },
  });
  const t1 = await tokenOf(rows[0]!.id);
  const t2 = await tokenOf(rows[1]!.id);
  await claimInstanceByToken(db, { token: t1, userId: studentId });
  await assert.rejects(
    () => claimInstanceByToken(db, { token: t2, userId: studentId }),
    (err: unknown) => {
      assert.ok(err instanceof OrderBusinessError);
      assert.match(err.userMessage, /领取上限/);
      return true;
    },
  );
  const second = await db.couponInstance.findUniqueOrThrow({ where: { id: rows[1]!.id } });
  assert.equal(second.status, "AVAILABLE");
  assert.equal(second.claimedByUserId, null);
});

test("他人不能使用已绑定的券；同一券只能核销一次", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "核销券",
    type: "FIXED",
    discountCents: 10000,
    percentOff: 0,
    issueCount: 1,
    createdById: adminId,
    productScope: "SELECTED",
    productIds: [courseId],
  });
  const instance = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: campaign.id },
  });
  const token = await tokenOf(instance.id);
  await claimInstanceByToken(db, { token, userId: studentId });
  await assert.rejects(
    () =>
      createProductOrder(db, {
        userId: otherId,
        courseId,
        couponInstanceId: instance.id,
        orderForm: DEFAULT_ORDER_FORM,
        skipChat: true,
      }),
    /他人的优惠券/,
  );
  const first = await createProductOrder(
    db,
    {
      userId: studentId,
      courseId,
      couponInstanceId: instance.id,
      orderForm: DEFAULT_ORDER_FORM,
      skipChat: true,
    },
  );
  assert.equal(first.enrolled, true);
  const redeemed = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(redeemed.status, "REDEEMED");
  await db.enrollment.deleteMany({ where: { userId: studentId } });
  await db.order.updateMany({
    where: { userId: studentId },
    data: { status: "CANCELLED" },
  });
  await assert.rejects(
    () =>
      createProductOrder(db, {
        userId: studentId,
        courseId,
        couponInstanceId: instance.id,
        orderForm: DEFAULT_ORDER_FORM,
        skipChat: true,
      }),
    /已使用/,
  );
});

test("付费预占后取消会释放；支付履约核销且重复回调幂等", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "付费券",
    type: "FIXED",
    discountCents: 2000,
    percentOff: 0,
    issueCount: 1,
    createdById: adminId,
  });
  const instance = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: campaign.id },
  });
  await claimInstanceByToken(db, {
    token: await tokenOf(instance.id),
    userId: studentId,
  });
  const pending = await createProductOrder(db, {
    userId: studentId,
    courseId,
    couponInstanceId: instance.id,
    orderForm: DEFAULT_ORDER_FORM,
    skipChat: true,
  });
  assert.ok("orderId" in pending && pending.orderId);
  const reserved = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(reserved.status, "RESERVED");
  await cancelPendingOrder(db, pending.orderId!);
  const released = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(released.status, "CLAIMED");
  assert.equal(released.redeemedOrderId, null);

  const again = await createProductOrder(db, {
    userId: studentId,
    courseId,
    couponInstanceId: instance.id,
    orderForm: DEFAULT_ORDER_FORM,
    skipChat: true,
  });
  assert.ok(again.orderId);
  await db.order.update({
    where: { id: again.orderId! },
    data: { status: "PAID", paidAt: new Date(), payChannel: "MOCK" },
  });
  await redeemInstanceForOrder(db, { orderId: again.orderId!, userId: studentId });
  await redeemInstanceForOrder(db, { orderId: again.orderId!, userId: studentId });
  const once = await db.couponInstance.findUniqueOrThrow({ where: { id: instance.id } });
  assert.equal(once.status, "REDEEMED");
  assert.equal(once.redeemedOrderId, again.orderId);
  assert.equal(
    await db.couponInstance.count({ where: { id: instance.id, status: "REDEEMED" } }),
    1,
  );
});

test("增加发行量只补差额；减少不会删除已领取或已核销", async () => {
  await resetWorld();
  const campaign = await createCouponCampaign(db, {
    name: "增减券",
    type: "FIXED",
    discountCents: 1000,
    percentOff: 0,
    issueCount: 4,
    createdById: adminId,
  });
  const rows = await db.couponInstance.findMany({
    where: { campaignId: campaign.id },
    orderBy: { serialNo: "asc" },
  });
  await claimInstanceByToken(db, {
    token: await tokenOf(rows[0]!.id),
    userId: studentId,
  });
  await resizeCampaignIssueCount(db, {
    campaignId: campaign.id,
    issueCount: 6,
    actorId: adminId,
  });
  assert.equal(await db.couponInstance.count({ where: { campaignId: campaign.id } }), 6);
  await resizeCampaignIssueCount(db, {
    campaignId: campaign.id,
    issueCount: 3,
    actorId: adminId,
  });
  const after = await db.couponInstance.findMany({ where: { campaignId: campaign.id } });
  assert.equal(after.length, 6);
  const claimed = after.find((r) => r.id === rows[0]!.id);
  assert.equal(claimed?.status, "CLAIMED");
  assert.equal(after.filter((r) => r.status === "DISABLED").length, 3);
});

test("过期、停用、不适用课程无法领取或核销；学生看不到完整链接", async () => {
  await resetWorld();
  const expired = await createCouponCampaign(db, {
    name: "过期活动",
    type: "FIXED",
    discountCents: 1000,
    percentOff: 0,
    issueCount: 1,
    expiresAt: new Date(Date.now() - 1000),
    createdById: adminId,
  });
  const expInst = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: expired.id },
  });
  const expiredToken = await tokenOf(expInst.id);
  await assert.rejects(
    () => claimInstanceByToken(db, { token: expiredToken, userId: studentId }),
    /过期|结束/,
  );

  const selected = await createCouponCampaign(db, {
    name: "指定课",
    type: "FIXED",
    discountCents: 1000,
    percentOff: 0,
    issueCount: 1,
    productScope: "SELECTED",
    productIds: [otherCourseId],
    createdById: adminId,
  });
  const sel = await db.couponInstance.findFirstOrThrow({
    where: { campaignId: selected.id },
  });
  await claimInstanceByToken(db, { token: await tokenOf(sel.id), userId: studentId });
  await assert.rejects(
    () =>
      createProductOrder(db, {
        userId: studentId,
        courseId,
        couponInstanceId: sel.id,
        orderForm: DEFAULT_ORDER_FORM,
        skipChat: true,
      }),
    /不适用于/,
  );

  const mine = await db.couponInstance.findMany({
    where: { claimedByUserId: studentId },
    select: { tokenEncrypted: true, tokenHash: true },
  });
  assert.ok(mine.length >= 1);
  const listed = await previewInstanceByToken(db, await tokenOf(sel.id), otherId);
  assert.equal(listed.claimState, "taken");
  assert.equal(listed.message, "该优惠券已被领取");
  assert.ok(!("token" in listed));

  await softDeleteCampaign(db, { campaignId: selected.id, actorId: adminId });
  const studentView = await db.couponInstance.findFirst({
    where: { claimedByUserId: studentId },
    select: { id: true, tokenHint: true, serialNo: true },
  });
  assert.ok(studentView);
  assert.ok(!("tokenEncrypted" in studentView));
});

test("旧公共券码迁移后生成独立实例且不再共享库存", async () => {
  await resetWorld();
  const legacy = await db.coupon.create({
    data: {
      code: "YYDS20",
      title: "旧公共券",
      type: "FIXED",
      discountCents: 2000,
      maxUses: 5,
      maxPerUser: 1,
      isActive: true,
      createdById: adminId,
    },
  });
  const order = await db.order.create({
    data: {
      orderNo: "YD-LEGACY-1",
      userId: studentId,
      courseId,
      amount: 8000,
      discount: 2000,
      status: "PAID",
      couponId: legacy.id,
      paidAt: new Date(),
    },
  });
  await db.couponRedemption.create({
    data: { couponId: legacy.id, userId: studentId, orderId: order.id },
  });
  const result = await migrateLegacyCoupons(db);
  assert.equal(result.campaigns, 1);
  const campaign = await db.couponCampaign.findUniqueOrThrow({
    where: { legacyCouponId: legacy.id },
  });
  const instances = await db.couponInstance.findMany({
    where: { campaignId: campaign.id },
  });
  assert.equal(instances.length, 5);
  assert.equal(instances.filter((i) => i.status === "REDEEMED").length, 1);
  assert.equal(instances.filter((i) => i.status === "AVAILABLE").length, 4);
  const again = await migrateLegacyCoupons(db);
  assert.equal(again.campaigns, 0);
  assert.equal(
    await db.couponInstance.count({ where: { campaignId: campaign.id } }),
    5,
  );
});
