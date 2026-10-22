import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseWechatArticleInput } from "../../src/lib/wechat-article-url.js";
import { convertWechatDocument, previewWechatArticle } from "../../server/wechat-import/service.js";
import { parseWechatPublishedAt, interpretWechatHtml } from "../../server/wechat-import/extract.js";
import { createWechatPageFetcher, type WechatBrowserRoute } from "../../server/wechat-import/fetch.js";
import {
  createWechatImageDownloader,
  localizeWechatImages,
  sniffWechatImageExtension,
} from "../../server/wechat-import/images.js";
import {
  decideWechatResourceRequest,
  isBlockedIpAddress,
} from "../../server/wechat-import/network.js";
import { AsyncSemaphore, WechatImportRateLimiter } from "../../server/wechat-import/rate-limit.js";
import { isWechatImportEnabled } from "../../server/wechat-import/route.js";
import { WechatImportError } from "../../server/wechat-import/types.js";
import type { WechatImageBytes } from "../../server/wechat-import/images.js";

const sourceUrl = "https://mp.weixin.qq.com/s/example-id";
const publicLookup = async () => ["203.0.113.10"];

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/wechat-import/${name}`, import.meta.url), "utf8");
}

function png(seed: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(seed),
  ]);
}

function memoryImages() {
  const downloads: string[] = [];
  const files = new Map<string, string>();

  return {
    downloads,
    async downloadImage(url: string): Promise<WechatImageBytes> {
      downloads.push(url);

      if (url.endsWith(".gif")) {
        return {
          buffer: Buffer.concat([Buffer.from("GIF89a"), Buffer.from(url)]),
          contentType: "image/gif",
        };
      }

      if (url.includes("same-bytes")) {
        return { buffer: png("same-bytes"), contentType: "image/png" };
      }

      if (url.includes("svg")) {
        return {
          buffer: Buffer.from("<svg><script>alert(1)</script></svg>"),
          contentType: "image/svg+xml",
        };
      }

      if (url.includes("fail.png")) {
        throw new Error("download failed");
      }

      return { buffer: png(url), contentType: "image/png" };
    },
    async persistImage(image: WechatImageBytes) {
      const extension = sniffWechatImageExtension(image.buffer);

      if (!extension) {
        throw new Error("unsupported");
      }

      const hash = createHash("sha256").update(image.buffer).digest("hex");
      const path = `/images/${hash}.${extension}`;
      const reused = files.has(hash);
      files.set(hash, path);
      return { path, reused };
    },
  };
}

const untouchedImages = {
  async downloadImage(): Promise<WechatImageBytes> {
    throw new Error("不应下载图片");
  },
  async persistImage(): Promise<{ path: string; reused: boolean }> {
    throw new Error("不应保存图片");
  },
};

test("微信文章 URL 只保留文章身份并拒绝仿冒地址", () => {
  assert.deepEqual(
    parseWechatArticleInput(
      "  分享 https://mp.weixin.qq.com/s?__biz=MzA&amp;mid=1&idx=1&sn=abc&scene=21#rd  ",
    ),
    {
      ok: true,
      url: "https://mp.weixin.qq.com/s?__biz=MzA&mid=1&idx=1&sn=abc&scene=21",
    },
  );
  assert.equal(
    parseWechatArticleInput(
      "同一篇 https://mp.weixin.qq.com/s/example-id 再贴一次 https://mp.weixin.qq.com/s/example-id",
    ).ok,
    true,
  );
  assert.match(
    parseWechatArticleInput(
      "https://mp.weixin.qq.com/s/one 和 https://mp.weixin.qq.com/s/two",
    ).ok ? "" : (parseWechatArticleInput("https://mp.weixin.qq.com/s/one 和 https://mp.weixin.qq.com/s/two") as { message: string }).message,
    /多条/,
  );

  for (const input of [
    "http://mp.weixin.qq.com/s/example-id",
    "https://user:pass@mp.weixin.qq.com/s/example-id",
    "https://mp.weixin.qq.com.evil.example/s/example-id",
    "https://evil.example/mp.weixin.qq.com/s/example-id",
    "javascript:alert(1)",
    "http://127.0.0.1/s/example-id",
    "http://localhost/s/example-id",
    "//evil.example",
    "https://mp.weixin.qq.com/mp/profile?scene=1",
  ]) {
    assert.equal(parseWechatArticleInput(input).ok, false, input);
  }
});

test("发布时间解析区分秒和毫秒，缺失时不编造日期", () => {
  const seconds = parseWechatPublishedAt("1760668800");
  const millis = parseWechatPublishedAt("1760668800000");
  assert.equal(seconds?.iso, millis?.iso);
  assert.match(parseWechatPublishedAt("2026年10月17日 08:00")?.display ?? "", /2026-10-17 08:00/);
  assert.equal(parseWechatPublishedAt("不是时间"), null);
});

test("基础文章转为可编辑 Markdown，不带走页脚", async () => {
  const result = await convertWechatDocument(fixture("basic.html"), sourceUrl, untouchedImages, "http");

  assert.equal(result.title, "示例文章标题");
  assert.equal(result.accountName, "示例公众号");
  assert.equal(result.author, "张三");
  assert.equal(result.publishedAt, "2026-10-17T08:00:00+08:00");
  assert.equal(result.fetchMethod, "http");
  assert.match(result.markdown, /^# 示例文章标题/);
  assert.match(result.markdown, /> 来源：\[示例公众号\]\(https:\/\/mp\.weixin\.qq\.com\/s\/example-id\)/);
  assert.match(result.markdown, /> 发布时间：2026-10-17 08:00/);
  assert.match(result.markdown, /\*\*加粗\*\*/);
  assert.match(result.markdown, /\[链接\]\(https:\/\/example\.com\/a\)/);
  assert.match(result.markdown, /这是一段引用/);
  assert.match(result.markdown, /## 小节/);
  assert.match(result.markdown, /第一项/);
  assert.match(result.markdown, /第二项/);
  assert.equal(result.markdown.match(/# 示例文章标题/g)?.length, 1);
  assert.doesNotMatch(result.markdown, /页脚二维码/);
  assert.doesNotMatch(result.markdown, /不应优先于主标题/);
});

test("嵌套 section 恢复段落、强调和零宽字符", async () => {
  const result = await convertWechatDocument(
    fixture("nested-sections.html"),
    sourceUrl,
    untouchedImages,
    "http",
  );

  assert.match(result.markdown, /\*\*加粗标题感\*\*/);
  assert.match(result.markdown, /\*斜体句子\*/);
  assert.match(result.markdown, /下一行正文/);
  assert.match(result.markdown, /末尾段落/);
  assert.doesNotMatch(result.markdown, /\u200b/);
  assert.equal(result.author, null);
});

test("懒加载图片去重、失败占位，且不抓取非微信图片", async () => {
  const images = memoryImages();
  const result = await convertWechatDocument(fixture("lazy-images.html"), sourceUrl, images, "http");

  assert.deepEqual(images.downloads.sort(), [
    "https://mmbiz.qpic.cn/other.png",
    "https://mmbiz.qpic.cn/same.png",
  ]);
  assert.deepEqual(result.images, { total: 5, imported: 2, failed: 2, reused: 1 });
  assert.match(result.markdown, /!\[[^\]]*封面[^\]]*\]\(\/images\/[a-f0-9]+\.png\)/);
  assert.match(result.markdown, /图片下载失败：没有地址/);
  assert.match(result.markdown, /图片下载失败：外部图/);
  assert.match(result.markdown, /图文正文足够长/);
  assert.doesNotMatch(result.markdown, /evil\.example/);
  assert.ok(result.warnings.some((warning) => warning.code === "IMAGE_DOWNLOAD_FAILED"));
});

test("重复字节按哈希复用，GIF 保持 GIF，坏图不阻断正文", async () => {
  const images = memoryImages();
  const html = `<h1 id="activity-name">动图</h1><div id="js_content"><p>正文里同时有动图、重复图和失败图。</p>
    <img data-src="https://mmbiz.qpic.cn/a-same-bytes.png" alt="甲" />
    <img data-src="https://mmbiz.qpic.cn/b-same-bytes.png" alt="乙" />
    <img data-src="https://mmbiz.qpic.cn/anim.gif" alt="动图" />
    <img data-src="https://mmbiz.qpic.cn/fail.png" alt="失败图" />
    <img data-src="https://mmbiz.qpic.cn/vector.svg" alt="矢量" /></div>`;
  const result = await convertWechatDocument(html, sourceUrl, images, "http");

  assert.equal(result.images.imported, 2);
  assert.equal(result.images.reused, 1);
  assert.equal(result.images.failed, 2);
  assert.match(result.markdown, /\/images\/[a-f0-9]+\.gif/);
  assert.match(result.markdown, /图片下载失败：失败图/);
  assert.match(result.markdown, /正文里同时有动图/);
  assert.equal(sniffWechatImageExtension(Buffer.from("<svg></svg>")), null);
  assert.equal(sniffWechatImageExtension(Buffer.from("GIF89a")), "gif");
});

test("图片数量上限只降级超出的图片", async () => {
  const images = memoryImages();
  const html = `<div id="root"><img data-src="https://mmbiz.qpic.cn/one.png" alt="一" /><img data-src="https://mmbiz.qpic.cn/two.png" alt="二" /></div>`;
  const result = await localizeWechatImages(html, images, { maxImages: 1 });

  assert.equal(result.images.total, 2);
  assert.equal(result.images.imported, 1);
  assert.equal(result.images.failed, 1);
  assert.equal(images.downloads.length, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "IMAGE_LIMIT_REACHED"));
  assert.match(result.html, /\/images\//);
  assert.match(result.html, /图片下载失败：二/);
});

test("微信代码块去掉行号并保留缩进", async () => {
  const result = await convertWechatDocument(fixture("code-block.html"), sourceUrl, untouchedImages, "http");

  assert.match(result.markdown, /```js\nfunction hello\(\) \{\n {2}return 1;\n\}/);
  assert.doesNotMatch(result.markdown, /code-snippet__line-index/);
  assert.match(result.markdown, /下面是一段可以复制的代码/);
});

