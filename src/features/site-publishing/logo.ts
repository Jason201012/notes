/** 发布网站默认 Logo 与自定义 Logo 的共享约束（前端面板与后端导出都会使用）。 */

export const DEFAULT_SITE_LOGO_PATH =
  "/smartisan/web/smartisan_hammer_footer.png";
export const SITE_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const SITE_LOGO_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/avif,.png,.jpg,.jpeg,.webp,.gif,.avif";

const LOCAL_LOGO_PATH_PATTERN =
  /^\/images\/[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp|avif)$/;
const LOGO_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
]);
const LOGO_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
]);

export interface SiteLogoFile {
  name?: string;
  type?: string;
  size: number;
}

export function isValidSiteLogoPath(value: string): boolean {
  return LOCAL_LOGO_PATH_PATTERN.test(value);
}

/**
 * 规范化网站 Logo 路径。字段缺失代表旧草稿/旧客户端，默认使用锤子图标（空串）。
 * 只接受图片导入接口保存的本机哈希文件，拒绝外部 URL、data URL、查询参数和跨目录路径。
 */
export function normalizeSiteLogoPath(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error("网站 Logo 路径不正确，请重新上传图片。");
  }

  if (value === "") {
    return "";
  }

  if (!isValidSiteLogoPath(value)) {
    throw new Error(
      "网站 Logo 只能使用本机上传的图片（/images/ 路径），不支持外部地址、data URL 或包含 ../ 的路径。",
    );
  }

  return value;
}

/**
 * 上传前先做前端校验，避免把明显不支持或过大的文件发给图片服务。
 * 返回空串代表通过；错误信息可直接展示给用户。
 */
export function validateSiteLogoFile(file: SiteLogoFile): string {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "请选择一张有效的图片文件。";
  }

  if (file.size > SITE_LOGO_MAX_BYTES) {
    return "网站 Logo 图片不能超过 2MB，请换一张更小的图片。";
  }

  const type = (file.type ?? "").split(";")[0].trim().toLowerCase();
  const name = file.name ?? "";
  const extension = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";

  if (type === "image/svg+xml" || extension === "svg") {
    return "网站 Logo 不支持 SVG，请使用 PNG、JPEG、WebP、GIF 或 AVIF 图片。";
  }

  const allowed = type
    ? LOGO_MIME_TYPES.has(type)
    : LOGO_EXTENSIONS.has(extension);

  if (!allowed) {
    return "网站 Logo 仅支持 PNG、JPEG、WebP、GIF 或 AVIF 图片。";
  }

  // 有 MIME 时也容忍浏览器给 AVIF/旧 JPEG 的空扩展名，但明显不匹配的扩展名仍拒绝。
  if (
    type &&
    extension &&
    extension !== "jpeg" &&
    extension !== "jpg" &&
    !LOGO_EXTENSIONS.has(extension)
  ) {
    return "网站 Logo 仅支持 PNG、JPEG、WebP、GIF 或 AVIF 图片。";
  }

  return "";
}
