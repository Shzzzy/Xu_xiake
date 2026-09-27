import type { UserRole, UserStatus } from "../credits/types.ts";
import { isValidPhone, normalizePhone, phoneToInternalEmail } from "./phone.ts";

export type PublicAccount = {
  id: string;
  phone: string;
  role: UserRole;
  status: UserStatus;
};

export type PublicAccountRecord = PublicAccount;

type PublicAccountAuth = {
  api: {
    signUpEmail(input: {
      body: {
        email: string;
        password: string;
        name: string;
        username: string;
      };
    }): Promise<{ user: { id: string } }>;
  };
};

type PublicAccountQuery = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

function validateRegistration(input: { phone: string; password: string }) {
  const phone = normalizePhone(input.phone);
  if (!isValidPhone(phone)) throw new Error("手机号格式不正确");
  if (input.password.length < 8) throw new Error("密码至少需要 8 位");
  if (input.password.length > 128) throw new Error("密码不能超过 128 位");
  return phone;
}

/**
 * 使用指定 Better Auth 实例创建公开手机号账号，便于真实集成测试复用。
 * 内部邮箱仅用于复用邮箱密码能力，不对外展示。
 */
export async function createPublicAccountRecordWithAuth(
  authService: PublicAccountAuth,
  input: { phone: string; password: string },
): Promise<PublicAccountRecord> {
  const phone = validateRegistration(input);
  const result = await authService.api.signUpEmail({
    body: {
      email: phoneToInternalEmail(phone),
      password: input.password,
      name: phone,
      username: phone,
    },
  });

  return {
    id: result.user.id,
    phone,
    role: "user",
    status: "active",
  };
}

export async function createPublicAccountRecord(input: {
  phone: string;
  password: string;
}): Promise<PublicAccountRecord> {
  const { auth } = await import("./server.ts");
  return createPublicAccountRecordWithAuth(auth, input);
}

export async function registerPublicAccount(input: {
  phone: string;
  password: string;
}): Promise<{ userId: string }> {
  const account = await createPublicAccountRecord(input);
  return { userId: account.id };
}

export async function getPublicAccountWithQuery(
  sql: PublicAccountQuery,
  userId: string,
): Promise<PublicAccount | null> {
  const rows = await sql.query<{
    id: string;
    phone: string | null;
    role: UserRole;
    status: UserStatus;
  }>(
    'select id, phone, role, status from "user" where id = $1',
    [userId],
  );
  const row = rows[0];
  if (!row?.phone) return null;
  return { id: row.id, phone: row.phone, role: row.role, status: row.status };
}

export async function getPublicAccount(userId: string): Promise<PublicAccount | null> {
  const { getSql } = await import("../db.ts");
  const sql = await getSql();
  return getPublicAccountWithQuery(sql, userId);
}