test("普通表格转为 GFM，合并单元格保留内容", async () => {
  const result = await convertWechatDocument(fixture("table.html"), sourceUrl, untouchedImages, "http");

  assert.match(result.markdown, /\| 名称 \| 数量 \|/);
  assert.match(result.markdown, /苹果/);
  assert.match(result.markdown, /colspan="2"/);
  assert.match(result.markdown, /合并单元格/);
  assert.match(result.markdown, /左/);
  assert.match(result.markdown, /右/);
  assert.ok(result.warnings.some((warning) => warning.code === "CONTENT_SIMPLIFIED"));
});

test("视频语音小程序和投票保留占位与安全链接", async () => {
  const result = await convertWechatDocument(
    fixture("embedded-media.html"),
    sourceUrl,
    untouchedImages,
    "http",
  );

  assert.match(result.markdown, /语音内容，暂无法直接转换/);
  assert.match(result.markdown, /视频内容，暂无法直接转换/);
  assert.match(result.markdown, /小程序内容，暂无法直接转换/);
  assert.match(result.markdown, /投票内容，暂无法直接转换/);
  assert.match(result.markdown, /https:\/\/res\.wx\.qq\.com\/voice\/demo\.mp3/);
  assert.match(result.markdown, /正文仍然保留/);
  assert.ok(result.warnings.some((warning) => warning.code === "UNSUPPORTED_EMBED"));
});

