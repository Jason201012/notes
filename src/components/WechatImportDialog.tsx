import { useEffect, useId, useReducer, useRef, type FormEvent } from "react";
import { MarkdownText } from "./MarkdownText.js";
import {
  beginWechatNoteCreation,
  countLiveNotesWithSource,
  createInitialWechatImportState,
  rejectionForWechatImportInput,
  requestWechatImportPreview,
  wechatImportDialogReducer,
  wechatImportErrorMessage,
  type WechatImportDialogState,
  type WechatPreviewResponse,
} from "../lib/wechat-import.js";

interface WechatImportDialogProps {
  notes: Array<{ markdown: string; deletedAt: number | null }>;
  initialState?: WechatImportDialogState;
  previewArticle?: (url: string, signal: AbortSignal) => Promise<WechatPreviewResponse>;
  onClose: () => void;
  onCreateNote: (markdown: string) => void;
}

export function WechatImportDialog({
  notes,
  initialState,
  previewArticle = requestWechatImportPreview,
  onClose,
  onCreateNote,
}: WechatImportDialogProps) {
  const titleId = useId();
  const [state, dispatch] = useReducer(
    wechatImportDialogReducer,
    initialState ?? createInitialWechatImportState(),
  );
  const submittingRef = useRef(false);
  const creatingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const duplicateCount = state.result
    ? countLiveNotesWithSource(notes, state.result.sourceUrl)
    : 0;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  async function handleSubmit(event?: FormEvent) {
    event?.preventDefault();

    if (submittingRef.current || state.status === "loading" || state.status === "creating") {
      return;
    }

    const rejection = rejectionForWechatImportInput(state.url);

    if (rejection) {
      dispatch({ type: "fail-local", message: rejection });
      return;
    }

    const next = wechatImportDialogReducer(state, { type: "submit", url: state.url.trim() });

    if (next.status !== "loading") {
      return;
    }

    submittingRef.current = true;
    dispatch({ type: "submit", url: state.url.trim() });
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await previewArticle(next.url, controller.signal);

      if (!mountedRef.current) {
        return;
      }

      dispatch({ type: "succeed", requestId: next.requestId, result });
    } catch (error) {
      if (!mountedRef.current || (error instanceof Error && error.name === "AbortError")) {
        return;
      }

      dispatch({
        type: "fail",
        requestId: next.requestId,
        message: wechatImportErrorMessage(error),
      });
    } finally {
      submittingRef.current = false;
    }
  }

  function handleClose() {
    abortRef.current?.abort();
    onClose();
  }

  function handleCreate() {
    const decision = beginWechatNoteCreation(state, creatingRef.current);

    if (!decision) {
      return;
    }

    creatingRef.current = true;
    dispatch({ type: "create" });
    onCreateNote(decision.markdown);
  }

  const showForm = state.status === "idle" || state.status === "loading" || state.status === "error";
  const succeededImages = state.result
    ? state.result.images.imported + state.result.images.reused
    : 0;

  return (
    <div className="ai-review-backdrop wechat-import-backdrop" onClick={handleClose}>
      <section
        className="ai-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={state.status === "loading" || state.status === "creating"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ai-review-header">
          <div>
            <h2 id={titleId}>导入公众号文章</h2>
            <p>粘贴一篇公开的微信文章链接。确认预览后才会创建新便签，不会覆盖当前正在编辑的内容。</p>
          </div>
          <button type="button" aria-label="关闭导入公众号文章" onClick={handleClose}>
            ×
          </button>
        </header>
        <div className="ai-review-body">
          {showForm ? (
            <form className="wechat-import-form" onSubmit={(event) => void handleSubmit(event)}>
              <label className="ai-review-instruction">
                <span>文章链接</span>
                <textarea
                  value={state.url}
                  placeholder="https://mp.weixin.qq.com/s/..."
                  rows={3}
                  disabled={state.status === "loading"}
                  onChange={(event) => dispatch({ type: "edit", url: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
              </label>
              <button type="submit" className="ai-review-submit" disabled={state.status === "loading"}>
                {state.status === "loading" ? "正在解析…" : "解析文章"}
              </button>
            </form>
          ) : null}
          {state.status === "loading" ? (
            <p className="ai-review-empty" role="status">
              正在读取文章并下载图片…
            </p>
          ) : null}
          {state.errorMessage ? (
            <p className="ai-review-error" role="alert">
              {state.errorMessage}
            </p>
          ) : null}
          {state.result && (state.status === "preview" || state.status === "creating") ? (
            <div className="wechat-import-result">
              <dl>
                <div>
                  <dt>标题</dt>
                  <dd>{state.result.title}</dd>
                </div>
                <div>
                  <dt>公众号</dt>
                  <dd>{state.result.accountName || "未识别"}</dd>
                </div>
                <div>
                  <dt>发布时间</dt>
                  <dd>{state.result.publishedAt || "未识别"}</dd>
                </div>
                <div>
                  <dt>原文</dt>
                  <dd>
                    <a href={state.result.sourceUrl} target="_blank" rel="noreferrer">
                      {state.result.sourceUrl}
                    </a>
                  </dd>
                </div>
              </dl>
              <p className={state.result.images.failed > 0 ? "wechat-import-warning" : "ai-review-empty"}>
                图片成功 {succeededImages} / 失败 {state.result.images.failed}
              </p>
              {duplicateCount > 0 ? (
                <p className="wechat-import-warning">
                  当前工作区已有包含同一原文链接的便签，仍可以继续创建一篇新的。
                </p>
              ) : null}
              {state.result.warnings.length > 0 ? (
                <ul className="wechat-import-warnings">
                  {state.result.warnings.map((warning) => (
                    <li key={`${warning.code}-${warning.message}-${warning.sourceUrl ?? ""}`}>
                      {warning.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="wechat-import-preview">
                <MarkdownText>{state.result.markdown}</MarkdownText>
              </div>
            </div>
          ) : null}
        </div>
        <footer className="ai-review-footer">
          <p>
            {state.status === "preview" || state.status === "creating"
              ? "确认后会新建一篇便签"
              : "先解析文章链接"}
          </p>
          <div className="wechat-import-footer-actions">
            {state.status === "preview" || state.status === "creating" ? (
              <button
                type="button"
                onClick={() => dispatch({ type: "revise" })}
                disabled={state.status === "creating"}
              >
                修改链接
              </button>
            ) : null}
            <button type="button" onClick={handleClose} disabled={state.status === "creating"}>
              取消
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={handleCreate}
              disabled={state.status !== "preview" || !state.result?.markdown.trim()}
            >
              {state.status === "creating" ? "正在创建…" : "创建便签"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
