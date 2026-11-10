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

## 插件页展示（实测结论，别再猜）

- 插件页渲染的就是 **`README.md`**，并把其中的相对图片解析到包内。宿主内置插件走的是编译进
  asar 的 `meta.detail`，**第三方插件没有这条通道** —— 放 `docs/DETAIL.*` 不会改变页面。
- 所以 README 是落地页，只放：一句话说明 → `docs/preview*.svg` 示意图 → 痛点。**到此为止**，
  细节一律搬到 `docs/GUIDE*.md`（中英各一份，随包发布）。
- README 里不写标题也行，页头已经显示包名；写了会出现同名重复。
- 审计会拒两种情况：README 不引用 preview 图（页面没有示意图）、`docs/GUIDE*.md` 缺失。
- 想验证页面效果，别看推断：打 tarball 装进临时 profile、起 0.2.2 的 web、用浏览器打开
  `/plugins` 截图确认。