test("删除页、验证页和空正文返回明确错误", async () => {
  await assert.rejects(
    () => convertWechatDocument(fixture("deleted.html"), sourceUrl, untouchedImages, "http"),
    (error: unknown) => error instanceof WechatImportError && error.code === "ARTICLE_UNAVAILABLE",
  );
  await assert.rejects(
    () => convertWechatDocument(fixture("verification.html"), sourceUrl, untouchedImages, "http"),
    (error: unknown) => error instanceof WechatImportError && error.code === "WECHAT_VERIFICATION_REQUIRED",
  );
  await assert.rejects(
    () => convertWechatDocument(fixture("missing-content.html"), sourceUrl, untouchedImages, "http"),
    (error: unknown) => error instanceof WechatImportError && error.code === "CONTENT_NOT_FOUND",
  );
});

test("恶意链接、脚本和伪造主机不会进入 Markdown", async () => {
  const images = memoryImages();
  const result = await convertWechatDocument(fixture("malicious.html"), sourceUrl, images, "http");

  assert.equal(images.downloads.length, 0);
  assert.match(result.markdown, /正常正文/);
  assert.match(result.markdown, /点我/);
  assert.match(result.markdown, /伪造主机/);
  assert.doesNotMatch(result.markdown, /javascript:/i);
  assert.doesNotMatch(result.markdown, /<script/i);
  assert.doesNotMatch(result.markdown, /onclick/i);
  assert.doesNotMatch(result.markdown, /evil\.example/);
  assert.doesNotMatch(result.markdown, /alert\(1\)/);
});

