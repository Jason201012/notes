import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type Request } from "express";
import test from "node:test";
import { WechatImportRateLimiter } from "../../server/wechat-import/rate-limit.js";
import { createWechatImportPreviewHandler } from "../../server/wechat-import/route.js";
import { WechatImportError } from "../../server/wechat-import/types.js";
import type { WechatPreviewResponse } from "../../server/wechat-import/types.js";

const preview: WechatPreviewResponse = {
  title: "示例文章标题",
  accountName: "示例公众号",
  author: null,
  publishedAt: null,
  sourceUrl: "https://mp.weixin.qq.com/s/example-id",
  markdown: "# 示例文章标题\n\n正文",
  images: { total: 0, imported: 0, failed: 0, reused: 0 },
  warnings: [],
  fetchMethod: "http",
};

async function withImportServer(
  handler: ReturnType<typeof createWechatImportPreviewHandler>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post("/api/import/wechat/preview", handler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法分配导入 API 测试端口");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function handler(options: {
  authenticated?: boolean;
  enabled?: boolean;
  limit?: number;
  preview?: (url: string, request: Request) => Promise<WechatPreviewResponse>;
}) {
  const calls: string[] = [];
  const route = createWechatImportPreviewHandler({
    isEnabled: () => options.enabled ?? true,
    limiter: new WechatImportRateLimiter({
      anonymousLimit: options.limit ?? 10,
      authenticatedLimit: options.limit ?? 10,
      windowMs: 60_000,
    }),
    getRateIdentity: async () => options.authenticated === false
      ? { key: "anon:test", kind: "anonymous" }
      : { key: "user:test", kind: "authenticated" },
    preview: async (url, request) => {
      calls.push(url);
      if (options.preview) {
        return options.preview(url, request);
      }
      return preview;
    },
  });
  return { calls, route };
}

async function postImport(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/import/wechat/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("导入 API 无条件要求登录，匿名请求不抓取且不消耗额度", async () => {
  let consumed = 0;
  let fetched = 0;
  const limiter = new WechatImportRateLimiter();
  limiter.consume = () => { consumed += 1; return true; };
  const route = createWechatImportPreviewHandler({
    isEnabled: () => false,
    limiter,
    getRateIdentity: async () => ({ key: "anon:test", kind: "anonymous" }),
    preview: async () => { fetched += 1; return preview; },
  });

  await withImportServer(route, async (baseUrl) => {
    for (const body of [{ url: preview.sourceUrl }, { url: "invalid" }, {}]) {
      const response = await postImport(baseUrl, body);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: { code: "AUTH_REQUIRED", message: "请先登录后再导入公众号文章。" },
      });
    }
  });
  assert.equal(consumed, 0);
  assert.equal(fetched, 0);
});

test("导入 API 对关闭、无效链接和上游错误返回统一结构", async () => {
  const disabled = handler({ enabled: false });
  await withImportServer(disabled.route, async (baseUrl) => {
    const response = await postImport(baseUrl, { url: "https://mp.weixin.qq.com/s/example-id" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: {
        code: "IMPORT_DISABLED",
        message: "管理员已关闭公众号文章导入。",
      },
    });
  });
  assert.deepEqual(disabled.calls, []);

  const invalid = handler({});
  await withImportServer(invalid.route, async (baseUrl) => {
    const response = await postImport(baseUrl, { url: "https://evil.example/s/example-id" });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INVALID_URL");
    assert.match(body.error.message, /mp\.weixin\.qq\.com/);

    const multiple = await postImport(baseUrl, {
      url: "https://mp.weixin.qq.com/s/one https://mp.weixin.qq.com/s/two",
    });
    assert.equal(multiple.status, 400);
    assert.match(JSON.stringify(await multiple.json()), /多条/);
  });
  assert.deepEqual(invalid.calls, []);

  const failed = handler({
    preview: async () => {
      throw new WechatImportError("ARTICLE_UNAVAILABLE");
    },
  });
  await withImportServer(failed.route, async (baseUrl) => {
    const response = await postImport(baseUrl, { url: "https://mp.weixin.qq.com/s/example-id" });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "ARTICLE_UNAVAILABLE");
  });

  const crashed = handler({
    preview: async () => {
      throw new Error("stack /tmp/playwright/profile secret");
    },
  });
  await withImportServer(crashed.route, async (baseUrl) => {
    const response = await postImport(baseUrl, { url: "https://mp.weixin.qq.com/s/example-id" });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.doesNotMatch(body, /playwright|secret/);
    assert.match(body, /UPSTREAM_ERROR/);
  });
});

test("导入 API 成功时不写工作区，超过频率后返回 429", async () => {
  const succeeded = handler({});
  await withImportServer(succeeded.route, async (baseUrl) => {
    const response = await postImport(baseUrl, { url: "https://mp.weixin.qq.com/s/example-id" });
    assert.equal(response.status, 200);
    const body = await response.json() as WechatPreviewResponse;
    assert.equal(body.title, "示例文章标题");
    assert.equal(body.markdown.includes("正文"), true);
    assert.equal("notes" in (body as object), false);
    assert.equal("workspace" in (body as object), false);
  });
  assert.deepEqual(succeeded.calls, ["https://mp.weixin.qq.com/s/example-id"]);

  const limited = handler({ limit: 1 });
  await withImportServer(limited.route, async (baseUrl) => {
    const first = await postImport(baseUrl, { url: "https://mp.weixin.qq.com/s/example-id" });
    const second = await postImport(baseUrl, { url: "https://mp.weixin.qq.com/s/example-id" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal((await second.json() as { error: { code: string } }).error.code, "RATE_LIMITED");
  });
  assert.equal(limited.calls.length, 1);
});
