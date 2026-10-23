# Hugo 发布调研事实

## 2026-10-23

- 首页简介重复根因：`server/site-publishing/build.ts` 曾把 `settings.description` 同时写进 `content/_index.md` 的 `description` front matter 和 Markdown 正文；`theme.ts` 的 `layouts/index.html` 已在标题下渲染 `site.Params.description` 为 `.home-description`，随后 `.Content` 又把同一段简介渲染一次。修复只改生成侧：首页 front matter 保留 `description`（meta 描述仍生效），正文留空，模板与 `.Content` 支持不变。回归断言在 `backend/tests/site-publishing.test.ts` 的真实 Hugo 构建里统计 `.home-description` 恰好 1 个且文本正确、`.reader-sheet` 文本中简介只出现 1 次，并在默认（空）简介场景断言无 `.home-description`；空简介复用既有构建，不额外多建站点。

## 2026-10-22

- 最新账号同步与精简要求覆盖此前“仅本机保存”的说明：`GET/PUT /api/site-publishing/config` 通过 Cookie 会话和同源检查读写 `NotesDataStore.sitePublishingConfigurations`，只保存网站信息、Logo 相对路径、分类及便签 ID/归类，不重复保存正文。沿用原子写入队列，required `expectedUpdatedAt` CAS 防止跨设备覆盖，冲突409。浏览器的 `account-sync.ts` 串行防抖保存、失败本机缓存、旧v1首次迁移；账号已有配置时优先账号，未同步本机与其他设备有冲突时才出现版本选择，旧响应/账号切换会取消请求。
- 面板标题/按钮现在为“生成网站”/“生成网站 ZIP”；用户红框中的介绍、网站设置可见标题与重复说明、Logo 默认说明/格式说明、域名重复说明已删除。默认 Logo 只显示“上传图片”，自定义后才显示“更换图片”和“恢复默认”。保存状态缩为“已保存到账号”等短文案，不展示永久说明段落。
- 删除 notes 自定的200张发布上限，包括前端勾选、缓存恢复、导出模型与服务端；Hugo本身没有该200上限。保留正文/图片/ZIP总量、文件数、超时、并发与账号配置1MB保护。新增测试真实构建201篇，不能把服务资源保护描述成Hugo限制。
- 此轮完整 `npm test`、生产构建、27项相关前端测试通过；后端新增6项配置feedback覆盖持久化、旧库、账号隔离、同源/匿名、CAS、201篇真实Hugo。真实浏览器域名模式63项（`/tmp/notes-site-browser-ynuFN4/`）、空域名66项（`/tmp/notes-site-browser-au19kh/`）通过，使用第二个无缓存浏览器登录同账号，验证Logo/分类/上次选择/basePath恢复以及真实跨浏览器冲突解决。
- 本地18080已重载本轮版本（当次PID69028，具体进程见临时pids.json），Codex浏览器原v1设置首次迁入账号成功，面板保留网站标题/简介/作者、空域名、`/blog/`及5张便签各自分类，底部显示“已保存到账号”。默认Logo区仅有“上传图片”，页面无200张提示，最新截图 `/tmp/notes-site-preview-20261022/publish-panel-account-clean.png`。

