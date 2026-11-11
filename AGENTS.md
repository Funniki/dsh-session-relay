# 项目约定

## 版本管理

- 版本号由用户决定：什么时候改、改成哪个号，等用户主动说，不自行递增。
- 只有插件代码发生实质变化才值得新版本；只改文档、脚本、构建流程不算。
- 实验性改动保持当前版本号，加 `-alpha.N` 后缀，发布时挂非 `latest` 的 dist-tag。

## 发布与推送

- **npm 发布、git push、推 tag、建 Release 都必须先得到用户明确同意。**
- 准备发布时，先给出「版本号 + 改动清单 + 将要执行的命令」，等用户说「传」再执行。
- commit 攒成一批再做，不为一点点改动就提交。
- Release 标题只写版本号本身（如 `0.1.1`），改动说明放正文。

## 发布前的验证门槛

- 结论必须对着**产物**验证，不能对着工作区；用户拿到的是 tarball / zip。
- 顺序：`node tools/build-release.cjs --check` → `node verification/plugin-smoke.test.mjs`
  → `node verification/verify-release.mjs --local` → `node tools/build-release.cjs`
  → `node verification/install-paths.test.mjs` → 发布后
  `node verification/verify-release.mjs --version <版本> --tag latest --install`。
- 跨宿主：`node verification/host-compat.test.mjs` 借另一版宿主的 `@deepseek-ai/dsh-tools` 校验工具 schema。
  没装第二份宿主时它会自动跳过；升级 `engines.dsh` 的上限前必须让它跑到。
- 全绿之前不报告完成，也不让用户去拉。

## 两个已经吃过亏的硬约束

- **浏览器半边的模块 id 必须等于包名。** 宿主按包名解析 bundle，不一致会让整个 web 启动失败，
  不是「插件没生效」那么温和。改名时必须同步 `package.json` 的 `name`、`lib/client.js` 的 `id`、
  `cordis.patch.yml` 的行 `name` —— 三处缺一不可。
- **不要手改 profile 里的 `node_modules`。** pnpm 用硬链接链到内容寻址存储，原地改写会污染 store，
  下一次 install 的完整性校验会把改动还原回去。要改就发新版本、走正常安装。

## 改名时不要动的两样东西

- **历史消息来源标签**：`lib/client.js` 的 `SOURCE_LABELS` 必须保留 `dsh-session-hub` / `session-hub`，
  否则旧会话里的中继卡片会认不出来。
- **已发布工具名的兼容**：0.1.1 把工具从 `hub_*` 改成了 `relay_*`，落盘规则里的旧名由
  `migrateRuleTools()` 在读状态时改写。以后若再改名，必须保留同样的迁移，不能让护栏静默失效。

## 切换安装形态（link ↔ npm）

- **删 `link:` 依赖会连链接目标里的文件一起删。** 已经发生过一次：`dsh plugin remove` 之后
  `session-hub/plugin/` 被整个清空（16 个文件），插件页当场报
  `ENOENT … session-hub\plugin\locale`。
- 删之前先确认开发目录已提交（`git status` 干净）；万一被删，`git restore plugin` 就能恢复。
- 装回 registry 版时 pnpm 可能报 `Already up to date` 但目录实际缺失 —— 用
  `dsh plugin --profile <名字> install --force` 强制拉一次，再用「版本 / 属性不是 ReparsePoint /
  `locale/` 里有文件」三项确认真的装上了。
- 桌面 profile 换成 registry 版之后，**开发目录的改动不再自动生效**：要本地联调就临时换回 link，
  测完换回 registry，并重跑发布门槛。

## 插件页展示（实测结论，别再猜）

- 插件页显示的正文**不是 README**，而是依次查找：`locale/<lang>.json` 里的 `meta.detail`
  → 它指向的那个 Markdown（如 `docs/DETAIL.zh.md`）。宿主源码里就是
  `localeDetail()`：读 `locale/${name}.json`、取 `meta.detail`、校验路径不越界。
- **没有 `meta.detail` 就回退到 README.md** —— 这正是最初「页面把整份 README 摊开」的原因。
  当时改 README、加 `docs/DETAIL.*` 都没用，因为缺的就是这个字段。
- 所以：`locale/*.json` 各自声明 `meta.detail`（zh → `docs/DETAIL.zh.md`，en → `docs/DETAIL.md`），
  DETAIL 写页面内容（示意图 + 简介），README 保持完整给 GitHub / npm。两边互不影响。
- DETAIL 里的相对图片以 DETAIL 所在目录解析；示意图必须被 DETAIL 引用，否则页面没有图。
- 审计强制：每个 `locale/*.json` 都要有 `meta.detail` 且目标文件存在；DETAIL 必须引用 preview。
- 参考实现：`dsh-rewind-plugin`（README 187 行，`locale/zh.json` 里有 `meta.detail: docs/DETAIL.zh.md`，
  DETAIL 只有一行图，页面就只显示那张图）。
- 想验证页面效果，别看推断：打 tarball 装进临时 profile、起 0.2.2 的 web、用浏览器打开插件页，
  并检查 `img.src` 里的 `document=` 参数指向哪个文件。
