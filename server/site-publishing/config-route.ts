import type { Request, Response } from "express";
import type { AuthSession } from "../auth.js";
import type { SitePublishAccountConfiguration } from "../../src/features/site-publishing/model.js";
import {
  InvalidSitePublishConfigurationError,
  parseSitePublishDraft,
  SitePublishConfigurationConflictError,
} from "./configuration.js";

interface SitePublishingConfigurationStore {
  getSitePublishingConfiguration(
    ownerId: string,
  ): Promise<SitePublishAccountConfiguration | null>;
  saveSitePublishingConfiguration(
    ownerId: string,
    draft: unknown,
    expectedUpdatedAt: number | null,
    now?: number,
  ): Promise<SitePublishAccountConfiguration>;
}

export interface SitePublishingConfigHandlerOptions {
  getUser: (
    request: Request,
    response: Response,
  ) => Promise<AuthSession | null>;
  isSameOrigin: (request: Request) => boolean;
  store: SitePublishingConfigurationStore;
}

function setNoStoreHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
}

/**
 * GET/PUT /api/site-publishing/config：网站发布草稿的账号级云端存储。
 * 归属只取签名会话中的账号 ID，请求体中的 ownerId 不会影响读写。
 */
export function createSitePublishingConfigHandlers(
  options: SitePublishingConfigHandlerOptions,
): {
  getConfiguration: (request: Request, response: Response) => Promise<void>;
  putConfiguration: (request: Request, response: Response) => Promise<void>;
} {
  return {
    async getConfiguration(request, response) {
      setNoStoreHeaders(response);

      if (!options.isSameOrigin(request)) {
        response
          .status(403)
          .json({ error: "请从当前便签页面读取网站发布设置。" });
        return;
      }

      const user = await options.getUser(request, response);

      if (!user) {
        return;
      }

      try {
        const configuration =
          await options.store.getSitePublishingConfiguration(user.id);
        response.json(
          configuration
            ? {
                draft: configuration.draft,
                updatedAt: configuration.updatedAt,
              }
            : { draft: null, updatedAt: null },
        );
      } catch {
        response
          .status(500)
          .json({ error: "读取网站发布设置失败，请稍后重试。" });
      }
    },

    async putConfiguration(request, response) {
      setNoStoreHeaders(response);

      if (!options.isSameOrigin(request)) {
        response
          .status(403)
          .json({ error: "请从当前便签页面保存网站发布设置。" });
        return;
      }

      const user = await options.getUser(request, response);

      if (!user) {
        return;
      }

      const body = request.body;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        response
          .status(400)
          .json({ error: "网站发布设置格式不正确，请重新打开发布面板。" });
        return;
      }

      const expectedUpdatedAt = (body as { expectedUpdatedAt?: unknown })
        .expectedUpdatedAt;

      if (
        expectedUpdatedAt !== null &&
        !(
          typeof expectedUpdatedAt === "number" &&
          Number.isSafeInteger(expectedUpdatedAt) &&
          expectedUpdatedAt > 0
        )
      ) {
        response.status(400).json({
          error: "expectedUpdatedAt 必须是正整数或 null。",
        });
        return;
      }

      try {
        const draft = parseSitePublishDraft(
          (body as { draft?: unknown }).draft,
        );
        const configuration =
          await options.store.saveSitePublishingConfiguration(
            user.id,
            draft,
            expectedUpdatedAt,
          );
        response.json({
          draft: configuration.draft,
          updatedAt: configuration.updatedAt,
        });
      } catch (error) {
        if (error instanceof InvalidSitePublishConfigurationError) {
          response.status(400).json({ error: error.message });
          return;
        }

        if (error instanceof SitePublishConfigurationConflictError) {
          response.status(409).json({
            error: error.message,
            updatedAt: error.updatedAt,
          });
          return;
        }

        // 不把磁盘路径、堆栈等内部细节返回给浏览器。
        response
          .status(500)
          .json({ error: "保存网站发布设置失败，请稍后重试。" });
      }
    },
  };
}
