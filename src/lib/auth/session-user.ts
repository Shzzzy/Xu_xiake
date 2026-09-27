import type { UserRole, UserStatus } from "../credits/types.ts";

export type MappedSessionUser = {
  id: string;
  email: string | null;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
};

type SessionUserInput = {
  id: string;
  email?: unknown;
  phone?: unknown;
  role?: unknown;
  status?: unknown;
};

export function mapSessionUser(user: SessionUserInput): MappedSessionUser {
  const rawEmail = typeof user.email === "string" ? user.email : null;
  const email = rawEmail?.toLowerCase().endsWith("@phone.invalid") ? null : rawEmail;
  return {
    id: user.id,
    email,
    phone: typeof user.phone === "string" ? user.phone : null,
    role: user.role === "admin" ? "admin" : "user",
    status: user.status === "disabled" ? "disabled" : "active",
  };
}
