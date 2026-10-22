import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import {
  buildWechatMarkdown,
  htmlFragmentToMarkdown,
} from "../../server/wechat-import/convert.js";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown),
  );
}

function buildWechatDocument(body: string): string {
  return buildWechatMarkdown({
    title: "示例标题",
    accountName: "示例公众号",
    publishedAtDisplay: "2026-10-17",
    sourceUrl: "https://mp.weixin.qq.com/s/example-id",
    body,
  });
}

test("代码块内的连续空行、缩进和行尾空格在整条链路中保留", () => {
  const code = "first line   \n\n\n    indented line\ntrailing spaces   ";
  const html = `<p>介绍</p><pre><code>${code}</code></pre><p>结尾</p>`;

  const body = htmlFragmentToMarkdown(html);

  assert.ok(body.includes(code), `body lost code whitespace: ${JSON.stringify(body)}`);

  const markdown = buildWechatDocument(body);

  assert.ok(
    markdown.includes(code),
    `document lost code whitespace: ${JSON.stringify(markdown)}`,
  );

  const rendered = renderMarkdown(markdown);

  assert.ok(
    rendered.includes(code),
    `rendered code lost whitespace: ${JSON.stringify(rendered)}`,
  );
});

test("br 输出 Markdown hard break，渲染后仍是两行", () => {
  const body = htmlFragmentToMarkdown("<p>第一行<br>第二行</p>");

  assert.equal(body, "第一行  \n第二行");

  const markdown = buildWechatDocument(body);

  assert.ok(markdown.includes("第一行  \n第二行"));

  const rendered = renderMarkdown(markdown);

  assert.match(rendered, /<p>第一行<br\/>\n第二行<\/p>/);
});

test("链接目标中的不平衡括号被编码，渲染后保持完整目标且没有多余正文", () => {
  const body = htmlFragmentToMarkdown(
    '<p><a href="https://example.com/a(b">示例链接</a></p>',
  );

  assert.equal(body, "[示例链接](https://example.com/a%28b)");

  const renderedBody = renderMarkdown(body);

  assert.equal(
    renderedBody,
    '<p><a href="https://example.com/a%28b">示例链接</a></p>',
  );

  const markdown = buildWechatDocument(body);

  assert.ok(markdown.includes("[示例链接](https://example.com/a%28b)"));
});

test("已编码的 %xx 与空白不会被重复编码", () => {
  const body = htmlFragmentToMarkdown(
    '<p><a href="https://example.com/a%28b?q=1 2">已编码链接</a></p>',
  );

  assert.equal(body, "[已编码链接](https://example.com/a%28b?q=1%202)");

  const rendered = renderMarkdown(body);

  assert.equal(
    rendered,
    '<p><a href="https://example.com/a%28b?q=1%202">已编码链接</a></p>',
  );
});

test("普通段落和列表在移除全局空白折叠后仍保持结构", () => {
  const body = htmlFragmentToMarkdown(
    "<p>第一段</p><p>第二段</p><ul><li>项目一</li><li>项目二</li></ul>",
  );

  assert.match(body, /^第一段\n\n第二段\n\n- +项目一\n- +项目二$/);

  const rendered = renderMarkdown(buildWechatDocument(body));

  assert.ok(rendered.includes("<p>第一段</p>"));
  assert.ok(rendered.includes("<p>第二段</p>"));
  assert.ok(rendered.includes("<li>项目一</li>"));
  assert.ok(rendered.includes("<li>项目二</li>"));
});

test("javascript 协议链接仍被拒绝并只保留链接文字", () => {
  const body = htmlFragmentToMarkdown(
    '<p><a href="javascript:alert(1)">危险链接</a></p>',
  );

  assert.equal(body, "危险链接");
  assert.ok(!/(?:javascript|alert)/i.test(body));
});
