import { buildWechatMarkdown, htmlFragmentToMarkdown, visibleMarkdownText } from "./convert.js";
import { extractWechatArticle } from "./extract.js";
import type { FetchedWechatPage } from "./fetch.js";
import { localizeWechatImages, type StoredWechatImage, type WechatImageBytes } from "./images.js";
import { parseWechatArticleInput } from "./url.js";
import type { WechatImportWarning, WechatPreviewResponse } from "./types.js";
import { WechatImportError } from "./types.js";

export interface WechatImportRuntime {
  fetchPage: (url: string) => Promise<FetchedWechatPage>;
  downloadImage: (url: string) => Promise<WechatImageBytes>;
  // 预览会把图片写入现有 /images 内容哈希存储。用户取消创建便签时不删除这些文件，
  // 因为相同哈希可能已被其他便签引用；未被引用的图片允许暂时残留，后续再按引用清理。
  persistImage: (image: WechatImageBytes) => Promise<StoredWechatImage>;
}

function mergeWarnings(warnings: WechatImportWarning[]): WechatImportWarning[] {
  const merged: WechatImportWarning[] = [];

  for (const warning of warnings) {
    const exists = merged.some(
      (item) =>
        item.code === warning.code &&
        item.message === warning.message &&
        item.sourceUrl === warning.sourceUrl,
    );

    if (!exists) {
      merged.push(warning);
    }
  }

  return merged;
}

function assertSafeMarkdown(markdown: string): void {
  if (/<\s*script\b|javascript\s*:|\son[a-z]+\s*=/i.test(markdown)) {
    throw new WechatImportError("UPSTREAM_ERROR");
  }
}

export async function convertWechatDocument(
  html: string,
  sourceUrl: string,
  runtime: Pick<WechatImportRuntime, "downloadImage" | "persistImage">,
  fetchMethod: FetchedWechatPage["method"],
): Promise<WechatPreviewResponse> {
  const extracted = extractWechatArticle(html);
  const localized = await localizeWechatImages(extracted.contentHtml, runtime);
  const body = htmlFragmentToMarkdown(localized.html);
  const markdown = buildWechatMarkdown({
    title: extracted.metadata.title,
    accountName: extracted.metadata.accountName,
    publishedAtDisplay: extracted.metadata.publishedAtDisplay,
    sourceUrl,
    body,
  });
  assertSafeMarkdown(markdown);
  const warnings = mergeWarnings([...extracted.warnings, ...localized.warnings]);
  const comparableBody = markdown.split("\n---\n").slice(1).join("\n---\n");
  const sourceLength = extracted.sourceText.length;
  const bodyLength = visibleMarkdownText(comparableBody).length;

  if (sourceLength >= 40) {
    const ratio = bodyLength / sourceLength;

    if (ratio < 0.2 && localized.images.imported + localized.images.reused === 0) {
      throw new WechatImportError("CONTENT_NOT_FOUND");
    }

    if (ratio < 0.55) {
      warnings.push({
        code: "CONTENT_SIMPLIFIED",
        message: "部分复杂排版已简化，正文文字会尽量保留。",
      });
    }
  }

  if (bodyLength < 8 && localized.images.total === 0) {
    throw new WechatImportError("CONTENT_NOT_FOUND");
  }

  return {
    title: extracted.metadata.title,
    accountName: extracted.metadata.accountName,
    author: extracted.metadata.author,
    publishedAt: extracted.metadata.publishedAt,
    sourceUrl,
    markdown,
    images: localized.images,
    warnings: mergeWarnings(warnings),
    fetchMethod,
  };
}

export async function previewWechatArticle(
  rawUrl: string,
  runtime: WechatImportRuntime,
): Promise<WechatPreviewResponse> {
  const parsed = parseWechatArticleInput(rawUrl);

  if (!parsed.ok) {
    throw new WechatImportError("INVALID_URL", parsed.message);
  }

  const page = await runtime.fetchPage(parsed.url);
  return convertWechatDocument(page.html, parsed.url, runtime, page.method);
}
