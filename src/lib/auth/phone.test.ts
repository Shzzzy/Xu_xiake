import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidPhone,
  maskPhone,
  normalizePhone,
  phoneToInternalEmail,
} from "./phone.ts";

test("规范化中国大陆手机号", () => {
  assert.equal(normalizePhone("+86 138-0013-8000"), "13800138000");
  assert.equal(normalizePhone("138 0013 8000"), "13800138000");
  assert.equal(normalizePhone("8613800138000"), "13800138000");
});

test("校验中国大陆手机号格式", () => {
  assert.equal(isValidPhone("12345678901"), false);
  assert.equal(isValidPhone("1380013800"), false);
  assert.equal(isValidPhone("12800138000"), false);
  assert.equal(isValidPhone("13800138000"), true);
});

test("生成内部邮箱并脱敏展示手机号", () => {
  assert.equal(
    phoneToInternalEmail("13800138000"),
    "13800138000@phone.invalid",
  );
  assert.equal(maskPhone("13800138000"), "138****8000");
});

test("无效手机号保持规范化但不脱敏", () => {
  assert.equal(maskPhone("123-456"), "123456");
});
