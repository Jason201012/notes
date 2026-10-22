export type WechatImportWarningCode =
  | "IMAGE_DOWNLOAD_FAILED"
  | "UNSUPPORTED_EMBED"
  | "PUBLISH_TIME_UNKNOWN"
  | "CONTENT_SIMPLIFIED"
  | "IMAGE_LIMIT_REACHED";

export interface WechatImportWarning {
  code: WechatImportWarningCode;
  message: string;
  sourceUrl?: string;
}

export interface WechatImportImageStats {
  total: number;
  imported: number;
  failed: number;
  reused: number;
}

export interface WechatPreviewResponse {
  title: string;
  accountName: string | null;
  author: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  markdown: string;
  images: WechatImportImageStats;
  warnings: WechatImportWarning[];
  fetchMethod: "http" | "playwright";
}

export type WechatImportErrorCode =
  | "INVALID_URL"
  | "AUTH_REQUIRED"
  | "IMPORT_DISABLED"
  | "CONTENT_TOO_LARGE"
  | "ARTICLE_UNAVAILABLE"
  | "WECHAT_VERIFICATION_REQUIRED"
  | "CONTENT_NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "FETCH_TIMEOUT";
