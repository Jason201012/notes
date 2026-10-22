import type { WechatImportErrorCode, WechatPreviewResponse } from "./wechat-import-types.js";
import { parseWechatArticleInput } from "./wechat-article-url.js";

export type { WechatPreviewResponse, WechatImportWarning } from "./wechat-import-types.js";

export class WechatImportRequestError extends Error {
  readonly code: WechatImportErrorCode | "UNKNOWN";

  constructor(message: string, code: WechatImportErrorCode | "UNKNOWN" = "UNKNOWN") {
    super(message);
    this.name = "WechatImportRequestError";
    this.code = code;
  }
}

export function rejectionForWechatImportInput(input: string): string | null {
  const parsed = parseWechatArticleInput(input);
  return parsed.ok ? null : parsed.message;
}

export function countLiveNotesWithSource(
  notes: Array<{ markdown: string; deletedAt: number | null }>,
  sourceUrl: string,
): number {
  if (!sourceUrl) {
    return 0;
  }

  return notes.filter(
    (note) => note.deletedAt == null && note.markdown.includes(sourceUrl),
  ).length;
}

export interface WechatImportDialogState {
  status: "idle" | "loading" | "preview" | "error" | "creating";
  url: string;
  requestId: number;
  result: WechatPreviewResponse | null;
  errorMessage: string;
}

export type WechatImportDialogAction =
  | { type: "edit"; url: string }
  | { type: "submit"; url: string }
  | { type: "succeed"; requestId: number; result: WechatPreviewResponse }
  | { type: "fail"; requestId: number; message: string }
  | { type: "fail-local"; message: string }
  | { type: "revise" }
  | { type: "create" };

export function createInitialWechatImportState(url = ""): WechatImportDialogState {
  return {
    status: "idle",
    url,
    requestId: 0,
    result: null,
    errorMessage: "",
  };
}

export function wechatImportDialogReducer(
  state: WechatImportDialogState,
  action: WechatImportDialogAction,
): WechatImportDialogState {
  switch (action.type) {
    case "edit":
      if (state.status === "loading" || state.status === "creating") {
        return state;
      }

      return {
        ...state,
        url: action.url,
      };
    case "submit":
      if (state.status === "loading" || state.status === "creating") {
        return state;
      }

      return {
        ...state,
        status: "loading",
        url: action.url,
        requestId: state.requestId + 1,
        result: null,
        errorMessage: "",
      };
    case "succeed":
      if (state.status !== "loading" || state.requestId !== action.requestId) {
        return state;
      }

      return {
        ...state,
        status: "preview",
        result: action.result,
        errorMessage: "",
      };
    case "fail":
      if (state.status !== "loading" || state.requestId !== action.requestId) {
        return state;
      }

      return {
        ...state,
        status: "error",
        result: null,
        errorMessage: action.message,
      };
    case "fail-local":
      if (state.status === "loading" || state.status === "creating") {
        return state;
      }

      return {
        ...state,
        status: "error",
        result: null,
        errorMessage: action.message,
      };
    case "revise":
      if (state.status === "loading" || state.status === "creating") {
        return state;
      }

      return {
        ...state,
        status: "idle",
        result: null,
        errorMessage: "",
      };
    case "create":
      if (state.status !== "preview" || !state.result?.markdown.trim()) {
        return state;
      }

      return {
        ...state,
        status: "creating",
      };
    default:
      return state;
  }
}

export function beginWechatNoteCreation(
  state: WechatImportDialogState,
  alreadyCreating: boolean,
): { markdown: string } | null {
  if (alreadyCreating || state.status !== "preview" || !state.result?.markdown.trim()) {
    return null;
  }

  return { markdown: state.result.markdown };
}

function isPreviewResponse(value: unknown): value is WechatPreviewResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const preview = value as Partial<WechatPreviewResponse>;
  return (
    typeof preview.title === "string" &&
    typeof preview.markdown === "string" &&
    typeof preview.sourceUrl === "string" &&
    (preview.fetchMethod === "http" || preview.fetchMethod === "playwright") &&
    Array.isArray(preview.warnings) &&
    Boolean(preview.images) &&
    typeof preview.images?.total === "number"
  );
}

function errorMessageFromPayload(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;

    if (typeof error === "string" && error.trim()) {
      return error;
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }

  if (status === 401) {
    return "请先登录后再导入公众号文章。";
  }

  if (status === 429) {
    return "导入过于频繁，请稍后再试。";
  }

  return "导入失败，请稍后重试。";
}

function errorCodeFromPayload(payload: unknown): WechatImportErrorCode | "UNKNOWN" {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return "UNKNOWN";
  }

  const error = (payload as { error?: unknown }).error;

  if (!error || typeof error !== "object" || !("code" in error)) {
    return "UNKNOWN";
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? (code as WechatImportErrorCode) : "UNKNOWN";
}

export async function requestWechatImportPreview(
  url: string,
  signal?: AbortSignal,
): Promise<WechatPreviewResponse> {
  let response: Response;

  try {
    response = await fetch("/api/import/wechat/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }

    throw new WechatImportRequestError("网络异常，请稍后重试。", "UPSTREAM_ERROR");
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new WechatImportRequestError(
      errorMessageFromPayload(payload, response.status),
      errorCodeFromPayload(payload),
    );
  }

  if (!isPreviewResponse(payload)) {
    throw new WechatImportRequestError("导入结果无法识别，请稍后重试。");
  }

  return payload;
}

export function wechatImportErrorMessage(error: unknown): string {
  if (error instanceof WechatImportRequestError) {
    return error.message;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return "";
  }

  return "导入失败，请稍后重试。";
}
