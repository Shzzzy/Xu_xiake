import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { isValidPhone, normalizePhone, phoneToInternalEmail } from "./phone.ts";

type SignupUser = {
  email?: string | null;
  username?: string | null;
  displayUsername?: string | null;
  phone?: string | null;
  [key: string]: unknown;
};

type SignupContext = {
  path?: string;
  body?: unknown;
  context: {
    session?: {
      user?: {
        email?: unknown;
      };
    } | null;
  } | null;
} | null;

function bodyRecord(context: SignupContext): Record<string, unknown> {
  const body = context?.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function rejectSignup(message: string): never {
  throw APIError.from("BAD_REQUEST", {
    code: "INVALID_PHONE_SIGNUP",
    message,
  });
}

function rejectIdentityUpdate(): never {
  throw APIError.from("BAD_REQUEST", {
    code: "IMMUTABLE_PHONE_IDENTITY",
    message: "手机号、用户名和内部邮箱不能通过公开更新接口修改",
  });
}

/**
 * 公开邮箱注册入口只允许手机号账号使用，并禁止公开更新接口修改账号身份字段。
 * OAuth 等其他用户创建路径不带 `/sign-up/email`，因此不会被拦截。
 */
export function createPhoneSignupGuard(): NonNullable<BetterAuthOptions["databaseHooks"]> {
  return {
    user: {
      create: {
        before: async (user: SignupUser, context: SignupContext) => {
          if (context?.path !== "/sign-up/email") return;

          const body = bodyRecord(context);
          const bodyUsername = typeof body.username === "string" ? normalizePhone(body.username) : "";
          const username = typeof user.username === "string" ? normalizePhone(user.username) : "";
          const phone = bodyUsername || username;

          if (!isValidPhone(phone)) {
            rejectSignup("仅支持使用合法的大陆手机号注册");
          }
          if (username && username !== phone) {
            rejectSignup("手机号参数不一致，请重新填写");
          }
          if (!bodyUsername || bodyUsername !== phone) {
            rejectSignup("注册请求缺少合法手机号");
          }

          const expectedEmail = phoneToInternalEmail(phone).toLowerCase();
          const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
          if (email !== expectedEmail) {
            rejectSignup("注册邮箱必须与手机号一致");
          }

          const submittedPhone = typeof user.phone === "string" ? normalizePhone(user.phone) : "";
          if (submittedPhone && submittedPhone !== phone) {
            rejectSignup("注册手机号与账号信息不一致");
          }

          return {
            data: {
              ...user,
              email,
              username: phone,
              displayUsername: phone,
              phone,
            },
          };
        },
      },
      update: {
        before: async (user: SignupUser, context: SignupContext) => {
          if (context?.path !== "/update-user") return;

          const body = bodyRecord(context);
          const protectedField = ["username", "displayUsername", "phone", "email"].find((field) =>
            Object.prototype.hasOwnProperty.call(body, field),
          );
          if (protectedField || typeof user.username === "string" || typeof user.phone === "string") {
            rejectIdentityUpdate();
          }

          const currentEmail = context.context?.session?.user?.email;
          if (
            typeof user.email === "string" &&
            typeof currentEmail === "string" &&
            user.email !== currentEmail &&
            currentEmail.toLowerCase().endsWith("@phone.invalid")
          ) {
            rejectIdentityUpdate();
          }
        },
      },
    },
  };
}
