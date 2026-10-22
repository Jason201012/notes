/// <reference path="./vendor-modules.d.ts" />
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// 公众号转换的开源参考清单见 DOCS/notes-wechat-import-cursor-plan.md 第 12 节。
let markdownService: TurndownService | null = null;

// Only drop blank lines at the document edges. Content whitespace (hard breaks,
// fenced code indentation and trailing spaces) must survive the round trip.
function trimBlankDocumentLines(markdown: string): string {
  return markdown.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

// Markdown link destinations cannot carry unbalanced parentheses, raw spaces,
// angle brackets or backslashes without breaking the surrounding syntax.
// Parentheses are not encoded by encodeURIComponent, so encode them explicitly.
const MARKDOWN_LINK_DESTINATION_ESCAPES: Record<string, string> = {
  "(": "%28",
  ")": "%29",
};

function encodeMarkdownLinkDestinationCharacter(character: string): string {
  return MARKDOWN_LINK_DESTINATION_ESCAPES[character] ?? encodeURIComponent(character);
}

function encodeMarkdownLinkDestination(href: string): string {
  // Keep existing %XX escapes intact instead of double encoding them.
  return href
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part) =>
      /^%[0-9A-Fa-f]{2}$/.test(part)
        ? part
        : part.replace(/[\s()\\<>%]/g, encodeMarkdownLinkDestinationCharacter),
    )
    .join("");
}

function getMarkdownService(): TurndownService {
  if (markdownService) {
    return markdownService;
  }

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    fence: "```",
  });
  service.use(gfm);
  service.addRule("mergedTable", {
    filter: (node) =>
      node.nodeName === "TABLE" && node.getAttribute?.("data-keep-html") === "true",
    replacement: (_content, node) => {
      const html = node.outerHTML?.trim();
      return html ? `\n\n${html}\n\n` : `\n\n${_content}\n\n`;
    },
  });
  service.addRule("safeLink", {
    filter: (node) => node.nodeName === "A",
    replacement: (content, node) => {
      const href = node.getAttribute?.("href")?.trim() ?? "";

      if (!href || !/^(https?:|mailto:)/i.test(href)) {
        return content;
      }

      const label = content.trim() || href;
      return `[${label}](${encodeMarkdownLinkDestination(href)})`;
    },
  });
  markdownService = service;
  return service;
}

export function htmlFragmentToMarkdown(html: string): string {
  return trimBlankDocumentLines(getMarkdownService().turndown(html || ""));
}

export function buildWechatMarkdown(input: {
  title: string;
  accountName: string | null;
  publishedAtDisplay: string | null;
  sourceUrl: string;
  body: string;
}): string {
  const title = input.title.trim() || "公众号文章";
  const body = stripDuplicateTitle(trimBlankDocumentLines(input.body), title);
  const sourceLabel = (input.accountName ?? "原文链接").replace(/[\[\]]/g, "").trim() || "原文链接";
  const lines = [
    `# ${title}`,
    "",
    `> 来源：[${sourceLabel}](${input.sourceUrl})`,
  ];

  if (input.publishedAtDisplay) {
    lines.push(`> 发布时间：${input.publishedAtDisplay}`);
  }

  lines.push("", "---", "");

  if (body) {
    lines.push(body);
  }

  return trimBlankDocumentLines(lines.join("\n"));
}

function stripDuplicateTitle(body: string, title: string): string {
  const lines = body.split("\n");
  let index = 0;

  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }

  const heading = /^#\s+(.*)$/.exec(lines[index] ?? "");

  if (heading && heading[1].trim() === title.trim()) {
    lines.splice(index, 1);
    return trimBlankDocumentLines(lines.join("\n"));
  }

  return body;
}

export function visibleMarkdownText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?|```/g, ""))
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]/g, "")
    .replace(/\s+/g, "");
}
