import { db } from "../db.js";

// CALIBRATION: CAL-SQLI-01
// The `email` field reaches the query as an interpolated string, so a quote in
// the request changes the statement.
export async function login(email: string): Promise<unknown> {
  return db.query(`SELECT * FROM users WHERE email = '${email}'`);
}
