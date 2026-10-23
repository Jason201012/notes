# notes 的 Hugo 静态网站与 GitHub Pages 发布方案

研究日期：2026-10-22。本文件保留初始调研与后续发布规划；第一期按用户最新要求实现为独立面板与完整网站 ZIP，当前操作和实现以 `DOCS/site-publishing.md` 为准。GitHub 一键推送与部署仍属于后续范围。

## 结论

可行，且适合当前以 Markdown 为核心的 notes。建议把 notes 定位为写作与内容管理入口，把 Hugo 定位为公开网站构建器，把 GitHub Pages 定位为静态托管平台。编辑、账号、同步、图片导入与 PNG 导出继续由现有应用提供；博客访客阅读的页面不需要连接 notes 后端。

推荐分两期交付：先实现选择便签并导出兼容现有 Hugo 博客的文章包，再实现连接 GitHub、发布、更新、撤下及部署状态跟踪。最终产品目标包含应用内发布，ZIP 导出只是第一期交付。

用户已明确偏好参考博客的分类和模板。首要场景调整为接入 `zhaoolee/zhaoolee.github.io`，沿用它的栏目、模板、搜索与发布流水线。第一期优先提供兼容现有博客的文章包导出；完整独立站点导出保留为扩展场景。

## 当前项目可以复用的部分

| 现有能力 | 代码或文档 | 对新功能的价值与边界 |
| --- | --- | --- |
| Markdown 便签与稳定 ID | `src/types/app.ts` | 已有正文、创建及更新时间、文件夹、置顶、星标、回收站；缺少站点配置与公开状态 |
| 工作区解析与持久化 | `src/lib/notes.ts`、`server/auth.ts` | 支持匿名本地工作区、登录账号隔离及并发版本检查 |
| 整体便签 ZIP 导出 | `server/index.ts` 的 `buildWorkspaceArchive` | 已有异步进度、目录去重、图片收集、路径替换与 ZIP 打包；需要抽出通用部分 |
| 图片读取 | `resolveArchiveImage` | 已处理站内路径、同源绝对 URL、外站图片及 data URL；发布链路仍需独立校验资源权限和抓取范围 |
| 编辑与分享入口 | `src/App.tsx`、现有侧栏及设置 | 可增加站点设置、文章发布设置与站点发布面板 |
| Pages 流水线 | `.github/workflows/deploy-pages.yml` | 当前构建 `npm run build:static` 并发布 `dist/`，发布的是编辑器，不是 Hugo 博客 |

现有整体归档**包含回收站**，且使用便签标题生成文件名，不适合作为网站导出默认行为。网站导出必须单独选择公开文章，并使用稳定路径。`getNoteTitle()` 会把标题截断到 38 个字符，也不适合作为最终文章标题的唯一来源。

现有图片收集使用正则、正文使用全局字符串替换。网站发布应增加 Markdown 语法树转换，避免改写代码块、普通链接或漏掉引用式图片。第一期可以明确限定支持的图片语法，但不能静默产生断图。

## 参考博客的实际结构

