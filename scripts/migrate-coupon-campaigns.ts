import { PrismaClient } from "@prisma/client";
import { migrateLegacyCoupons } from "../packages/shared/src/coupon-campaign-migrate";

async function main() {
  const db = new PrismaClient();
  try {
    const result = await migrateLegacyCoupons(db);
    console.log(
      `[coupon-migrate] coupons=${result.coupons} newCampaigns=${result.campaigns} newInstances=${result.instances}`,
    );
    for (const note of result.notes) {
      console.log(`[coupon-migrate] ${note}`);
    }
  } finally {
    await db.$disconnect();
  }
}

void main();
