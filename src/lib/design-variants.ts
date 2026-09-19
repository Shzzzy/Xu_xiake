export type DesignVariant = "scroll" | "atlas" | "journal";

export type DesignVariantMeta = {
  id: DesignVariant;
  index: string;
  name: string;
  subtitle: string;
  description: string;
};

export const designVariants: DesignVariantMeta[] = [
  {
    id: "scroll",
    index: "甲",
    name: "山水卷",
    subtitle: "SCENIC SCROLL",
    description: "米纸、墨线、青绿与印章，像一卷会随日期展开的行旅图。",
  },
  {
    id: "atlas",
    index: "乙",
    name: "舆图志",
    subtitle: "FIELD ATLAS",
    description: "深色地形图与坐标标尺，把每日路线当作一张可操作的野外地图。",
  },
  {
    id: "journal",
    index: "丙",
    name: "行旅笺",
    subtitle: "TRAVEL JOURNAL",
    description: "现代编辑排版与票签细节，让计划像一本轻盈的私人旅行刊物。",
  },
];

export function isDesignVariant(value: string | null | undefined): value is DesignVariant {
  return value === "scroll" || value === "atlas" || value === "journal";
}
