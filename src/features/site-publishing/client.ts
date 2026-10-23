import type { NoteDocument } from "../../types/app.js";
import {
  buildSiteExportRequest,
  type SiteExportRequest,
  type SitePublishDraft,
} from "./model.js";

export const SITE_EXPORT_ENDPOINT = "/api/site-publishing/export";
export const SITE_EXPORT_FILENAME = "notes-hugo-site.zip";

export class SitePublishExportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SitePublishExportError";
    this.status = status;
  }
}

export interface SiteExportArtifact {
  blob: Blob;
  filename: string;
}

export interface SiteExportRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface SiteExportDownloadEnvironment {
  document?: Pick<Document, "body" | "createElement">;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

function getFetch(options: SiteExportRequestOptions): typeof fetch | null {
  if (options.fetchImpl) {
    return options.fetchImpl;
  }

  return typeof fetch === "function" ? fetch : null;
}

function readDispositionFilename(header: string | null): string | null {
  if (!header) {
    return null;
  }

  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim()) || null;
    } catch {
      // 继续尝试 ASCII filename。
    }
  }

  const ascii = /filename="?([^";]+)"?/i.exec(header);
  return ascii?.[1]?.trim() || null;
}

async function readErrorPayload(response: Response): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        for (const key of ["error", "message"]) {
          if (typeof record[key] === "string" && record[key].trim()) {
            return record[key].trim();
          }
        }
      }
      return "";
    }

    const text = (await response.text()).trim();
    return text.length > 0 && text.length <= 300 ? text : "";
  } catch {
    return "";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function requestSiteExport(
  request: SiteExportRequest,
  options: SiteExportRequestOptions = {},
): Promise<SiteExportArtifact> {
  const fetchImpl = getFetch(options);

  if (!fetchImpl) {
    throw new SitePublishExportError("当前环境不支持下载网站压缩包。");
  }

  let response: Response;

  try {
    response = await fetchImpl(SITE_EXPORT_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/zip, application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new SitePublishExportError(
      "无法连接网站导出服务，请确认后端已启动后重试。",
    );
  }

  if (!response.ok) {
    const message = await readErrorPayload(response);
    throw new SitePublishExportError(
      message || `生成网站失败（${response.status}）。`,
      response.status,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isZip =
    contentType.includes("application/zip") ||
    contentType.includes("application/octet-stream");

  if (!isZip) {
    const message = await readErrorPayload(response);
    throw new SitePublishExportError(
      message || "网站导出服务返回的不是 ZIP 压缩包，请稍后重试。",
      response.status,
    );
  }

  const blob = await response.blob();

  if (!blob.size) {
    throw new SitePublishExportError("生成的网站压缩包为空，请稍后重试。");
  }

  return {
    blob,
    filename:
      readDispositionFilename(response.headers.get("content-disposition")) ??
      SITE_EXPORT_FILENAME,
  };
}

/**
 * 先做本地草稿校验，再请求 /api/site-publishing/export。
 * 校验失败不会发出网络请求，错误信息直接来自 model 的 normalize/validate。
 */
export async function exportSitePublishSite(
  draft: SitePublishDraft,
  notes: NoteDocument[],
  options: SiteExportRequestOptions = {},
): Promise<SiteExportArtifact> {
  const request = buildSiteExportRequest(draft, notes);
  return requestSiteExport(request, options);
}

/** 创建临时下载链接，触发浏览器下载，并立即释放 object URL。 */
export function downloadSiteExport(
  artifact: SiteExportArtifact,
  environment: SiteExportDownloadEnvironment = {},
): string {
  const ownerDocument =
    environment.document ??
    (typeof document === "undefined" ? null : document);
  const createObjectURL =
    environment.createObjectURL ??
    (typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
      ? URL.createObjectURL.bind(URL)
      : null);
  const revokeObjectURL =
    environment.revokeObjectURL ??
    (typeof URL !== "undefined" &&
    typeof URL.revokeObjectURL === "function"
      ? URL.revokeObjectURL.bind(URL)
      : null);

  if (!ownerDocument || !createObjectURL) {
    throw new SitePublishExportError(
      "当前浏览器不支持自动下载，请更换浏览器后重试。",
    );
  }

  const filename = artifact.filename || SITE_EXPORT_FILENAME;
  const url = createObjectURL(artifact.blob);
  const anchor = ownerDocument.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";

  try {
    ownerDocument.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    revokeObjectURL?.(url);
  }

  return url;
}
