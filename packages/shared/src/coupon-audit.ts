import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export async function writeCouponAudit(
  db: Db,
  input: {
    actorId: string;
    action: string;
    campaignId?: string | null;
    instanceId?: string | null;
    detail?: string;
  },
) {
  await db.couponAuditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      campaignId: input.campaignId || undefined,
      instanceId: input.instanceId || undefined,
      detail: (input.detail || "").slice(0, 500),
    },
  });
}
