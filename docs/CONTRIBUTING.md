# 贡献指南（新增插件）

dsh-plugins 是插件集合仓库。新增插件请遵循官方 0811 插件规范
（[make-dsh-plugin](https://github.com/vlln/plugin-registry/blob/main/skills/make-dsh-plugin/SKILL.md)），
并按本集合约定落地。

## 新增插件步骤

1. **形态选择**：纯 cordis 插件（单 apply，走 insert 行，HMR 实时）或
   bundle 插件（`dsh.bundle.patch`，走层栈，重启生效）。默认选**纯 cordis**；
   需要组合层（多个 insert/config/disabled 随包分发）时选 bundle。
2. **建目录**：`plugins/<name>/`，包根即插件根：

   ```text
   plugins/<name>/
   ├── package.json      # name/version + main/exports + dsh.client
   ├── src/index.js      # Node half：完整 Cordis entry（name/inject/apply）
   ├── src/client.js     # Client half（有 UI 时）：__ModuleLoader__.load
   └── README.md         # 该插件文档
   ```

3. **package.json 规范**：
   - `main`/`exports["."]` 指向 Cordis entry；有 UI 加 `exports["./client"]` + `dsh.client: { platform: "web" }`
   - **不要声明 `@deepseek-ai/*` 或 `cordis` 依赖**（官方运行时经 profile pnpm 闭包注入）
   - `inject` 声明 `ctx.get` 用到的全部服务（0811 严格注入，未声明即抛错）
4. **集合集成**：在根 `cordis.patch.yml` 追加该插件的 insert 行（全部安装时生效）；
   README 插件目录表加一行。
5. **验证**：`pnpm check`（语法门禁）+ 按插件功能做安装冒烟（装 → 挂载 → 行为验证）。

## 开发纪律

- 门禁：`pnpm check` 对每个 `src/*.js` 做语法检查；有测试能力的插件补自证测试。
- 非平凡改动写决策记录（`docs/decisions/`，problem → decision → alternatives → consequences）。
- 生成物不手改（如 client bundle 构建产物由构建产生，`--check` 守卫新鲜度）。
- 首次环境行为（宿主覆盖、严格注入等坑）第一时间沉淀为决策记录标注「环境事实」。

## 发布

发包由 CI 完成，**本地不执行 `npm publish`**。

1. 升级 `plugins/<name>/package.json` 的 `version`（该值就是发布版本）。
2. 打 **annotated** tag，名 `v<插件目录名>-<版本>`（例 `vdsh-web-auth-0.4.0`）。CI 用最后一个 `-`
   拆出插件目录名与版本并与 `package.json` 比对，不一致直接中止；已推送的 tag 不移动。
3. 推 tag 触发 `.github/workflows/release.yml`（npm Trusted Publishing / OIDC，不用长期 token）：
   `npm pack` → 审计（tgz 必须含 `src/` 或 `scripts/`，含 `.env`/`.pem`/`.key`/`node_modules`/`.git`
   即中止）→ `sha256sum` → `npm publish --provenance`（该版本已存在则跳过）→ GitHub Release
   （同一 tgz + `.sha256`，已存在则跳过）。
4. 核验看 `https://registry.npmjs.org/-/package/<pkg>/dist-tags` 与 Release 资产；主 packument
   （`npm view`）发布后数分钟内可能仍是旧值，不能用作判据。

例外：**新包第一次发布**无法由 CI 引导（npm 没有 pending publisher，包必须先存在才能配 Trusted
Publisher），需手工 `npm publish` 一次，之后各版本都走 tag。

仓库 `description` 与 `topics` 按官方格式设置（功能词 3-6 个）。