test("没有发布时间时省略该行，作者不会回填成公众号名", async () => {
  const html = `<h1 id="activity-name"></h1><a id="js_name">只有号名</a><div id="js_content"><p>这段正文没有单独的作者和时间。</p></div>`;
  const result = await convertWechatDocument(html, sourceUrl, untouchedImages, "http");

  assert.equal(result.title, "公众号文章");
  assert.equal(result.accountName, "只有号名");
  assert.equal(result.author, null);
  assert.equal(result.publishedAt, null);
  assert.doesNotMatch(result.markdown, /发布时间|null|未知日期/);
  assert.ok(result.warnings.some((warning) => warning.code === "PUBLISH_TIME_UNKNOWN"));
});

test("参数错误页说明链接无效，不再当成临时故障", () => {
  const verdict = interpretWechatHtml(
    `<html><body><div class="weui-msg__title warn">参数错误</div></body></html>`,
    "http",
  );

  assert.equal(verdict.kind, "terminal");
  if (verdict.kind === "terminal") {
    assert.equal(verdict.error.code, "ARTICLE_UNAVAILABLE");
    assert.match(verdict.error.message, /参数错误/);
    assert.match(verdict.error.message, /__biz/);
  }
});

test("资源请求白名单拒绝内网、明文和仿冒主机", () => {
  assert.equal(isBlockedIpAddress("127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("10.1.1.1"), true);
  assert.equal(isBlockedIpAddress("169.254.169.254"), true);
  assert.equal(isBlockedIpAddress("::1"), true);
  assert.equal(isBlockedIpAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("203.0.113.10"), false);
  assert.equal(isBlockedIpAddress("198.18.0.152"), false);
  assert.equal(isBlockedIpAddress("198.19.0.1"), false);
  assert.equal(decideWechatResourceRequest("https://mp.weixin.qq.com/s/example-id"), "allow");
  assert.equal(decideWechatResourceRequest("https://mmbiz.qpic.cn/a.png"), "allow");
  assert.equal(decideWechatResourceRequest("http://mmbiz.qpic.cn/a.png"), "block");
  assert.equal(decideWechatResourceRequest("https://127.0.0.1/a.png"), "block");
  assert.equal(decideWechatResourceRequest("https://evil.example/a.png"), "block");
  assert.equal(decideWechatResourceRequest("javascript:alert(1)"), "block");
});

test("HTTP 成功时不启动浏览器，删除页和超限也不进入兜底", async () => {
  let browserStarts = 0;
  const getBrowser = async () => {
    browserStarts += 1;
    throw new Error("不应启动浏览器");
  };
  const httpFetcher = createWechatPageFetcher({
    lookupHost: publicLookup,
    getBrowser,
    fetchImpl: async () =>
      new Response(fixture("basic.html"), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  const page = await httpFetcher(sourceUrl);
  assert.equal(page.method, "http");
  assert.equal(browserStarts, 0);

  const deletedFetcher = createWechatPageFetcher({
    lookupHost: publicLookup,
    getBrowser,
    fetchImpl: async () =>
      new Response(fixture("deleted.html"), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  await assert.rejects(
    () => deletedFetcher(sourceUrl),
    (error: unknown) => error instanceof WechatImportError && error.code === "ARTICLE_UNAVAILABLE",
  );

  const oversized = createWechatPageFetcher({
    lookupHost: publicLookup,
    getBrowser,
    maxHtmlBytes: 32,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(80));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/html" } },
      ),
  });
  await assert.rejects(
    () => oversized(sourceUrl),
    (error: unknown) => error instanceof WechatImportError && error.code === "CONTENT_TOO_LARGE",
  );
  assert.equal(browserStarts, 0);
});

test("不完整 HTML 才使用 Playwright，验证页和失败都会释放页面", async () => {
  const closed = { page: 0, context: 0 };
  const captured: { routeHandler: ((route: WechatBrowserRoute) => Promise<void>) | null } = {
    routeHandler: null,
  };
  const calls: string[] = [];
  const fetcher = createWechatPageFetcher({
    lookupHost: publicLookup,
    fetchImpl: async () => {
      calls.push("http");
      return new Response("<html><body><p>还没有正文</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
    getBrowser: async () => ({
      async newContext() {
        return {
          async route(_pattern: string, handler: (route: WechatBrowserRoute) => Promise<void>) {
            captured.routeHandler = handler;
          },
          async newPage() {
            return {
              async goto() {
                return undefined;
              },
              async waitForSelector() {
                return undefined;
              },
              async content() {
                return fixture("basic.html");
              },
              async close() {
                closed.page += 1;
              },
            };
          },
          async close() {
            closed.context += 1;
          },
        };
      },
    }),
  });
  const page = await fetcher(sourceUrl);

  assert.equal(page.method, "playwright");
  assert.deepEqual(calls, ["http"]);
  assert.equal(closed.page, 1);
  assert.equal(closed.context, 1);
  const routeHandler = captured.routeHandler;
  assert.ok(routeHandler);

  const decisions: string[] = [];
  await routeHandler({
    request: () => ({ url: () => "http://127.0.0.1/secret" }),
    abort: async () => {
      decisions.push("abort-private");
    },
    continue: async () => {
      decisions.push("continue-private");
    },
  });
  await routeHandler({
    request: () => ({ url: () => "https://mmbiz.qpic.cn/a.png" }),
    abort: async () => {
      decisions.push("abort-image");
    },
    continue: async () => {
      decisions.push("continue-image");
    },
  });
  assert.deepEqual(decisions, ["abort-private", "continue-image"]);

  let released = false;
  const failing = createWechatPageFetcher({
    lookupHost: publicLookup,
    fetchImpl: async () =>
      new Response(fixture("missing-content.html"), {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    acquireBrowser: async () => () => {
      released = true;
    },
    getBrowser: async () => ({
      async newContext() {
        return {
          async route() {
            return undefined;
          },
          async newPage() {
            return {
              async goto() {
                throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
              },
              async waitForSelector() {
                return undefined;
              },
              async content() {
                return "";
              },
              async close() {
                closed.page += 1;
              },
            };
          },
          async close() {
            closed.context += 1;
          },
        };
      },
    }),
  });

  await assert.rejects(
    () => failing(sourceUrl),
    (error: unknown) => error instanceof WechatImportError && error.code === "FETCH_TIMEOUT",
  );
  assert.equal(released, true);
  assert.equal(closed.context, 2);
});

test("浏览器兜底遇到验证页时停止，不再尝试绕过", async () => {
  const fetcher = createWechatPageFetcher({
    lookupHost: publicLookup,
    fetchImpl: async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    },
    getBrowser: async () => ({
      async newContext() {
        return {
          async route() {
            return undefined;
          },
          async newPage() {
            return {
              async goto() {
                return undefined;
              },
              async waitForSelector() {
                throw new Error("missing");
              },
              async content() {
                return fixture("verification.html");
              },
              async close() {
                return undefined;
              },
            };
          },
          async close() {
            return undefined;
          },
        };
      },
    }),
  });

  await assert.rejects(
    () => fetcher(sourceUrl),
    (error: unknown) => error instanceof WechatImportError && error.code === "WECHAT_VERIFICATION_REQUIRED",
  );
});

test("文章跳转必须重新校验，图片下载拒绝离开白名单", async () => {
  const requested: string[] = [];
  const fetcher = createWechatPageFetcher({
    lookupHost: publicLookup,
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);

      if (url.endsWith("/s/example-id")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        });
      }

      return new Response("no", { status: 500 });
    },
  });
  await assert.rejects(
    () => fetcher(sourceUrl),
    (error: unknown) => error instanceof WechatImportError && error.code === "ARTICLE_UNAVAILABLE",
  );
  assert.deepEqual(requested, [sourceUrl]);

  const downloader = createWechatImageDownloader({
    lookupHost: async (hostname) => (hostname === "mmbiz.qpic.cn" ? ["203.0.113.10"] : ["127.0.0.1"]),
    fetchImpl: async (_input, init) => {
      assert.equal(init?.redirect, "manual");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("referer"), "https://mp.weixin.qq.com/");
      assert.equal(headers.get("cookie"), null);
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret.png" },
      });
    },
  });
  await assert.rejects(() => downloader("https://mmbiz.qpic.cn/a.png"));
  await assert.rejects(() => downloader("https://evil.example/a.png"));
});

test("导入预览在抓取失败时不会返回半成品", async () => {
  await assert.rejects(
    () =>
      previewWechatArticle("javascript:alert(1)", {
        fetchPage: async () => {
          throw new Error("不应抓取");
        },
        ...untouchedImages,
      }),
    (error: unknown) => error instanceof WechatImportError && error.code === "INVALID_URL",
  );
});

test("限流和浏览器并发槽有上限", async () => {
  const limiter = new WechatImportRateLimiter({
    anonymousLimit: 2,
    authenticatedLimit: 2,
    windowMs: 1_000,
    now: () => 1_000,
  });
  assert.equal(limiter.consume("anon:1", "anonymous"), true);
  assert.equal(limiter.consume("anon:1", "anonymous"), true);
  assert.equal(limiter.consume("anon:1", "anonymous"), false);
  assert.equal(limiter.consume("user:1", "authenticated"), true);

  const semaphore = new AsyncSemaphore(1);
  const release = await semaphore.acquire(20);
  await assert.rejects(
    () => semaphore.acquire(20),
    (error: unknown) => error instanceof Error && error.name === "SemaphoreTimeout",
  );
  release();
  const second = await semaphore.acquire(20);
  second();
});

test("导入开关和路由注册不改写工作区", () => {
  const previous = process.env.WECHAT_IMPORT_ENABLED;
  process.env.WECHAT_IMPORT_ENABLED = "false";
  assert.equal(isWechatImportEnabled(), false);
  process.env.WECHAT_IMPORT_ENABLED = "off";
  assert.equal(isWechatImportEnabled(), false);
  delete process.env.WECHAT_IMPORT_ENABLED;
  assert.equal(isWechatImportEnabled(), true);

  if (previous === undefined) {
    delete process.env.WECHAT_IMPORT_ENABLED;
  } else {
    process.env.WECHAT_IMPORT_ENABLED = previous;
  }

  const serverSource = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
  assert.match(serverSource, /app\.post\(\s*"\/api\/import\/wechat\/preview"/);
  assert.match(serverSource, /app\.post\(\s*"\/api\/wechat"/);
  assert.match(serverSource, /app\.post\(\s*"\/api\/images\/import"/);
  assert.match(serverSource, /anon:\$\{request\.ip \|\| "unknown"\}/);
  assert.match(serverSource, /previewWechatArticle/);
  assert.doesNotMatch(
    serverSource.slice(serverSource.indexOf('"/api/import/wechat/preview"'), serverSource.indexOf('"/api/images/import"')),
    /notesDataStore|saveCloudWorkspace|workspace/,
  );
});