- 2026-10-22 发布面板最终信息架构：默认主区域由 `SitePublishContent.tsx` 按 `draft.categories` 分组展示（宽屏两列、≤960px 单列）；每组只有分类名、数量、“添加便签”，无便签时没有空状态文案；组内每行是标题 + 小型移除（`aria-label="从「分类」移除标题"`）。组内选择器按需展开，只列非回收站便签，搜索、checkbox、“完成”齐全；checkbox 语义是“在当前组”，勾选已属其他组的便签会改写原 `draft.selections` 的 `categoryId`（移动，不重复），原分类用小 badge 提示。网站设置、Logo、域名、basePath 与分类改名/删除收进默认折叠的 `<details>`“高级设置”，每次挂载都不带 `open`；`SitePublishPanel` 仍负责 draft、账号同步与导出，`SitePublishContent` 只做呈现与回调。新增分类行只在主区域出现一份，由“添加分类”按需展开（名称/路径/创建按钮同一行），成功后收起；分类删除守卫（默认分类、仍有便签、只剩一个）保留在高级设置。
- 发布面板 UI 细节取舍：底部只保留“生成网站 ZIP”和简短保存状态，不再有“已选 N 张”汇总与“返回编辑”；空分组/已选表格不再渲染；`model.ts` 的 `SITE_THEMES` 仍只有 `smartisan-blog`，样式选择区仅在 `length > 1` 时出现在高级设置。界面上“作者”显示为“站长名”，`author` 字段、旧草稿、账号配置与 Hugo 契约不变。
- 焦点陷阱细节：折叠 `<details>` 的子控件仍留在 DOM 中，Chromium 下 `getClientRects()` 仍返回布局盒，只有 `element.checkVisibility({ checkVisibilityCSS: true })` 能识别不可见，因此 `focusableElements()` 用它过滤（不支持时退回 rects）；这样 `Shift+Tab` 从关闭按钮环绕时会跳到可见的“高级设置”summary，而不是隐藏的网站设置输入框。
- 本轮验证：`npm run typecheck`、`npm run build` 通过；site-publishing 前端 feedback 27 项通过（panel 19 + account-sync 8）。真实浏览器域名模式 112 项断言（`/tmp/notes-site-browser-8IuBju/`）、`SITE_PUBLISH_NO_ORIGIN=1` 空域名模式 115 项（`/tmp/notes-site-browser-hoAzdz/`）通过；新增检查覆盖默认高级折叠且分组可见、折叠时键盘环绕跳过隐藏字段、展开后编辑并折叠不丢值、按组添加/移动/移除便签、跨浏览器恢复、Logo 上传/恢复、真实 ZIP 与静态站点。未跑全量测试、未提交/推送/部署，未重启 18080/18081。
- 初始规划见 `DOCS/hugo-github-pages-plan.md`；第一期现已按后续用户要求实现为独立面板及完整网站 ZIP，当前行为见 `DOCS/site-publishing.md`。GitHub 一键推送和线上部署未实施。
- 用户明确偏好现有博客分类与模板，优先接入原仓库。五个文章栏目映射为做法→guides、软件→software、硬件→hardware、项目→project、杂谈→log；关于保持独立页面。
- 该博客按 section 组织专题，不能只写 `categories` 字段。栏目列表和侧栏专题读取 section 的 `.RegularPages`，最新侧栏读取全站有日期的普通页面；首页主体只渲染 `content/_index.md` 介绍文案。notes 应向 `content/<section>/<publicationId>/index.md` 写入文章包并沿用 `index.assets/`，不自动改首页介绍。
- 参考模板侧栏有 `/`、`/logo.png`、`/search/` 根路径；接入现有根域可沿用，复制到其他仓库的 Pages 子路径时需适配。
- notes 自身 `.github/workflows/deploy-pages.yml` 发布 Vite `dist/` 编辑器。Hugo 博客应使用独立仓库，或接入既有博客的受管内容路径，避免覆盖现有 Pages 站点。
- 参考 `zhaoolee/zhaoolee.github.io` 使用 Hugo Extended 0.162.1、`master` push、Pagefind 和 Pages artifact 部署，文章采用 `content/<section>/<article>/index.md` 加 `index.assets/`。站点有自定义域名、菜单和统计 ID，通用模板不能照搬个人配置。
- 现有 `buildWorkspaceArchive` 会导出回收站，且按标题命名文件；网站公开导出不能直接等同于整体归档。`getNoteTitle` 截断到 38 字符，发布标题需单独提取或由用户指定。
- Hugo 源码建议采用稳定文章 ID 的 leaf bundle，并复制文章实际引用的图片；公开状态在生成源码前筛选，不能只用 `draft:true`，以免草稿进入公开 Git 历史。
- 本机 Hugo v0.162.1 合成样例在根域和 `/notes-blog/` 两种 baseURL 下构建成功，128 项输出断言通过。覆盖中文路径、表格、任务列表、代码块、图像一致性、RSS、sitemap、草稿与未来文章默认排除。图片 render hook 已验证资源前缀，但并非所有相对图片链接都必须有自定义 hook。
- 临时工件 `/private/tmp/notes-hugo-feasibility-knbpem/` 可能被系统清理；结论限于生成格式，不能视为 GitHub 真实部署或参考站完整主题验收。
- 现有前端工作区与 Markdown 测试 56 项通过；整体图文归档测试 1 项通过。后者需要允许本地监听，并使用 `OPENAI_API_KEY='' OPENAI_BASE_URL='' REQUIRE_LOGIN=false` 隔离本次不相关的配置。

