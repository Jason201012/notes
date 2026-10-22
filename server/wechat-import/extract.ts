import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { WechatImportWarning } from "./types.js";
import { WechatImportError } from "./types.js";

export interface WechatArticleMetadata {
  title: string;
  accountName: string | null;
  author: string | null;
  publishedAt: string | null;
  publishedAtDisplay: string | null;
}

export interface ExtractedWechatArticle {
  metadata: WechatArticleMetadata;
  contentHtml: string;
  sourceText: string;
  warnings: WechatImportWarning[];
}

export type WechatHtmlVerdict =
  | { kind: "article" }
  | { kind: "incomplete" }
  | { kind: "terminal"; error: WechatImportError };

const DELETED_PATTERN =
  /该内容已被发布者删除|此内容已被发布者删除|该内容已被删除|内容已删除|此内容因违规无法查看|此内容被投诉|此账号已被屏蔽/;
const REVIEW_PATTERN = /内容审核中|此内容正在审核|此内容审核中/;
const VERIFICATION_PATTERN =
  /环境异常|完成验证后即可继续访问|请进行验证|验证码|访问过于频繁|操作过于频繁|系统繁忙/;
const CLIENT_ONLY_PATTERN = /请在微信客户端打开|请在微信中打开/;
const PARAMETER_ERROR_PATTERN = /参数错误|parameter error/i;

const EMBEDS: Array<{ selector: string; label: string }> = [
  {
    selector: "mpvoice, mp-common-mpaudio, mp-common-claudio, .audio_area, .share_audio_area",
    label: "语音内容，暂无法直接转换",
  },
  {
    selector: "mpvideo, video, mp-common-videosnap, mp-common-mpvideo, .video_iframe",
    label: "视频内容，暂无法直接转换",
  },
  {
    selector: "iframe",
    label: "嵌入内容，暂无法直接转换",
  },
  {
    selector: "qqmusic, mp-common-qqmusic, .qqmusic_area",
    label: "音乐内容，暂无法直接转换",
  },
  {
    selector: "mp-miniprogram, mp-common-miniprogram, .weapp_display_element, .weapp_card",
    label: "小程序内容，暂无法直接转换",
  },
  {
    selector: "mp-vote, .vote_area, .vote_box",
    label: "投票内容，暂无法直接转换",
  },
  {
    selector: "mp-common-product, .product_card, .js_product_container",
    label: "商品卡片，暂无法直接转换",
  },
];

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
  "img",
]);

function compactText(value: string): string {
  return value.replace(/[\s\u200b\u200c\u200d\ufeff]+/g, "");
}

