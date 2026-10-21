/** Separate silent client: SDK errors must not log SQL, credentials or payloads. */
import { PrismaClient } from "@prisma/client";
const state = globalThis as unknown as { cmsDeliveryDb?: InstanceType<typeof PrismaClient> };
export function getDeliveryDb() {
  if (typeof window !== "undefined") throw new Error("CMS delivery unavailable.");
  return state.cmsDeliveryDb ??= new PrismaClient({ log: [] });
}