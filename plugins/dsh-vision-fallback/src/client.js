// dsh-vision-fallback client half — 插件配置卡片。
//
// 卡片在「设置 → 插件配置」里按 keyed namespace `dsh-vision-fallback`
// 派发：开关 + 视觉模型选择（provider/model 从官方 llm.models 目录加载，
// 只列声明支持 image 的模型）。写入走 settingsScope（Host settings 文档）。
window.__ModuleLoader__.load({
	id: "dsh-vision-fallback",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-vision-fallback-client";
		const inject = ["slots", "settingsScope"];

		// 官方插件配置卡片样式壳（PluginCard.module.css 语义，变量随主题）。
		// 与 dsh-auto-update / dsh-web-auth 的卡片共用同一套 dsh-o-* 类名，
		// 保证「插件配置」页所有卡片与官方一致。
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
.dsh-o-check{accent-color:var(--dsw-alias-brand-primary)}`;

		function VisionFallbackCard({ scope }) {
			const [open, setOpen] = react.useState(false);
			const [groups, setGroups] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [provider, setProvider] = react.useState("");
			const [model, setModel] = react.useState("");

			const snap = react.useSyncExternalStore(
				(cb) => scope.subscribe(cb),
				() => scope.getSnapshot()
			);
			const value = snap.value || {};
			const enabled = Boolean(value.enabled);
			const currentProvider = typeof value.provider === "string" ? value.provider : "";
			const currentModel = typeof value.model === "string" ? value.model : "";

			const loadCatalog = react.useCallback(() => {
				if (groups !== null) return;
				setFailed(false);
				fetch("/api/dsh-vision-fallback/models", { credentials: "same-origin" })
					.then((res) => res.json().catch(() => ({})))
					.then((data) => {
						if (!(data && data.ok)) { setFailed(true); return; }
						setGroups(data.groups || []);
						// 默认选中当前已保存的配置项；没有配置时选第一个可用模型。
						if (provider === "") {
							const groupsList = data.groups || [];
							if (currentProvider !== "") {
								const savedGroup = groupsList.find((g) => g.id === currentProvider);
								if (savedGroup) {
									setProvider(savedGroup.id);
									setModel(savedGroup.models.some((m) => m.id === currentModel) ? currentModel : savedGroup.models[0].id);
									return;
								}
							}
							const first = groupsList[0];
							if (first) {
								setProvider(first.id);
								setModel(first.models[0].id);
							}
						}
					})
					.catch(() => setFailed(true));
			}, [groups, provider, currentProvider, currentModel]);

			react.useEffect(() => {
				if (!open) return undefined;
				loadCatalog();
			}, [open, loadCatalog]);

			const save = () => {
				if (busy) return;
				if (!provider || !model) return;
				setBusy(true); setSaved(false);
				Promise.all([
					scope.set("enabled", enabled),
					scope.set("provider", provider),
					scope.set("model", model)
				]).then(() => {
					setSaved(true);
					setTimeout(() => setSaved(false), 1500);
				}).catch(() => {}).finally(() => setBusy(false));
			};

			const toggle = () => {
				if (busy) return;
				setBusy(true); setSaved(false);
				scope.set("enabled", !enabled)
					.catch(() => {})
					.finally(() => setBusy(false));
			};

			const activeGroup = groups ? groups.find((g) => g.id === provider) : void 0;
			const activeModels = activeGroup ? activeGroup.models : [];

			return react.createElement(react.Fragment, null,
				react.createElement("style", { "data-plugin-css": "dsh-vision-fallback/card", dangerouslySetInnerHTML: { __html: CARD_CSS } }),
				react.createElement("li", { className: open ? "dsh-o-card dsh-o-cardOpen" : "dsh-o-card" },
					react.createElement("button", {
						type: "button",
						className: "dsh-o-header",
						"aria-expanded": open,
						"aria-label": `${open ? "收起设置" : "展开设置"}: dsh-vision-fallback`,
						onClick: () => setOpen(!open)
					},
						react.createElement("span", { className: "dsh-o-headText" },
							react.createElement("span", { className: "dsh-o-name" }, "dsh-vision-fallback"),
							react.createElement("span", { className: "dsh-o-description" },
								enabled
									? `视觉回退已开启（${currentProvider} / ${currentModel}）`
									: "主模型非视觉时回退到视觉模型（当前关闭）")),
						react.createElement("span", { className: open ? "dsh-o-chevron dsh-o-chevronOpen" : "dsh-o-chevron" }, "▾")),
					open ? react.createElement("div", { className: "dsh-o-body" },
						react.createElement("p", { style: { margin: "0 0 10px" } },
							"当主模型不支持图片输入时，自动改用下方选择的视觉模型处理该轮请求。"),
						react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" } },
							react.createElement("input", {
								type: "checkbox", className: "dsh-o-check", checked: enabled, onChange: toggle, disabled: busy
							}),
							"启用视觉回退"),
						react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 } },
							react.createElement("select", {
								className: "dsh-o-input", value: provider, onChange: (e) => { setProvider(e.target.value); setModel(""); },
								disabled: !enabled || groups === null
							},
								groups === null
									? react.createElement("option", { value: "" }, "加载中…")
									: groups.length === 0
										? react.createElement("option", { value: "" }, "没有支持图片的模型")
										: groups.map((g) => react.createElement("option", { key: g.id, value: g.id }, g.name))),
							react.createElement("select", {
								className: "dsh-o-input", value: model, onChange: (e) => setModel(e.target.value),
								disabled: !enabled || activeModels.length === 0
							},
								activeModels.length === 0
									? react.createElement("option", { value: "" }, "选择模型")
									: activeModels.map((m) => react.createElement("option", { key: m.id, value: m.id }, m.name))),
							failed ? react.createElement("p", { className: "dsh-o-err", style: { margin: 0 } }, "模型目录加载失败") : null),
						react.createElement("div", { className: "dsh-o-footer" },
							react.createElement("button", {
								type: "button", className: "dsh-o-btn dsh-o-btn-save", disabled: busy || !enabled || !provider || !model, onClick: save
							}, busy ? "保存中…" : "保存"),
							saved ? react.createElement("span", { className: "dsh-o-ok", style: { margin: 0 } }, "已保存") : null,
							react.createElement("span", { style: { flex: 1 } }),
							react.createElement("span", { className: "dsh-o-status" },
								currentProvider && currentModel ? `当前：${currentProvider} / ${currentModel}` : "未配置"))) : null));
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			const settingsScope = ctx.get("settingsScope");
			if (slots === void 0 || settingsScope === void 0) return;
			const scope = settingsScope.bind({ namespace: "dsh-vision-fallback" });
			slots.inject("settings.plugin.item", () => slots.register(
				{ name: "settings.plugin.item", key: "dsh-vision-fallback", priority: 1 },
				() => react.createElement(VisionFallbackCard, { scope })
			));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