## 第一期实现与验收

- “发布为网站”位于桌面账号菜单“进入管理后台”上方，普通账号也可使用；手机通过设置的工具与扩展进入。面板独立模块为 `src/features/site-publishing/`，网站分类与工作区文件夹分离。
- 字段命名：面板与草稿使用 basePath（部署子路径），生成的 Hugo 配置使用官方 baseURL。旧 v1 localStorage 缺少 basePath 时才回退 rootPath，新字段存在时优先；旧客户端提交 rootPath 仍被接收，正常输出只含 basePath。
- 命名依据：Next.js 官方使用 `basePath` 表示域名下的路径前缀；Vite 使用 `base`，Docusaurus 使用 `baseUrl`，Hugo 使用包含协议、域名与路径的 `baseURL`，不存在跨框架统一配置键。沿用已有的 `basePath` 术语，避免将它描述为 Hugo 原生字段或跨框架标准。
- basePath 改名复验：相关 feedback 22 项、前端 feedback 169 项及生产构建通过；主代理浏览器验证填写域名 33 项（`/tmp/notes-site-browser-Gbm5fy/`）、空域名 36 项（`/tmp/notes-site-browser-g3j46Z/`）通过，覆盖真实 ZIP 下载、嵌套部署资源与静态搜索。
- 2026-10-22 本机交互预览：使用 `/tmp/notes-site-preview-20261022/` 的独立示例数据启动 `http://127.0.0.1:18080/`（账号 `preview`，密码 `notes-preview`，仅示例）和 `http://127.0.0.1:18081/blog/`（origin 留空、basePath `/blog/`）。服务仅绑定 loopback，未加载仓库 `.env` 或使用真实 storage。5 张便签经真实 API 导出，ZIP 位于该目录 `export/notes-hugo-site.zip`；进程、停止方式与13项HTTP检查见 `preview-info.json` 和 `health-report.json`。Codex 内置浏览器已登录、打开并填写发布面板，Hugo 文章页的图片和五分类导航可用；截图为 `publish-panel.png`、`hugo-home.png`、`hugo-article.png`。后续继续使用前检查服务是否仍运行，临时目录和PID不保证长期保留。
- 网站 Logo 已实现：`settings.logoPath` 缺省为空，默认锤子；自定义值只接受图片导入接口返回的 `/images/<sha256>.<ext>` 路径。上传支持 PNG/JPEG/WebP/GIF/AVIF，最大2MB，拒绝SVG；浏览器确认可解码后才替换原图，失败保留原Logo。后端用安全图片读取器和 sharp 转256×256透明PNG，放入源码和静态产物的 `logo.png`，品牌与favicon统一使用，导出后不依赖notes图片服务。Sharp将AVIF识别为 `heif` + `compression=av1`，读取器已映射为avif；图片导入接口也支持AVIF。
- Logo与网站标题、简介、站长名（内部 author）、可选域名、basePath、分类及已选便签归类同时保存在本机草稿与服务端账号配置中；旧草稿兼容，换浏览器或电脑登录同账号可恢复。上传中禁止生成，恢复默认、关闭或切账号后，晚到的上传结果不会覆盖当前设置。
- Logo最终验收：相关feedback28项、前端172项、后端84项与构建通过；主代理复验填写域名53项（`/tmp/notes-site-browser-v9Iq5b/`）、空域名56项（`/tmp/notes-site-browser-jfXglM/`）通过，包含损坏PNG上传不替换原AVIF、刷新/关闭重开恢复配置及真实Hugo站点品牌/favicon。已更新18080预览进程（当次PID54175，详见临时 `pids.json`）；真实页面刷新后保留原五张选择、分类、网站信息和空域名，Logo上传组件与保存提示可见。新版面板截图 `/tmp/notes-site-preview-20261022/publish-panel-logo.png`。
- 站点域名是可选字段，默认空串，草稿与 UI 都不预填 `example.com`；字段缺失/空串/空白保持空串，真实域名原样保留。basePath（本项目部署路径字段，Hugo 配置字段仍是 baseURL）支持 `/` 和多层子路径。填写域名时 baseURL 为 `origin + basePath`，生成 canonical、RSS、sitemap；留空时 baseURL 直接为 basePath（Hugo 0.162.1 已验证 `.Permalink` 只返回路径），不输出 canonical、RSS、sitemap，`robots.txt` 不指向 sitemap。两种模式的搜索索引都使用 RelPermalink，不携带 host。ZIP 同时包含 Hugo 源码与已经构建的 `public/`；部署子路径时复制 public 内的文件，而非整个源码包。
- 默认五类可改名和路径，可新增分类并为勾选便签归类。草稿以 `notes.site-publishing.v1:<账号ID>` 存在本机，不参与工作区云同步；退出关闭面板并取消请求。回收站和未选便签不提交导出接口。
- `POST /api/site-publishing/export` 要求网页登录 Cookie 和同源，入口在 `server/site-publishing/route.ts`。Hugo 仅执行可信内置模板，临时目录与子进程环境隔离，禁止外部命令、模板网络和环境变量访问，结束后清理。
- 主题 `smartisan-blog` 移植参考博客纸面和导航，适配所有静态资源的 basePath；搜索改用自带 JSON 索引，无需 Pagefind 或额外联网构建。只在首个 Markdown 标题与推导文章标题完全相同时去掉正文重复标题。
- 图片按 Markdown 语法树定位，支持引用式图片和括号 URL，保持代码示例与普通链接；拒绝本地越界、外部符号链接、非图像和内网。公开 HTTPS 下载固定已校验 DNS 并验证原域名 TLS，支持项目已有的域名 fake-ip 代理约定，不允许直接访问 fake-ip URL。
- Chromium 中 fieldset 直接作为 flex 滚动项可能让内容透过固定底栏；已改为外层 div 承担滚动，fieldset 仅处理 busy 禁用，底栏使用不透明纸面背景。移动端真实检查确保正文可滚动、按钮可见、没有横向溢出。
- 真实 Hugo 反馈覆盖“有/无域名 × 根/嵌套 basePath”四组输出，使用静态 host 解析实际 HTML 中的导航、图片、CSS/字体和搜索索引链接；空域名模式额外断言无 canonical、无 RSS/sitemap、无虚假域名及 README 不写 `https://example.com/blog`。浏览器脚本默认验证填写域名模式，设置 `SITE_PUBLISH_NO_ORIGIN=1` 时清空域名并验证部署路径与相对搜索链接。
- 改造前完整 `npm test` 共 260 项通过（前端 164、后端 79、DSH 17）；站点域名可选改造后相关 19 项通过，`npm run build` 通过。浏览器脚本默认保留填写域名模式，并新增 `SITE_PUBLISH_NO_ORIGIN=1` 空域名模式，均实际下载 ZIP、启动静态 host 并运行站内搜索。
- 域名可选改造由主代理复验：空域名浏览器模式 35 项断言通过（`/tmp/notes-site-browser-mAKErJ/`），填写域名模式 32 项通过（`/tmp/notes-site-browser-uxcTPu/`），相关 19 项 feedback 与生产构建再次通过。留空时可把同一份静态文件部署到不同域名的相同 basePath；这不等于可以不重建就改变 basePath。
- Docker 后端镜像 `notes-hugo-feedback:local` 在本机 arm64 构建通过，官方 Hugo Extended 0.162.1 下载 SHA256 校验通过；随后 `--network none` 容器内使用完整镜像资源成功生成网站。amd64 校验和已固定，但未在本机执行 amd64 镜像验收。
- `scripts/install-hugo.sh` 仅供镜像构建安装，拒绝本机非 root 执行；固定 Playwright 基础镜像已自带 curl 和 CA，不为安装 Hugo 重新改变 apt 依赖层。
- 本次最终浏览器报告与截图临时路径 `/tmp/notes-site-browser-QTiKE4/`，系统可能清理；可通过文档命令重现，不依赖用户日常账号或数据。未提交、推送或重启既有服务，保留任务开始前已有的工作区修改。
