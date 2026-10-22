import type { Request, Response } from "express";
import { WechatImportRateLimiter, type WechatImportRateKind } from "./rate-limit.js";
import { WechatImportError } from "./types.js";
import type { WechatPreviewResponse } from "./types.js";
import { parseWechatArticleInput } from "./url.js";

export function isWechatImportEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.WECHAT_IMPORT_ENABLED?.trim().toLowerCase() ?? "";
  return value !== "0" && value !== "false" && value !== "off" && value !== "no";
}

export interface WechatImportRateIdentity {
  key: string;
  kind: WechatImportRateKind;
}

export function createWechatImportPreviewHandler(options: {
  isEnabled?: () => boolean;
  limiter: WechatImportRateLimiter;
  getRateIdentity: (request: Request) => Promise<WechatImportRateIdentity>;
  preview: (url: string, request: Request) => Promise<WechatPreviewResponse>;
}): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    try {
      const identity = await options.getRateIdentity(request);

      if (identity.kind !== "authenticated") {
        throw new WechatImportError("AUTH_REQUIRED");
      }

      if (!(options.isEnabled ?? isWechatImportEnabled)()) {
        throw new WechatImportError("IMPORT_DISABLED");
      }

      const url = request.body && typeof request.body === "object"
        ? (request.body as { url?: unknown }).url
        : undefined;

      if (typeof url !== "string") {
        throw new WechatImportError("INVALID_URL");
      }

      // Only authenticated accounts can import; invalid URLs do not use quota.
      const parsed = parseWechatArticleInput(url);

      if (!parsed.ok) {
        throw new WechatImportError("INVALID_URL", parsed.message);
      }

      if (!options.limiter.consume(identity.key, identity.kind)) {
        throw new WechatImportError("RATE_LIMITED");
      }

      const result = await options.preview(parsed.url, request);
      response.json(result);
    } catch (error) {
      if (error instanceof WechatImportError) {
        response.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      console.error(
        "[wechat-import] unexpected failure",
        error instanceof Error ? error.name : "unknown",
      );
      const fallback = new WechatImportError("UPSTREAM_ERROR");
      response.status(fallback.status).json({
        error: {
          code: fallback.code,
          message: fallback.message,
        },
      });
    }
  };
}
