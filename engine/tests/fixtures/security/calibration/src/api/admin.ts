import { db } from "../db.js";

// CALIBRATION: CAL-AUTHZ-01
// The route deletes any account named in the path; nothing checks that the
// caller is an administrator.
export async function deleteAccount(accountId: string): Promise<void> {
  await db.query("DELETE FROM accounts WHERE id = $1", [accountId]);
}