参考仓库 [zhaoolee.github.io](https://github.com/zhaoolee/zhaoolee.github.io) 已经采用目标技术路线：

- [`hugo.toml`](https://github.com/zhaoolee/zhaoolee.github.io/blob/master/hugo.toml) 设置 `baseURL=https://zhaoolee.com/`、中文及自定义分类导航。
- [`pages.yml`](https://github.com/zhaoolee/zhaoolee.github.io/blob/master/.github/workflows/pages.yml) 在 `master` push 后安装 Hugo Extended 0.162.1，生成 `public/`，运行 Pagefind，再上传并部署 Pages 工件。
- 文章使用 `content/<栏目>/<文章目录>/index.md`，图片放在文章目录内的 `index.assets/`。
- [`single.html`](https://github.com/zhaoolee/zhaoolee.github.io/blob/master/layouts/_default/single.html) 输出目录、正文和 Pagefind 检索标记；文章头部有标题、日期、分类等 front matter。

因此无需为这一功能迁移博客生成技术。对现有博客，notes 只要生成兼容的文章包并写入约定目录，就能复用其构建部署流程。进一步检查了首页、列表和侧栏模板，栏目与收录规则如下。

| notes 发布面板的栏目 | 文章目录 | front matter 分类 |
| --- | --- | --- |
| 做法 | `content/guides/<publicationId>/index.md` | `categories: ["做法"]` |
| 软件 | `content/software/<publicationId>/index.md` | `categories: ["软件"]` |
| 硬件 | `content/hardware/<publicationId>/index.md` | `categories: ["硬件"]` |
| 项目 | `content/project/<publicationId>/index.md` | `categories: ["项目"]` |
| 杂谈 | `content/log/<publicationId>/index.md` | `categories: ["杂谈"]` |

“关于”是独立页面，第一版不作为普通文章发布栏目。现有网站导航本质上使用 Hugo section：只填写 `categories` 而把文章放入统一 `content/notes/`，不会进入现有五个专题。栏目映射需同时决定文件路径和元数据。

[`list.html`](https://github.com/zhaoolee/zhaoolee.github.io/blob/master/layouts/_default/list.html) 按当前栏目 `.RegularPages.ByDate.Reverse` 生成列表；[`sidebar.html`](https://github.com/zhaoolee/zhaoolee.github.io/blob/master/layouts/partials/sidebar.html) 的“最新”遍历全站有日期的普通页面，“专题”从菜单解析对应 section 的文章。按上述路径放入文章包并设置日期，可由这些模板自动收录；首次接入仍应实际构建验证。

[`index.html`](https://github.com/zhaoolee/zhaoolee.github.io/blob/master/layouts/index.html) 的首页主体仅渲染 `content/_index.md`，是站点介绍，不是自动文章流。新增文章会进入侧栏和对应栏目，不会自动改写首页介绍。发布功能默认保留这一设计。

文章继续使用既有 `single.html` 的目录、标题、日期、纸面与 Pagefind 标记。写入 `index.assets/<hash>.<ext>` 可与已有文章保持同一资源约定。发布配置记录远端路径，避免改栏目后残留旧文件；栏目迁移需在同一次提交中删除旧路径，并为旧 URL 设置 alias。

若后续把这套模板用于另一个项目站点，需要适配侧栏当前写死的 `/`、`/logo.png`、`/search/` 等地址。直接接入现有 `https://zhaoolee.com/` 根域不涉及该迁移。

通用开源版应提供自己的轻量默认模板。复用参考站的模板、图片或字体前，应确认相应授权，不把个人域名、统计 ID、菜单和署名当作用户默认配置。

## 产品流程

1. 在“设置 → 静态网站”填写站点名称、作者、站点 URL，并选择“新建独立博客”或“连接现有 Hugo 博客”。
2. 在便签中打开“文章发布设置”，设置完整标题、分类、摘要和可选 URL 名称。默认所有便签均为私人内容。
3. 发布面板显示本次新增、更新、撤下的文章，以及图片处理结果和目标站点地址。
4. 第一期点击“导出 Hugo 文章包”，下载按现有栏目组织的 Markdown 与图片 ZIP；向导说明向博客仓库导入。新建独立站点的完整源码导出作为后续选项。
5. 第二期点击“发布网站”，由后端生成内容快照并提交 GitHub；前端展示排队、构建中、部署中、已上线或失败，以及对应 Actions 链接。

日常编辑只产生“有未发布修改”，不会自动把每次保存推送到公网。选择文件夹可以帮助批量选择，但不能把移动文件夹、加星或置顶隐式解释为公开授权。回收站便签不能新发布；已经发布的文章被移入回收站时应提示其仍在线，并提供显式撤下操作。

## 推荐架构

```text
notes 编辑器
    ↓ 明确选择要公开的文章
发布快照与 Markdown 转换
    ↓ 收集文章图片并改写引用
Hugo 源码包
    ├─ 第一期：ZIP 下载 → 用户提交博客仓库
    └─ 第二期：GitHub API → 一次内容提交
                             ↓
                       GitHub Actions
                             ↓
                     Hugo → 可选 Pagefind
                             ↓
                        GitHub Pages
```

建议让 Hugo 在 Actions 中执行。这样 notes 生产容器无需增加 Go/Hugo 工具链，也无需执行用户提交的模板。应用内文章预览可以先沿用现有 Markdown 预览并说明排版差异；精确的站点预览应使用受控构建环境，作为后续能力。

博客仓库与 notes 应用源码仓库默认分离。GitHub Pages 每个仓库只能有一个站点，直接替换 notes 已有部署工件会覆盖编辑器站点。[GitHub Pages 站点类型](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

对参考博客有两种接入模式：

| 模式 | 内容写入位置 | 配置责任 |
| --- | --- | --- |
| 现有博客 | 五个现有 section 下、由 notes 创建的文章包 | 用户首选；保留既有模板、域名和部署流程；第一期优先导出兼容文章包 |
| 独立博客 | 新仓库的 `content/notes/<publicationId>/` | 扩展场景；导出站点模板、Hugo 配置与工作流 |

为了最快验证，可先导出少量文章包，手动放入参考博客的测试分支构建。正式实现不能全量镜像覆盖这个已有博客。

## Hugo 内容格式

建议采用 Hugo 的 leaf bundle，一篇文章及其图片放在同一目录，便于迁移与撤下。[Hugo page bundles](https://gohugo.io/content-management/page-bundles/)

```text
notes-blog/
  hugo.toml
  layouts/
  assets/
  content/
    notes/
      <publicationId>/
        index.md
        images/
          <内容哈希>.png
  .github/workflows/pages.yml
  .notes-publish-manifest.json
  README.md
```

文章 front matter 示例：

```yaml
---
title: "我的第一篇公开便签"
date: "2026-10-22T13:00:00+08:00"
lastmod: "2026-10-22T13:00:00+08:00"
draft: false
categories: ["随笔"]
tags: []
params:
  notesPublicationId: "公开文章的稳定标识"
---
```

元数据使用可信序列化器生成，不拼接用户输入。`date` 默认使用首次发布时间，`lastmod` 使用已发布快照的更新时间；可另存便签原始创建时间。全部时间显式携带时区。第一期不做定时发布，未来日期应提示而不是静默消失。[Hugo front matter](https://gohugo.io/content-management/front-matter/)

默认文章路径由独立 `publicationId` 固定，改标题、改文件夹不会改变 URL。`noteId` 与该标识的映射保存在账号私有配置中，公开清单只放公开文章 ID、文件路径和内容哈希。可选 slug 一旦上线默认固定；允许修改时应生成旧 URL 的 alias。

正文保留 Markdown 语义，图片改为 `images/<hash>.<ext>`。导出首页、文章列表、文章页、分类页、RSS、sitemap 和移动端基础样式；Pagefind 可在第二期加入。`public/` 是构建产物，不作为源码提交。[Hugo GitHub Pages 部署](https://gohugo.io/host-and-deploy/deploy-to-github-pages/)

## 兼容性与发布边界

### Markdown 与页面排版

普通段落、标题、列表、表格、任务列表、引用、链接、图片、代码块适合 Hugo Goldmark。notes 的首行 `[文字]` 居中规则、连续空行、逐行排版和卡片主题属于应用扩展，不会自动转成相同的 Hugo 页面。

第一期建议提供一种博客阅读主题，保证内容语义与移动阅读，不承诺七种卡片主题逐像素一致。标题优先使用发布面板的完整标题，默认从正文推导；是否去掉正文重复标题必须由明确转换规则决定，不能统一删除首个 `##`。

Hugo 会解析 shortcode。正文中的 `{{< ... >}}`、`{{% ... %}}` 需要作为普通文字转义或按明确白名单处理，代码示例也要验收；不把私人 Markdown 当作可信站点模板。[Hugo shortcodes](https://gohugo.io/content-management/shortcodes/)

### 图片与资源

- 自托管 `/images/*` 需复制到文章包，发布后即使 notes 后端下线仍可显示。
- 外链图片提供“打包到站点”与“保留外链”策略；默认打包可读取资源，失败时列出文章和图片，不静默上线断图。
- 图片内容哈希可去重，但不承诺不同文章包之间物理去重。跨文章公共资源池可后续优化。
- 不遍历复制 `storage/images`，只复制本次公开快照实际引用的资源；相对路径不得任意读取服务器文件。
- 外链抓取需限制协议、重定向、解析后的目标 IP、超时、单文件及总大小，防止抓取服务器内网；不能原样复用任意 URL 下载能力。
- 发布前校验是否有需要登录的图片、过期地址、临时链接和不适合公开的资源。

### 根域与项目子路径

既要支持根域 `https://<owner>.github.io/`，也要支持项目站点 `https://<owner>.github.io/<repo>/`，并允许自定义域名。实际基础地址由 Pages 配置确认，不仅依靠仓库名猜测。参考账号已经有用户站点，新站通常使用项目站点或单独域名。

Hugo 构建使用 Pages 提供的 base URL；模板链接、图片 render hook、CSS、RSS、sitemap、Pagefind 路径都要覆盖子路径测试。不得把 notes 编辑器的 `/assets/*`、`/images/*` 根路径假设照搬到博客。[Hugo image render hooks](https://gohugo.io/render-hooks/images/)

### 私人内容与公开仓库

未选中的便签、回收站、账号、安装票据、Token、密码及完整工作区 JSON 都不能进入导出包。不能仅靠 Hugo 的 `draft: true` 保护私人内容：提交到公开源码仓库后，草稿正文已经公开。

“撤下”表示删除当前发布文件并重新部署，不能消除公开 Git 历史、订阅抓取或外部缓存。修改和回滚只能恢复既有公开快照，不能自动扩大公开范围。

新站模板默认关闭未经清理的原始 HTML 与 inline shortcode；参考博客当前 `unsafe=true` 是既有站点选择，接入时需要单独确认受信内容规则，不能直接作为通用默认值。

## 数据与 API 设计建议

建议把站点设置和发布记录独立于便签正文存储，按当前登录账号隔离。避免把 GitHub 凭据塞入 `NoteWorkspace` 并随云同步或导出流转。

| 记录 | 建议字段 |
| --- | --- |
| SiteConfig | 站点 ID、拥有者、标题、作者、baseURL、仓库、分支、受管内容路径、模板版本 |
| Publication | noteId、publicationId、标题、slug、分类、标签、摘要、期望公开状态、首次发布时间 |
| Deployment | 任务 ID、快照哈希、base commit、提交 SHA、Actions run ID、当前阶段、错误、部署地址、已上线时间 |

发布记录需要区分“用户已选择公开”“GitHub 内容已提交”“对应快照已部署成功”。部署过程中继续编辑时，任务仍发布原快照；新改动保留为待发布。匿名用户第一期可导出；GitHub 连接及持续发布限定登录用户，避免跨设备凭据丢失与任务归属不明。

建议新增独立模块 `server/publishing/` 与 `src/lib/publishing/`，不要继续把全部逻辑堆入 `server/index.ts`。可选接口如下，具体命名在实现时定稿：

- `GET/PUT /api/sites/:siteId`：当前账号站点配置。
- `POST /api/sites/:siteId/export`：生成 Hugo 源码 ZIP 的任务。
- `POST /api/sites/:siteId/preview-changes`：计算新增、更新和撤下清单。
- `POST /api/sites/:siteId/deploy`：按快照启动发布。
- `GET /api/sites/:siteId/jobs/:jobId`：当前账号任务状态。

所有任务均校验拥有者；浏览器状态轮询只读取脱敏错误，不能依赖随机 job ID 充当唯一访问控制。高并发或需重启恢复时使用持久化任务，不直接照搬现有进程内 ZIP 任务 Map。

## GitHub 一键发布

自托管首版可支持仅授权目标仓库的 fine-grained PAT：常规提交需要 Contents write，查询部署流水线需要 Actions read。首次工作流和 Pages Source 可由用户按模板初始化，从而不要求日常内容 Token 拥有修改工作流或仓库管理权限。后续面向多用户服务时优先接 GitHub App，使用短期 installation token。

凭据只在服务端使用，按账号加密保存；加密主密钥独立于数据文件，纳入既有灾备设计。页面只显示连接状态和脱敏标识，不按现有公众号配置的明文回显方式实现。支持撤销连接与凭据轮换。

每次发布按以下步骤执行：

1. 锁定账号、站点和公开快照，生成变更清单，记录远端分支当前 SHA。
2. 使用 Git blobs、tree、commit 和 ref API，把 Markdown、图片及必要删除操作合成一次提交。使用 base tree 保留原仓库其他文件。[Git trees API](https://docs.github.com/en/rest/git/trees)
3. 提交前重新检查分支；有并发改动时重新读取、比较受管路径并重算差异，不 force push。一次提交只覆盖属于 notes 的受管文件。
4. 由内容 push 触发既有 Actions；如果分支受保护，则生成内容分支与 PR，进入等待合并状态。
5. 根据提交 SHA、工作流标识及 run ID 跟踪结果，防止把另一次部署的成功误判成本次成功。[Workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs)
6. 完成 Pages 部署后更新对应快照的上线记录；失败保留旧版站点和可重试信息。重试先核对已有提交，避免重复提交。

`.notes-publish-manifest.json` 只记录本工具生成的公开文件。清理文件时同时检查该清单及内容归属；遇到远端人工修改，先报冲突而不是覆盖。撤下删除整个受管文章包及图片，再触发完整构建；回滚从明确历史快照生成新提交。

Actions 内置 `GITHUB_TOKEN` 不能作为 notes 应用的长期访问凭据。若将来采用“Actions 拉取 notes 再 push”的模式，要考虑它产生的 push 通常不会触发下一个工作流；本方案由 notes 后端用 PAT 或 GitHub App 提交，可避免这一触发链问题。[GitHub 工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

## 分期范围与工作量

| 阶段 | 可交付结果 | 初步估算 |
| --- | --- | --- |
| 第一期 | 明确选择便签、栏目及文章设置、兼容既有模板的文章包 ZIP、图片打包、既有博客构建验证及导入说明 | 3–5 个工作日 |
| 第二期 | 连接已初始化 GitHub 仓库、一次提交、更新及撤下、部署状态、冲突处理、失败重试、Pagefind | 5–8 个工作日 |
| 扩展 | 面向多用户的 GitHub App 授权、自动初始化、持久化任务增强、精确预览或更多主题 | 另行拆分与估算 |

估算假设由一名熟悉本仓库的工程师实施、复用当前账号和图片设施、首版只维护一个站点模板。完整的一键发布首版约 8–13 个工作日；复杂主题适配、受保护分支组织策略与大规模图片库可能增加工时。这是规划估算，不是压测或交付承诺。

第一期不包含自动保存即发布、定时发布、多站点同时发布、评论系统、双向 GitHub 内容同步、七套主题逐像素迁移或新建独立站点。通用的应用内托管发布放在第二期。

## 验收标准

1. 只公开明确选中的文章；未选中、回收站和账号信息不出现在 ZIP、Git diff、RSS、sitemap 或搜索索引中。
2. 中文、完整长标题、同名便签、空标题、特殊字符、引用式图片、括号 URL 和代码块均有确定结果。
3. 首行居中语法、H2、任务列表、表格及连续空行有兼容样例；shortcode、HTML 与 front matter 不可改变站点配置或误执行模板。
4. 改标题或文件夹不改变既有 URL；明确改 slug 时旧链接可用。
5. 根域、项目子路径、自定义域名下的页面、图片、CSS、RSS、sitemap 和搜索都通过真实输出校验。
6. notes 后端不可达时，已经发布并打包资源的博客仍可独立阅读。
7. 一篇图文产生一次提交；重复发布相同快照不产生冗余提交；只删除自身生成的文件。
8. Token 过期、图片失败、Git 冲突、Actions 失败、部署超时、两端同时发布以及账号越权均有可恢复结果。
9. 撤下后页面和搜索索引不再包含文章；前端清楚区分待发布、构建中与已上线。
10. 功能实现时补充前后端 feedback、运行相关类型检查和构建，并同步 `CHANGELOG.md`。本次只有调研文档，不构成产品功能发布。

## 本次验证范围

使用本机 Hugo Extended 0.162.1 和合成中文内容完成两次独立构建：`https://example.test/` 与 `https://example.test/notes-blog/`。最终审查重新执行构建与验证脚本，128 项样例断言全部通过，覆盖中文路径、GFM 表格、任务列表、代码块、文章图片字节一致性、RSS、sitemap，以及生产构建排除草稿与未来文章。使用显式图片 render hook 验证了带站点前缀的资源 URL；普通相对链接也可能正常工作，不能据此断言所有站点都必须自定义 render hook。

临时样例和报告位于 `/private/tmp/notes-hugo-feasibility-knbpem/`；其中 `site/` 是源码，`report.json` 保存断言，`verify.py` 可复核输出。这只是生成格式的可行性样例，不是 notes 导出功能，也未验证参考博客的完整主题。

相关现有 feedback 结果：

- `node --import tsx --test frontend/tests/note-workspace.test.ts frontend/tests/markdown-rendering.test.ts`：56 项通过。
- `OPENAI_API_KEY='' OPENAI_BASE_URL='' REQUIRE_LOGIN=false node --import tsx --test backend/tests/workspace-archive-feedback.test.ts`：1 项通过，校验整体目录、Markdown、实际图片与异步进度。
- 后端测试初次在沙箱内因 `listen EPERM` 失败；沙箱外首次运行在健康检查前退出，显式隔离与本次研究无关的 AI 和登录配置后通过。没有为此修改应用或测试代码。

没有修改 GitHub 仓库或执行 Pages 部署；GitHub 凭据写入、真实提交、Actions 运行与在线撤下仍属于实施验收范围。

GitHub Pages 适合静态内容站点。当前发布站点大小上限为 1 GB，月流量软上限为 100 GB；图片较多时应在发布前提示总体积，并保留后续迁移对象存储或其他托管平台的余地。[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
