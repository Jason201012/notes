import type { WechatImportErrorCode } from "../../src/lib/wechat-import-types.js";

export type {
  WechatImportErrorCode,
  WechatImportImageStats,
  WechatImportWarning,
  WechatImportWarningCode,
  WechatPreviewResponse,
} from "../../src/lib/wechat-import-types.js";

const DEFAULT_MESSAGES: Record<WechatImportErrorCode, string> = {
  INVALID_URL: "请粘贴一条微信公众号文章链接（https://mp.weixin.qq.com/s/...）。",
  AUTH_REQUIRED: "请先登录后再导入公众号文章。",
  IMPORT_DISABLED: "管理员已关闭公众号文章导入。",
  CONTENT_TOO_LARGE: "文章内容过大，无法导入。",
  ARTICLE_UNAVAILABLE: "文章已删除或无法访问，请检查链接。",
  WECHAT_VERIFICATION_REQUIRED:
    "微信要求验证或限制了访问频率。请稍后在浏览器中打开原文，或把正文复制到编辑器。",
  CONTENT_NOT_FOUND: "没有找到可导入的文章正文。",
  RATE_LIMITED: "导入过于频繁，请稍后再试。",
  UPSTREAM_ERROR: "暂时无法从微信获取这篇文章，请稍后重试。",
  FETCH_TIMEOUT: "读取文章超时，请稍后重试。",
};

const STATUS_CODES: Record<WechatImportErrorCode, number> = {
  INVALID_URL: 400,
  AUTH_REQUIRED: 401,
  IMPORT_DISABLED: 403,
  CONTENT_TOO_LARGE: 413,
  ARTICLE_UNAVAILABLE: 422,
  WECHAT_VERIFICATION_REQUIRED: 422,
  CONTENT_NOT_FOUND: 422,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  FETCH_TIMEOUT: 504,
};

export class WechatImportError extends Error {
  readonly code: WechatImportErrorCode;
  readonly status: number;

  constructor(code: WechatImportErrorCode, message = DEFAULT_MESSAGES[code]) {
    super(message);
    this.name = "WechatImportError";
    this.code = code;
    this.status = STATUS_CODES[code];
  }
}

export function isTerminalWechatImportError(error: WechatImportError): boolean {
  return (
    error.code === "INVALID_URL" ||
    error.code === "ARTICLE_UNAVAILABLE" ||
    error.code === "WECHAT_VERIFICATION_REQUIRED" ||
    error.code === "CONTENT_TOO_LARGE" ||
    error.code === "CONTENT_NOT_FOUND" ||
    error.code === "IMPORT_DISABLED" ||
    error.code === "RATE_LIMITED" ||
    error.code === "AUTH_REQUIRED"
  );
}
