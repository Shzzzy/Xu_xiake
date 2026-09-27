export type PackageCode = "single" | "ten" | "thirty";

export type PackageDefinition = {
  code: PackageCode;
  points: number;
  amountCents: number;
  discountLabel: string;
};

/** 点数套餐的唯一价格来源，金额统一使用整数分，避免浮点误差。 */
export const PACKAGE_CATALOG = {
  single: {
    code: "single",
    points: 1,
    amountCents: 99,
    discountLabel: "无门槛",
  },
  ten: {
    code: "ten",
    points: 10,
    amountCents: 941,
    discountLabel: "9.5 折 · 推荐",
  },
  thirty: {
    code: "thirty",
    points: 30,
    amountCents: 2673,
    discountLabel: "9 折",
  },
} as const satisfies Record<PackageCode, PackageDefinition>;

export function resolvePackage(code: PackageCode): PackageDefinition {
  return PACKAGE_CATALOG[code];
}
