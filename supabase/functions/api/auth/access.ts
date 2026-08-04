import {
  BUSINESS_SCOPED_ENTITIES,
  DEFAULT_BUSINESSES,
  DEFAULT_BUSINESS_OWNERS,
  bootstrapBusinessIds,
  businessIdOf,
  normalizeScope,
} from "../rules.js";
import { readAll, writeRow } from "../db/repositories.ts";
import type { Rec } from "../types.ts";

export async function ensureCoreData() {
  const [employees, businesses, memberships, businessOwners] = await Promise.all([
    readAll("employees"), readAll("businesses"), readAll("memberships"), readAll("businessOwners"),
  ]);
  for (const business of DEFAULT_BUSINESSES) {
    if (!businesses.some((x) => x.id === business.id)) {
      await writeRow("businesses", { ...business, created: Date.now(), updated: Date.now() });
    }
  }
  for (const owner of DEFAULT_BUSINESS_OWNERS) {
    if (!businessOwners.some((x) => businessIdOf(x) === owner.businessId && x.ownerId === owner.ownerId)) {
      await writeRow("businessOwners", { ...owner, created: Date.now(), updated: Date.now() });
    }
  }
  const allBusinesses = [...businesses];
  for (const fallback of DEFAULT_BUSINESSES) {
    if (!allBusinesses.some((business) => business.id === fallback.id)) allBusinesses.push(fallback as Rec);
  }
  for (const employee of employees) {
    const globalAdmin = employee.active !== false && employee.role === "admin";
    const businessIds = bootstrapBusinessIds(employee, allBusinesses);
    for (const businessId of businessIds) {
      const existing = memberships.find((membership) => membership.employeeId === employee.id && businessIdOf(membership) === businessId);
      if (!existing) {
        await writeRow("memberships", {
          id: `membership-${businessId}-${employee.id}`, businessId, unit: businessId,
          employeeId: employee.id, role: globalAdmin ? "owner" : "staff",
          active: employee.active !== false, created: Date.now(), updated: Date.now(),
        });
      } else if (globalAdmin && (existing.active === false || existing.role !== "owner")) {
        await writeRow("memberships", { ...existing, businessId, unit: businessId, role: "owner", active: true, updated: Date.now() });
      }
    }
  }
  for (const entity of BUSINESS_SCOPED_ENTITIES) {
    const records = await readAll(entity);
    for (const record of records) {
      const normalized = normalizeScope(record);
      if ((!record.businessId || !record.unit) && normalized) {
        normalized.updated = normalized.updated || Date.now();
        await writeRow(entity, normalized as Rec);
      }
    }
  }
}

export async function findUser(token: unknown): Promise<Rec | null> {
  if (!token) return null;
  const users = await readAll("employees");
  return users.find((u) => String(u.code) === String(token) && u.active) ?? null;
}
