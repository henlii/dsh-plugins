// dsh-auto-update client half — 插件配置卡片（一键更新 dsh）。
//
// 卡片样式对齐官方「插件配置」卡片（PluginCard.module.css 语义：
// --dsw-alias-* 变量、header 展开折叠、body 内表单 + footer 按钮）。
// 展示：当前版本 / 正式版(latest) / 预览版(next) / 回退到上一版本。
window.__ModuleLoader__.load({
	id: "dsh-auto-update",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-auto-update-client";
		const inject = ["slots", "settingsScope"];

		// 官方 PluginCard.module.css 语义的 CSS 变量版（无哈希类名，随主题走）。
		const CARD_CSS = `
.dsh-o-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}
.dsh-o-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsh-o-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-o-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsh-o-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-o-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsh-o-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dsh-o-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dsh-o-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dsh-o-chevronOpen{transform:rotate(180deg)}
.dsh-o-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.dsh-o-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex;flex-wrap:wrap}
.dsh-o-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsh-o-btn:disabled{opacity:.4;cursor:default}
.dsh-o-btn-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dsh-o-btn-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsh-o-btn-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-o-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box;width:100%}
.dsh-o-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-o-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dsh-o-err{color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5;margin:6px 0 0}
.dsh-o-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5;margin:6px 0 0}
.dsh-o-btn-mini{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 8px;font-size:12px;line-height:1.5;background:0 0;color:var(--dsw-alias-label-secondary)}
.dsh-o-btn-mini:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsh-o-btn-mini:disabled{opacity:.4;cursor:default}`;

		function AutoUpdateCard({ scope }) {
			const [open, setOpen] = react.useState(false);
			const [status, setStatus] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			const [busy, setBusy] = react.useState(null); // null | 'latest' | 'next' | 'rollback'
			const [msg, setMsg] = react.useState(null); // { err: bool, text }

			const snap = react.useSyncExternalStore(
				(cb) => scope.subscribe(cb),
				() => scope.getSnapshot()
			);
			const value = snap.value || {};

			const load = react.useCallback(() => {
				fetch("/api/dsh-auto-update/status", { credentials: "same-origin" })
					.then((res) => res.json().catch(() => ({})))
					.then((data) => {
						if (data && data.ok) { setStatus(data); setFailed(false); }
						else setFailed(true);
					})
					.catch(() => setFailed(true));
			}, []);

			react.useEffect(() => {
				if (!open) return undefined;
				load();
				const timer = setInterval(load, 5000);
				return () => clearInterval(timer);
			}, [open, load]);

			const upgrade = (target) => {
				if (busy !== null) return;
				setBusy(target); setMsg(null);
				fetch("/api/dsh-auto-update/upgrade", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ target })
				}).then((res) => res.json().catch(() => ({}))).then((data) => {
					if (data && data.ok) {
						setMsg({ err: false, text: `已在后台开始升级到 ${target}，完成后自动重启服务` });
						setTimeout(load, 2000);
					} else {
						setMsg({ err: true, text: (data && data.error) || "升级请求失败" });
					}
				}).catch(() => setMsg({ err: true, text: "无法连接服务器" }))
					.finally(() => setBusy(null));
			};

			const title = "dsh-auto-update";
			const current = status && status.current ? status.current : "…";
			const latest = status && status.tags && status.tags.latest ? status.tags.latest : null;
			const next = status && status.tags && status.tags.next ? status.tags.next : null;
			const canManaged = status && status.managed === true;
			const hasNewLatest = latest !== null && latest !== current;
			const hasNewNext = next !== null && next !== current;
			const rollbackAvailable = status && status.rollback === true && status.previous;

			const description = status === null
				? "版本信息加载中…"
				: !canManaged
					? (status.kind === "desktop-or-local" ? "桌面版/内嵌部署由宿主自带更新管理" : "当前部署不支持命令行升级")
					: `当前 ${current}` + (hasNewLatest ? ` · 正式版可升 ${latest}` : " · 已是最新正式版") + (next !== null && next !== current ? ` · 预览版 ${next}` : "");

			return react.createElement(react.Fragment, null,
				react.createElement("style", { "data-plugin-css": "dsh-auto-update/card", dangerouslySetInnerHTML: { __html: CARD_CSS } }),
				react.createElement("li", { className: open ? "dsh-o-card dsh-o-cardOpen" : "dsh-o-card" },
					react.createElement("button", {
						type: "button",
						className: "dsh-o-header",
						"aria-expanded": open,
						"aria-label": `${open ? "收起设置" : "展开设置"}: ${title}`,
						onClick: () => setOpen(!open)
					},
						react.createElement("span", { className: "dsh-o-headText" },
							react.createElement("span", { className: "dsh-o-name" }, title),
							react.createElement("span", { className: "dsh-o-description" }, description)),
						react.createElement("span", { className: open ? "dsh-o-chevron dsh-o-chevronOpen" : "dsh-o-chevron" }, "▾")),
					open ? react.createElement("div", { className: "dsh-o-body" },
						failed
							? react.createElement("p", { className: "dsh-o-err" }, "状态读取失败（可能未登录 / 服务未就绪）")
							: status === null
								? react.createElement("p", { className: "dsh-o-status" }, "加载中…")
								: react.createElement(react.Fragment, null,
									!canManaged ? react.createElement("p", { className: "dsh-o-status" },
										status.kind === "desktop-or-local"
											? "检测到桌面版 / 内嵌部署：dsh 由宿主（如 dsh-desktop）自带的更新机制管理，本卡片不提供命令行升级。"
											: "当前部署形态无法定位全局安装包，升级不可用。") : null,
									canManaged ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
										react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
											react.createElement("span", { className: "dsh-o-status" }, `当前 ${current}`),
											latest !== null ? react.createElement("span", { className: "dsh-o-status" }, `正式版 ${latest}`) : null,
											next !== null ? react.createElement("span", { className: "dsh-o-status" }, `预览版 ${next}`) : null),
										status.tagsError ? react.createElement("p", { className: "dsh-o-err" }, `版本查询失败：${status.tagsError}`) : null,
										react.createElement("div", { className: "dsh-o-footer", style: { borderTop: "none", padding: "4px 0 0" } },
											react.createElement("button", {
												type: "button", className: "dsh-o-btn dsh-o-btn-save",
												disabled: busy !== null || !hasNewLatest,
												onClick: () => upgrade("latest")
											}, busy === "latest" ? "升级中…" : "升级到正式版"),
											react.createElement("button", {
												type: "button", className: "dsh-o-btn dsh-o-btn-discard",
												disabled: busy !== null || !hasNewNext,
												onClick: () => upgrade("next")
											}, busy === "next" ? "升级中…" : "升级到预览版"),
											rollbackAvailable ? react.createElement("button", {
												type: "button", className: "dsh-o-btn dsh-o-btn-discard",
												disabled: busy !== null,
												onClick: () => upgrade(status.previous)
											}, busy === "rollback" ? "回退中…" : `回退到 ${status.previous}`) : null),
										react.createElement("p", { className: "dsh-o-status" },
											status.restart ? "升级完成后自动重启服务（systemd）" : "升级完成后需手动重启服务生效"),
										msg ? react.createElement("p", { className: msg.err ? "dsh-o-err" : "dsh-o-ok" }, msg.text) : null,
										react.createElement("p", { className: "dsh-o-status", style: { marginTop: 6 } },
											"升级在后台独立进程执行：安装完成后会先校验新版本可加载，校验通过才重启；失败则保持当前版本继续运行。")) : null)) : null));
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			const settingsScope = ctx.get("settingsScope");
			if (slots === void 0 || settingsScope === void 0) return;
			const scope = settingsScope.bind({ namespace: "dsh-auto-update" });
			slots.inject("settings.plugin.item", () => slots.register(
				{ name: "settings.plugin.item", key: "dsh-auto-update", priority: 1 },
				() => react.createElement(AutoUpdateCard, { scope })
			));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});