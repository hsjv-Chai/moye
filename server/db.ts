import { Pool, type PoolClient } from "pg";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { User } from "../shared/collab";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
export async function migrate() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY,username text UNIQUE NOT NULL,display_name text NOT NULL,password text NOT NULL,admin boolean NOT NULL DEFAULT false,active boolean NOT NULL DEFAULT true,must_change boolean NOT NULL DEFAULT true); CREATE TABLE IF NOT EXISTS sessions(token text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL); CREATE TABLE IF NOT EXISTS books(id uuid PRIMARY KEY,book jsonb NOT NULL,state bytea NOT NULL,epoch integer NOT NULL DEFAULT 1,revision integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now()); CREATE TABLE IF NOT EXISTS members(book_id uuid REFERENCES books(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id) ON DELETE CASCADE,role text NOT NULL CHECK(role IN ('editor','reader')),PRIMARY KEY(book_id,user_id)); CREATE TABLE IF NOT EXISTS updates(book_id uuid REFERENCES books(id) ON DELETE CASCADE,op_id uuid NOT NULL,user_id uuid REFERENCES users(id),epoch integer NOT NULL,data bytea NOT NULL,created_at timestamptz DEFAULT now(),PRIMARY KEY(book_id,op_id)); CREATE TABLE IF NOT EXISTS versions(id uuid PRIMARY KEY,book_id uuid REFERENCES books(id) ON DELETE CASCADE,book jsonb NOT NULL,reason text NOT NULL,created_by uuid REFERENCES users(id),created_at timestamptz DEFAULT now()); CREATE TABLE IF NOT EXISTS audit(id bigserial PRIMARY KEY,user_id uuid,action text NOT NULL,book_id uuid,created_at timestamptz DEFAULT now()); CREATE INDEX IF NOT EXISTS versions_book ON versions(book_id,created_at DESC);`,
  );
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password: string, hash: string) {
  const [salt, value] = hash.split(":");
  const key = scryptSync(password, salt, 64);
  return (
    value?.length === 128 && timingSafeEqual(key, Buffer.from(value, "hex"))
  );
}
export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function publicUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    admin: row.admin,
    active: row.active,
    mustChangePassword: row.must_change,
  };
}
export async function transaction<T>(fn: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
