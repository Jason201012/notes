import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WechatImportDialog } from "../../src/components/WechatImportDialog.js";
import {
  beginWechatNoteCreation,
  countLiveNotesWithSource,
  createInitialWechatImportState,
  rejectionForWechatImportInput,
  wechatImportDialogReducer,
  type WechatPreviewResponse,
} from "../../src/lib/wechat-import.js";

const preview: WechatPreviewResponse = {
  title: "示例文章标题",
  accountName: "示例公众号",
  author: null,
  publishedAt: "2026-10-17T08:00:00+08:00",
  sourceUrl: "https://mp.weixin.qq.com/s/example-id",
  markdown: "# 示例文章标题\n\n这里是正文。\n\n![封面](/images/hash.png)",
  images: { total: 2, imported: 1, failed: 1, reused: 0 },
  warnings: [
    {
      code: "IMAGE_DOWNLOAD_FAILED",
      message: "图片“封面”下载失败，正文中保留了占位。",
    },
  ],
  fetchMethod: "http",
};

test("无效链接在本地拒绝，不会进入解析请求", () => {
  assert.match(rejectionForWechatImportInput("https://example.com/post") ?? "", /mp\.weixin\.qq\.com/);
  assert.equal(rejectionForWechatImportInput("https://mp.weixin.qq.com/s/example-id"), null);

  const rejected = wechatImportDialogReducer(createInitialWechatImportState("https://example.com"), {
    type: "fail-local",
    message: "只接受 mp.weixin.qq.com 上的文章链接。",
  });
  assert.equal(rejected.status, "error");
  assert.equal(rejected.url, "https://example.com");
  assert.match(rejected.errorMessage, /mp\.weixin\.qq\.com/);
});

test("导入对话框忽略过期响应、重复提交和重复创建", () => {
  const idle = createInitialWechatImportState(" https://mp.weixin.qq.com/s/example-id ");
  const loading = wechatImportDialogReducer(idle, {
    type: "submit",
    url: "https://mp.weixin.qq.com/s/example-id",
  });
  assert.equal(loading.status, "loading");
  assert.equal(wechatImportDialogReducer(loading, { type: "submit", url: loading.url }), loading);

  const stale = wechatImportDialogReducer(loading, {
    type: "succeed",
    requestId: loading.requestId + 1,
    result: preview,
  });
  assert.equal(stale.status, "loading");

  const ready = wechatImportDialogReducer(loading, {
    type: "succeed",
    requestId: loading.requestId,
    result: preview,
  });
  assert.equal(ready.status, "preview");
  const failed = wechatImportDialogReducer(loading, {
    type: "fail",
    requestId: loading.requestId,
    message: "文章已删除或无法访问，请检查链接。",
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.url, loading.url);
  assert.match(failed.errorMessage, /删除/);

  assert.equal(beginWechatNoteCreation(failed, false), null);
  assert.deepEqual(beginWechatNoteCreation(ready, false), { markdown: preview.markdown });
  assert.equal(beginWechatNoteCreation(ready, true), null);
  const creating = wechatImportDialogReducer(ready, { type: "create" });
  assert.equal(creating.status, "creating");
  assert.equal(wechatImportDialogReducer(creating, { type: "create" }), creating);
});

test("导入对话框展示预览、图片失败和重复来源，取消不创建便签", () => {
  const html = renderToStaticMarkup(
    createElement(WechatImportDialog, {
      notes: [
        {
          markdown: "已有一篇 https://mp.weixin.qq.com/s/example-id",
          deletedAt: null,
        },
      ],
      initialState: {
        ...createInitialWechatImportState("https://mp.weixin.qq.com/s/example-id"),
        status: "preview",
        requestId: 1,
        result: preview,
      },
      onClose: () => undefined,
      onCreateNote: () => undefined,
    }),
  );

  assert.match(html, /导入公众号文章/);
  assert.match(html, /示例文章标题/);
  assert.match(html, /图片成功 1 \/ 失败 1/);
  assert.match(html, /图片“封面”下载失败/);
  assert.match(html, /同一原文链接/);
  assert.match(html, /这里是正文/);
  assert.match(html, />取消</);
  assert.match(html, />创建便签</);
  assert.doesNotMatch(html, /onCreateNote/);
  assert.equal(
    countLiveNotesWithSource(
      [
        { markdown: `已有 ${preview.sourceUrl}`, deletedAt: null },
        { markdown: `已删除 ${preview.sourceUrl}`, deletedAt: 1 },
      ],
      preview.sourceUrl,
    ),
    1,
  );
});

test("桌面和手机都能打开导入，创建新便签时不覆盖当前草稿", () => {
  const html = renderToStaticMarkup(
    createElement(WechatImportDialog, {
      notes: [],
      onClose: () => undefined,
      onCreateNote: () => undefined,
    }),
  );
  assert.match(html, /解析文章/);
  assert.match(html, /placeholder="https:\/\/mp\.weixin\.qq\.com\/s\/\.\.\."/);

  const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const sidebarSource = readFileSync(new URL("../../src/components/NoteSidebar.tsx", import.meta.url), "utf8");
  const dialogSource = readFileSync(
    new URL("../../src/components/WechatImportDialog.tsx", import.meta.url),
    "utf8",
  );
  const importedNote = appSource.match(/function handleCreateImportedNote\(markdown: string\) \{[\s\S]*?\n  \}/);

  assert.match(appSource, /className="desktop-toolbar-button desktop-import-wechat"[\s\S]*aria-label="导入公众号文章"/);
  assert.match(appSource, /className="mobile-list-import"[\s\S]*aria-label="导入公众号文章"/);
  assert.match(sidebarSource, /className="note-sidebar-import"[\s\S]*aria-label="导入公众号文章"/);
  assert.match(appSource, /setDesktopWorkspaceView\("editor"\)/);
  assert.match(appSource, /setMobileWorkspaceView\("editor"\)/);
  assert.ok(importedNote);
  assert.match(importedNote[0], /createNote\(markdown, folderId, shouldStar\)/);
  assert.match(importedNote[0], /writeCurrentNoteRoute\(\s*\{ noteId: createdNoteId, view: "editor" \}/);
  assert.match(importedNote[0], /activeCategoryId === "trash"/);
  assert.doesNotMatch(importedNote[0], /mobileDraftNoteIdRef/);
  assert.match(dialogSource, /rejectionForWechatImportInput/);
  assert.match(dialogSource, /beginWechatNoteCreation/);
  assert.match(dialogSource, /submittingRef/);
  assert.match(dialogSource, /创建便签/);
  assert.match(dialogSource, /取消/);
  assert.match(dialogSource, /className="ai-review-dialog"/);
  assert.match(dialogSource, /className="ai-review-instruction"/);
  assert.match(dialogSource, /className="ai-review-submit"/);
  assert.match(dialogSource, /className="ai-review-footer"/);
  assert.match(dialogSource, /className="is-primary"/);
  assert.doesNotMatch(dialogSource, /className="primary"/);
  assert.doesNotMatch(dialogSource, /className="wechat-import-submit"/);
});
