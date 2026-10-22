import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { interpretWechatHtml } from "../../server/wechat-import/extract.js";
import { createWechatPageFetcher } from "../../server/wechat-import/fetch.js";
import { convertWechatDocument } from "../../server/wechat-import/service.js";
import { WechatImportError } from "../../server/wechat-import/types.js";

const sourceUrl = "https://mp.weixin.qq.com/s/dynamic-article";
const fixture = (name: string) => readFileSync(
  new URL(`./fixtures/wechat-import/${name}`, import.meta.url), "utf8",
);
const noImages = {
  async downloadImage(): Promise<never> { throw new Error("不应下载图片"); },
  async persistImage(): Promise<never> { throw new Error("不应保存图片"); },
};

test("脚本、样式、模板及隐藏文案不再阻断浏览器兜底", () => {
  const html = fixture("dynamic-note-shell.html");
  assert.deepEqual(interpretWechatHtml(html, "http"), { kind: "incomplete" });
  const final = interpretWechatHtml(html, "final");
  assert.equal(final.kind, "terminal");
  if (final.kind === "terminal") assert.equal(final.error.code, "CONTENT_NOT_FOUND");
});

test("正常短文章中提到错误提示或验证码仍可导入", () => {
  for (const text of ["验证码功能可以保护账号。", "请在微信中打开原文查看。", "参数错误的原因及解决办法。", "该内容已被删除的提示说明。"]) {
    assert.deepEqual(interpretWechatHtml(`<div id="js_content"><p>${text}</p></div>`, "http"), {
      kind: "article",
    });
  }
});

test("可见的删除、验证及客户端限制页仍立即失败，不启动浏览器", async () => {
  for (const [html, code] of [
    [fixture("deleted.html"), "ARTICLE_UNAVAILABLE"],
    [fixture("verification.html"), "WECHAT_VERIFICATION_REQUIRED"],
    ["<div class='weui-msg'>请在微信客户端打开</div>", "ARTICLE_UNAVAILABLE"],
    ["<div class='weui-msg'>参数错误</div>", "ARTICLE_UNAVAILABLE"],
  ]) {
    let starts = 0;
    const fetcher = createWechatPageFetcher({
      lookupHost: async () => ["203.0.113.10"],
      fetchImpl: async () => new Response(html, { headers: { "Content-Type": "text/html" } }),
      getBrowser: async () => { starts += 1; throw new Error("不应启动浏览器"); },
    });
    await assert.rejects(() => fetcher(sourceUrl), (error: unknown) =>
      error instanceof WechatImportError && error.code === code);
    assert.equal(starts, 0);
  }
});

test("动态文章先 HTTP 后浏览器，使用渲染后的正文并关闭资源", async () => {
  const calls: string[] = [];
  const fetcher = createWechatPageFetcher({
    lookupHost: async () => ["203.0.113.10"],
    fetchImpl: async () => {
      calls.push("http");
      return new Response(fixture("dynamic-note-shell.html"));
    },
    getBrowser: async () => {
      calls.push("browser");
      return {
        async newContext() {
          return {
            async route() {},
            async close() { calls.push("context.close"); },
            async newPage() {
              return {
                async goto() { calls.push("goto"); },
                async waitForSelector() { calls.push("wait"); },
                async content() { return fixture("dynamic-note-rendered.html"); },
                async close() { calls.push("page.close"); },
              };
            },
          };
        },
      };
    },
  });
  const page = await fetcher(sourceUrl);
  assert.equal(page.method, "playwright");
  const result = await convertWechatDocument(page.html, sourceUrl, noImages, page.method);
  assert.equal(result.title, "动态文章第一句话。");
  assert.match(result.markdown, /正常文章内容/);
  assert.match(result.markdown, /末尾段落也要保留/);
  assert.doesNotMatch(result.markdown, /测试地区|> 发布时间：10月20日|\\n/);
  assert.deepEqual(calls, ["http", "browser", "goto", "wait", "page.close", "context.close"]);
});

test("图片文章带回正文容器外的轮播图，剔除界面和重复标题", async () => {
  const downloads: string[] = [];
  const result = await convertWechatDocument(
    fixture("dynamic-gallery-rendered.html"), sourceUrl,
    {
      async downloadImage(url) {
        downloads.push(url);
        return { buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.from(url)]), contentType: "image/png" };
      },
      async persistImage(image) {
        return { path: `/images/${createHash("sha256").update(image.buffer).digest("hex")}.png`, reused: false };
      },
    }, "playwright",
  );
  assert.deepEqual(downloads.sort(), ["https://mmbiz.qpic.cn/first.png", "https://mmbiz.qpic.cn/second.png"]);
  assert.deepEqual(result.images, { total: 2, imported: 2, reused: 0, failed: 0 });
  assert.equal(result.markdown.match(/图片文章标题/g)?.length, 1);
  assert.match(result.markdown, /!\[第一张图\]/);
  assert.match(result.markdown, /!\[第二张图\]/);
  assert.doesNotMatch(result.markdown, /测试地区|点赞|加载中|页脚二维码/);
});

test("图片文章只有标题而没有任何图片时不能伪造导入成功", async () => {
  await assert.rejects(
    () => convertWechatDocument(
      "<div id='js_content'><div id='js_image_content'><h1 class='rich_media_title'>只有标题的图片文章</h1></div></div>",
      sourceUrl, noImages, "playwright",
    ),
    (error: unknown) => error instanceof WechatImportError && error.code === "CONTENT_NOT_FOUND",
  );
});
