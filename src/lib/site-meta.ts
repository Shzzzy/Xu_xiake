/**
 * 全站唯一的站点地址来源。
 *
 * sitemap、robots.txt 与各页 canonical 都依赖这个域名；将来换成自定义域名时，
 * 只需要改这里的 SITE_URL，以及 public/robots.txt 与 public/sitemap.xml 里的绝对地址。
 */
export const SITE_URL = "https://chipper-blini-e3c045.netlify.app";

/** 把站内路径拼成可供搜索引擎使用的绝对地址。 */
export function absoluteUrl(pathname: string): string {
  if (!pathname || pathname === "/") return SITE_URL + "/";
  return SITE_URL + (pathname.startsWith("/") ? pathname : "/" + pathname);
}