function cleanPlain(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function shanghaiParts(epochMs: number): { iso: string; display: string } | null {
  if (!Number.isFinite(epochMs)) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  const second = Number(read("second"));

  if (year < 2000 || year > 2100) {
    return null;
  }

  return {
    iso: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`,
    display: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`,
  };
}

export function parseWechatPublishedAt(value: string): { iso: string; display: string } | null {
  const trimmed = value.trim();
  const timestamp = /^(?:ct|create_time|createTime)?\s*[:=]?\s*['"]?(\d{10,13})['"]?$/.exec(trimmed);

  if (timestamp) {
    const numeric = Number(timestamp[1]);
    const epochMs = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return shanghaiParts(epochMs);
  }

  const chinese =
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s+(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?)?/.exec(
      trimmed,
    );

  if (chinese) {
    const year = Number(chinese[1]);
    const month = Number(chinese[2]);
    const day = Number(chinese[3]);
    const hour = chinese[4] ? Number(chinese[4]) : 0;
    const minute = chinese[5] ? Number(chinese[5]) : 0;
    const second = chinese[6] ? Number(chinese[6]) : 0;
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`;
    return {
      iso,
      display: chinese[4]
        ? `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`
        : `${year}-${pad(month)}-${pad(day)}`,
    };
  }

  const numericDate =
    /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(trimmed);

  if (numericDate) {
    const year = Number(numericDate[1]);
    const month = Number(numericDate[2]);
    const day = Number(numericDate[3]);
    const hour = numericDate[4] ? Number(numericDate[4]) : 0;
    const minute = numericDate[5] ? Number(numericDate[5]) : 0;
    const second = numericDate[6] ? Number(numericDate[6]) : 0;
    return {
      iso: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`,
      display: numericDate[4]
        ? `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`
        : `${year}-${pad(month)}-${pad(day)}`,
    };
  }

  return null;
}

function isSafeContentHref(href: string): boolean {
  try {
    const url = new URL(href, "https://mp.weixin.qq.com");

    if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
      return false;
    }

    if (url.username || url.password) {
      return false;
    }

    if (url.protocol === "mailto:") {
      return true;
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

    if (hostname.includes("weixin.qq.com") && hostname !== "mp.weixin.qq.com") {
      return false;
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
      return false;
    }

    return hostname !== "localhost" && !hostname.endsWith(".local");
  } catch {
    return false;
  }
}

function findSafeResourceLink($: CheerioAPI, element: Element): string | null {
  const candidates: string[] = [];
  const own = [
    $(element).attr("data-src"),
    $(element).attr("data-url"),
    $(element).attr("src"),
    $(element).attr("href"),
  ];

  for (const value of own) {
    if (value) {
      candidates.push(value);
    }
  }

  $(element)
    .find("[href], [src], [data-src], [data-url]")
    .each((_, node) => {
      if (node.type !== "tag") {
        return;
      }

      for (const name of ["data-src", "data-url", "src", "href"]) {
        const value = $(node).attr(name);
        if (value) {
          candidates.push(value);
        }
      }
    });

  for (const candidate of candidates) {
    const resolved = candidate.startsWith("//") ? `https:${candidate}` : candidate;
    if (isSafeContentHref(resolved) && resolved.startsWith("https://")) {
      return new URL(resolved).toString();
    }
  }

  return null;
}

function pushWarning(warnings: WechatImportWarning[], warning: WechatImportWarning): void {
  const exists = warnings.some(
    (item) =>
      item.code === warning.code &&
      item.message === warning.message &&
      item.sourceUrl === warning.sourceUrl,
  );

  if (!exists && warnings.length < 40) {
    warnings.push(warning);
  }
}

function replaceEmbeds(
  $: CheerioAPI,
  content: Cheerio<Element>,
  warnings: WechatImportWarning[],
): void {
  for (const embed of EMBEDS) {
    content.find(embed.selector).each((_, element) => {
      if (element.type !== "tag" || $(element).parents(".wechat-import-embed").length) {
        return;
      }

      const link = findSafeResourceLink($, element);
      const paragraph = $("<p class=\"wechat-import-embed\"></p>");

      if (link) {
        paragraph.append(`${embed.label} `);
        paragraph.append($("<a></a>").attr("href", link).text("原链接"));
      } else {
        paragraph.text(embed.label);
      }

      $(element).replaceWith(paragraph);
      pushWarning(warnings, {
        code: "UNSUPPORTED_EMBED",
        message: link
          ? `${embed.label}，已保留原链接。`
          : `${embed.label}。`,
        sourceUrl: link ?? undefined,
      });
    });
  }
}

function languageFromClass(className: string): string {
  const match = className.match(/code-snippet__([a-z0-9+#]+)/gi) ?? [];

  for (const item of match) {
    const name = item.slice("code-snippet__".length).toLowerCase();

    if (["fix", "line", "line-index"].includes(name)) {
      continue;
    }

    switch (name) {
      case "javascript":
      case "js":
        return "js";
      case "typescript":
      case "ts":
        return "ts";
      case "python":
      case "py":
        return "python";
      case "golang":
      case "go":
        return "go";
      case "shell":
      case "bash":
      case "sh":
        return "bash";
      case "c++":
      case "cpp":
        return "cpp";
      case "csharp":
      case "cs":
        return "csharp";
      default:
        return name.replace(/[^a-z0-9#+-]/g, "") || "";
    }
  }

  return "";
}

function replaceSnippet($: CheerioAPI, element: Element): void {
  const className = [
    $(element).attr("class") ?? "",
    ...$(element)
      .find("[class*='code-snippet__']")
      .toArray()
      .map((node) => (node.type === "tag" ? $(node).attr("class") ?? "" : "")),
  ].join(" ");
  $(element).find(".code-snippet__line-index").remove();
  const lines = $(element).find(".code-snippet__line");
  const code = (
    lines.length
      ? lines.toArray().map((line) => $(line).text().replace(/\u00a0/g, " ")).join("\n")
      : $(element).text()
  ).replace(/\n+$/g, "");
  const pre = $("<pre></pre>");
  const codeElement = $("<code></code>");
  const language = languageFromClass(className);

  if (language) {
    codeElement.attr("class", `language-${language}`);
  }

  codeElement.text(code);
  pre.append(codeElement);
  $(element).replaceWith(pre);
}

function convertCodeSnippets($: CheerioAPI, content: Cheerio<Element>): void {
  content.find(".code-snippet__fix").each((_, element) => {
    if (element.type === "tag") {
      replaceSnippet($, element);
    }
  });
  content.find("pre").each((_, element) => {
    if (element.type !== "tag" || $(element).parents(".code-snippet__fix").length) {
      return;
    }

    const className = $(element).attr("class") ?? "";

    if (
      /code-snippet__/.test(className) ||
      $(element).find(".code-snippet__line, .code-snippet__line-index").length
    ) {
      replaceSnippet($, element);
    }
  });
}

function applyEmphasis($: CheerioAPI, content: Cheerio<Element>): void {
  content.find("[style]").each((_, element) => {
    if (element.type !== "tag" || $(element).closest("pre, code").length) {
      return;
    }

    const style = $(element).attr("style") ?? "";
    const bold = /font-weight\s*:\s*(bold|bolder|[6-9]00)\b/i.test(style);
    const italic = /font-style\s*:\s*italic\b/i.test(style);

    if (bold) {
      $(element).wrapInner("<strong></strong>");
    }

    if (italic) {
      $(element).wrapInner("<em></em>");
    }
  });
}

function flattenBlocks($: CheerioAPI, content: Cheerio<Element>): void {
  const nodes = content.find("section, div").toArray().reverse();

  for (const node of nodes) {
    if (node.type !== "tag" || $(node).closest("pre, table").length) {
      continue;
    }

    const hasBlock = $(node)
      .children()
      .toArray()
      .some((child) => child.type === "tag" && BLOCK_TAGS.has(child.tagName));

    if (!hasBlock) {
      const paragraph = $("<p></p>");
      paragraph.append($(node).contents());
      $(node).replaceWith(paragraph);
    }
  }
}

function stripDangerousAttributes($: CheerioAPI, content: Cheerio<Element>): void {
  content.find("*").each((_, element) => {
    if (element.type !== "tag") {
      return;
    }

    for (const name of Object.keys(element.attribs ?? {})) {
      if (/^on/i.test(name) || name === "srcdoc" || name === "style") {
        $(element).removeAttr(name);
      }
    }

    const href = $(element).attr("href");

    if (href && !isSafeContentHref(href)) {
      $(element).removeAttr("href");
    }
  });
}

function removeInvisibleCharacters($: CheerioAPI, content: Cheerio<Element>): void {
  content
    .find("*")
    .addBack()
    .contents()
    .each((_, node) => {
      if (node.type === "text") {
        node.data = node.data.replace(/[\u200b\u200c\u200d\ufeff]/g, "");
      }

      if (node.type === "comment") {
        $(node).remove();
      }
    });
}

function markMergedTables(
  $: CheerioAPI,
  content: Cheerio<Element>,
  warnings: WechatImportWarning[],
): void {
  content.find("table").each((_, table) => {
    if (table.type !== "tag") {
      return;
    }

    const merged = $(table)
      .find("td, th")
      .toArray()
      .some((cell) => {
        if (cell.type !== "tag") {
          return false;
        }

        const colspan = Number($(cell).attr("colspan") || "1");
        const rowspan = Number($(cell).attr("rowspan") || "1");
        return colspan > 1 || rowspan > 1;
      });

    if (!merged) {
      return;
    }

    $(table).find("script, style, iframe, object").remove();
    stripDangerousAttributes($, $(table) as Cheerio<Element>);
    $(table).attr("data-keep-html", "true");
    pushWarning(warnings, {
      code: "CONTENT_SIMPLIFIED",
      message: "含合并单元格的表格已保留为 HTML，避免丢失单元格内容。",
    });
  });
}

function simplifyGraphics(
  $: CheerioAPI,
  content: Cheerio<Element>,
  warnings: WechatImportWarning[],
): void {
  const graphics = content.find("svg, canvas");

  if (!graphics.length) {
    return;
  }

  graphics.each((_, element) => {
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (!text) {
      $(element).remove();
      return;
    }
    const paragraph = $("<p></p>");
    paragraph.text(text);
    $(element).replaceWith(paragraph);
  });
  pushWarning(warnings, {
    code: "CONTENT_SIMPLIFIED",
    message: "部分复杂排版已简化，正文文字会尽量保留。",
  });
}

function contentImageCount($: CheerioAPI): number {
  return $("#js_content img, #js_article #img_list img").filter((_, element) => {
    if (element.type !== "tag") {
      return false;
    }

    return Boolean($(element).attr("data-src") || $(element).attr("src"));
  }).length;
}

export function interpretWechatHtml(
  html: string,
  stage: "http" | "final",
): WechatHtmlVerdict {
  const $ = load(html);
  // Bundled scripts and hidden templates contain error-message strings even on
  // valid articles. Only inspect page text when deciding to stop before rendering.
  const pageBody = $("body").clone();
  pageBody.find("script, style, noscript, template, [hidden], [aria-hidden='true']").remove();
  const pageText = pageBody.text();
  const contentText = compactText($("#js_content").text());
  const shortContent = contentText.length < 40;
  const hasContent = $("#js_content").length > 0;

  // A short article can itself discuss verification, deletion, or client links.
  // When usable content exists, only dedicated error containers can reject it.
  const hasArticleContent = hasContent && (contentText.length >= 8 || contentImageCount($) > 0);
  const errorText = hasArticleContent
    ? pageBody.find(".weui_msg, .weui-msg, .page_msg").text()
    : pageText;

  if (shortContent && (DELETED_PATTERN.test(errorText) || REVIEW_PATTERN.test(errorText))) {
    return { kind: "terminal", error: new WechatImportError("ARTICLE_UNAVAILABLE") };
  }

  if (shortContent && VERIFICATION_PATTERN.test(errorText)) {
    return {
      kind: "terminal",
      error: new WechatImportError("WECHAT_VERIFICATION_REQUIRED"),
    };
  }

  if (shortContent && PARAMETER_ERROR_PATTERN.test(errorText)) {
    return {
      kind: "terminal",
      error: new WechatImportError(
        "ARTICLE_UNAVAILABLE",
        "微信返回“参数错误”，这篇链接在网页上打不开。请换成浏览器地址栏里带 __biz、mid、idx、sn 的完整文章链接。",
      ),
    };
  }

  if (shortContent && CLIENT_ONLY_PATTERN.test(errorText)) {
    return { kind: "terminal", error: new WechatImportError("ARTICLE_UNAVAILABLE", "微信要求在客户端打开这篇文章。请在微信中打开原文，或把正文复制到编辑器。") };
  }

  if (hasArticleContent) {
    return { kind: "article" };
  }

  if (stage === "http") {
    return { kind: "incomplete" };
  }

  return { kind: "terminal", error: new WechatImportError("CONTENT_NOT_FOUND") };
}

function readMetaContent($: CheerioAPI, selector: string): string | null {
  const value = cleanPlain($(selector).attr("content") ?? "");
  return value || null;
}

function readText($: CheerioAPI, selector: string): string | null {
  const value = cleanPlain($(selector).first().text());
  return value || null;
}

function readNoteTitle($: CheerioAPI): string | null {
  const description = $("#js_content #js_text_desc").first().clone();
  description.find("br").replaceWith("\n");
  const firstLine = description.text().split(/\r?\n/).find((line) => line.trim());
  return firstLine ? cleanPlain(firstLine) : null;
}

function prepareArticleContent($: CheerioAPI): Cheerio<Element> {
  const content = $("#js_content").first().clone();

  // New note/image pages put publish metadata inside #js_content and gallery
  // images outside it. Keep only article content, not the surrounding controls.
  content.find(".rich_media_meta_list, .rich_media_tool, .weui-hidden_abs").remove();

  if (content.find("#js_image_content").length) {
    content.find(".rich_media_title").remove();
    $("#js_article #img_list img").each((_, image) => {
      content.append($("<p></p>").append($(image).clone()));
    });
  }

  return content;
}

function acceptableTitle(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (/环境异常|验证码|访问过于频繁|微信公众平台$/.test(value) && value.length < 24) {
    return null;
  }

  return value.replace(/^#+\s*/, "").replace(/#/g, "");
}

function extractPublishedAt($: CheerioAPI): { iso: string; display: string } | null {
  const visible = [
    readText($, "#publish_time"),
    readText($, "#create_time"),
    readMetaContent($, "meta[property='article:published_time']"),
  ];

  for (const value of visible) {
    if (!value) {
      continue;
    }

    const parsed = parseWechatPublishedAt(value);
    if (parsed) {
      return parsed;
    }
  }

  const scriptText = $("script")
    .toArray()
    .map((script) => $(script).text())
    .join("\n");
  const matched = scriptText.match(
    /\b(?:ct|create_time|createTime)\b\s*[:=]\s*['"](\d{10,13})['"]/,
  );

  return matched ? parseWechatPublishedAt(matched[1]) : null;
}

export function extractWechatArticle(html: string): ExtractedWechatArticle {
  const verdict = interpretWechatHtml(html, "final");

  if (verdict.kind === "terminal") {
    throw verdict.error;
  }

  if (verdict.kind !== "article") {
    throw new WechatImportError("CONTENT_NOT_FOUND");
  }

  const $ = load(html);
  const warnings: WechatImportWarning[] = [];
  const content = prepareArticleContent($);
  const accountName = readText($, "#js_name") ?? readText($, ".profile_nickname");
  const authorText = readText($, "#js_author_name");
  const author = authorText && authorText !== accountName ? authorText : null;
  const title =
    acceptableTitle(readText($, "#activity-name")) ??
    acceptableTitle(readText($, "#js_content .rich_media_title")) ??
    acceptableTitle(readNoteTitle($)) ??
    acceptableTitle(readMetaContent($, "meta[property='og:title']")) ??
    acceptableTitle(readText($, "h1")) ??
    "公众号文章";
  const published = extractPublishedAt($);

  if (!published) {
    pushWarning(warnings, {
      code: "PUBLISH_TIME_UNKNOWN",
      message: "没有解析到可靠的发布时间。",
    });
  }

  replaceEmbeds($, content, warnings);
  simplifyGraphics($, content, warnings);
  content.find("script, style, noscript, button, input, textarea, form, object, embed").remove();
  convertCodeSnippets($, content);
  applyEmphasis($, content);
  markMergedTables($, content, warnings);
  flattenBlocks($, content);
  stripDangerousAttributes($, content);
  removeInvisibleCharacters($, content);

  const sourceText = compactText(content.text());
  const contentHtml = (content.html() ?? "").replace(/[\u200b\u200c\u200d\ufeff]/g, "");

  return {
    metadata: {
      title,
      accountName,
      author,
      publishedAt: published?.iso ?? null,
      publishedAtDisplay: published?.display ?? null,
    },
    contentHtml,
    sourceText,
    warnings,
  };
}
