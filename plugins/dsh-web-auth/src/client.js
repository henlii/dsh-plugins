// dsh-web-auth client half — login overlay + auth status probe + settings card.
//
// The host half gates /api with an HttpOnly cookie, so the browser sends it
// automatically on every same-origin fetch and WebSocket handshake: no fetch
// wrapper or WS patching is needed.
//
// Login overlay: probes /api/auth/status at boot and shows a full-screen login
// when a non-loopback page needs a password. The overlay is deliberately NOT a
// Slot registration: it must be visible even while the shell is still booting
// and its API calls are 401ing, so it is appended straight to document.body.
//
// Settings card: registers the "插件配置" card (settings.plugin.item) so the
// deployment can see the auth status and how to change the password.
window.__ModuleLoader__.load({
	id: "dsh-web-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-web-auth-client";
		const inject = ["slots", "settingsScope", "connection"];

		// 官方插件配置卡片样式壳（PluginCard.module.css 语义，变量随主题）。
		// 与 dsh-auto-update / dsh-vision-fallback 共用同一套 dsh-o-* 类名。
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

		// ── 远程「打开配置文件」替代动作 ─────────────────────────────────────
		// 官方 settings.openDocument 把路径交给宿主原生打开器（xdg-open 等），
		// headless 服务器上必然失败（报「无法打开配置文件」）。本插件以同 id
		// `open-document`、priority -1 注册 settings.action，shadow 官方按钮；
		// 点击改为读取 /api/dsh-web-auth/settings-document，在模态框里展示
		// 配置文件内容（复制 / 下载），远程也能查看配置。
		function fallbackCopy(text, done) {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			try { document.execCommand("copy"); done(); } catch { /* 复制失败静默 */ }
			ta.remove();
		}

		function SettingsDocumentModal({ doc, onClose, onCopy, copied, onDownload, onSave, saving, saveError }) {
			const [draft, setDraft] = react.useState(doc.content);
			react.useEffect(() => {
				const onKeyDown = (e) => {
					if (e.key === "Escape") onClose();
					if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
						e.preventDefault();
						if (!saving) onSave(draft);
					}
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [onClose, onSave, draft, saving]);
			const dirty = draft !== doc.content;
			return react.createElement("div", {
				style: {
					position: "fixed", inset: 0, zIndex: 2147483001,
					display: "flex", alignItems: "center", justifyContent: "center",
					background: "rgba(10,12,18,0.72)",
					fontFamily: "system-ui,-apple-system,sans-serif"
				}
			},
				react.createElement("div", {
					style: {
						width: 960, maxWidth: "94vw", height: "88vh", maxHeight: "88vh", boxSizing: "border-box",
						padding: 24, borderRadius: 12, background: "#ffffff", color: "#1c2024",
						boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
						display: "flex", flexDirection: "column", gap: 12
					}
				},
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						react.createElement("strong", { style: { fontSize: 15, fontWeight: 600 } }, "配置文件"),
						react.createElement("code", {
							style: {
								flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
								whiteSpace: "nowrap", fontSize: 12, color: "#8a94a3"
							}
						}, doc.path),
						dirty ? react.createElement("span", { style: { fontSize: 12, color: "#b7791f" } }, "未保存") : null,
						react.createElement("button", {
							type: "button", onClick: onClose, "aria-label": "关闭",
							style: { border: 0, background: "none", cursor: "pointer", fontSize: 16, color: "#8a94a3", padding: 4 }
						}, "✕")),
					react.createElement("textarea", {
						value: draft, onChange: (e) => setDraft(e.target.value), spellCheck: false,
						style: {
							flex: 1, minHeight: 0, boxSizing: "border-box", width: "100%", padding: 12,
							border: "1px solid #d4d9e0", borderRadius: 8,
							fontFamily: "ui-monospace,Consolas,Menlo,monospace", fontSize: 13, lineHeight: 1.5,
							color: "#1c2024", background: "#fafbfc", resize: "none", outline: "none"
						}
					}),
					saveError ? react.createElement("p", { role: "alert", style: { margin: 0, color: "#c0392b", fontSize: 12 } }, saveError) : null,
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						react.createElement("button", {
							type: "button", onClick: onCopy,
							style: { padding: "6px 12px", border: "1px solid #d4d9e0", borderRadius: 8, background: "#fff", color: "#1c2024", font: "inherit", cursor: "pointer" }
						}, copied ? "已复制" : "复制内容"),
						react.createElement("button", {
							type: "button", onClick: onDownload,
							style: { padding: "6px 12px", border: "1px solid #d4d9e0", borderRadius: 8, background: "#fff", color: "#1c2024", font: "inherit", cursor: "pointer" }
						}, "下载文件"),
						react.createElement("span", { style: { flex: 1 } }),
						react.createElement("button", {
							type: "button", disabled: saving || !dirty, onClick: () => onSave(draft),
							style: { padding: "6px 14px", border: 0, borderRadius: 8, background: "#1f6feb", color: "#fff", font: "inherit", cursor: (saving || !dirty) ? "default" : "pointer", opacity: (saving || !dirty) ? 0.5 : 1 }
						}, saving ? "保存中…" : "保存 (Ctrl+S)"),
						react.createElement("button", {
							type: "button", onClick: onClose,
							style: { padding: "6px 14px", border: "1px solid #d4d9e0", borderRadius: 8, background: "#fff", color: "#1c2024", font: "inherit", cursor: "pointer" }
						}, "关闭"))));
		}

		function SettingsDocumentAction({ describe, api }) {
			const [doc, setDoc] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [copied, setCopied] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [saveError, setSaveError] = react.useState(null);
			const snap = react.useSyncExternalStore(
				(cb) => describe.subscribe(cb),
				() => describe.getSnapshot()
			);
			react.useEffect(() => { void describe.ensure(); }, [describe]);
			const hasDocument = snap.view !== void 0 && snap.view.hasDocument;

			const open = () => {
				if (busy) return;
				setBusy(true); setError(null); setSaveError(null);
				fetch("/api/dsh-web-auth/settings-document", { credentials: "same-origin" })
					.then((res) => res.json().catch(() => ({})))
					.then((data) => {
						if (!(data && data.ok)) {
							setError((data && data.error) || "无法读取配置文件");
							return;
						}
						if (data.canOpenNative) {
							// 宿主有桌面打开器：走官方 RPC（本机回环场景）。
							return api.settings.openDocument({}).then((r) => {
								if (!(r && r.result && r.result.ok)) {
									setError((r && r.result && r.result.error && r.result.error.message) || "无法打开配置文件");
								}
							});
						}
						setDoc({ path: data.path, content: data.content });
						setCopied(false);
					})
					.catch(() => setError("无法连接服务器"))
					.finally(() => setBusy(false));
			};
			const save = (content) => {
				if (saving || !doc) return;
				setSaving(true); setSaveError(null);
				fetch("/api/dsh-web-auth/settings-document/write", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ content })
				}).then((res) => res.json().catch(() => ({}))).then((data) => {
					if (data && data.ok) {
						setDoc({ path: data.path, content });
					} else {
						setSaveError((data && data.error) || "保存失败");
					}
				}).catch(() => setSaveError("保存失败：无法连接服务器"))
					.finally(() => setSaving(false));
			};
			const copy = () => {
				if (!doc) return;
				const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(doc.content).then(done).catch(() => fallbackCopy(doc.content, done));
				} else fallbackCopy(doc.content, done);
			};
			const download = () => {
				if (!doc) return;
				const blob = new Blob([doc.content], { type: "text/plain;charset=utf-8" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = doc.path.split("/").pop() || "settings.yaml";
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			};

			if (!hasDocument) return null;
			return react.createElement(react.Fragment, null,
				react.createElement("button", {
					type: "button", disabled: busy, onClick: open,
					style: { padding: "6px 12px", border: "1px solid #d4d9e0", borderRadius: 8, background: "#fff", color: "#1c2024", font: "inherit", cursor: busy ? "default" : "pointer" }
				}, busy ? "读取中…" : "打开配置文件"),
				error ? react.createElement("span", { role: "alert", style: { color: "#c0392b", fontSize: 12, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, error) : null,
				doc ? react.createElement(SettingsDocumentModal, {
					doc, onClose: () => setDoc(null), onCopy: copy, copied, onDownload: download,
					onSave: save, saving, saveError
				}) : null);
		}

		function formatTs(ms) {
			if (!ms) return "—";
			try { return new Date(ms).toLocaleString("zh-CN", { hour12: false }); }
			catch { return String(ms); }
		}

		function AuthInfoCard() {
			const [info, setInfo] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			const [open, setOpen] = react.useState(false);
			const [sessions, setSessions] = react.useState([]);
			const [password, setPassword] = react.useState("");
			const [confirm, setConfirm] = react.useState("");
			const [actionMsg, setActionMsg] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			const loadStatus = react.useCallback(() => {
				return fetch("/api/auth/status", { credentials: "same-origin" })
					.then((res) => res.json().catch(() => ({})))
					.then((data) => {
						if (data && data.ok) { setInfo(data); setFailed(false); }
						else setFailed(true);
					})
					.catch(() => setFailed(true));
			}, []);

			const loadSessions = react.useCallback(() => {
				return fetch("/api/auth/sessions", { credentials: "same-origin" })
					.then((res) => res.json().catch(() => ({})))
					.then((data) => {
						if (data && data.ok && Array.isArray(data.sessions)) setSessions(data.sessions);
					})
					.catch(() => {});
			}, []);

			react.useEffect(() => { void loadStatus(); }, [loadStatus]);
			react.useEffect(() => {
				if (!open) return undefined;
				void loadSessions();
				const timer = setInterval(() => { void loadSessions(); }, 5000);
				return () => clearInterval(timer);
			}, [open, loadSessions]);

			const savePassword = () => {
				if (busy) return;
				if (!password) { setActionMsg({ err: true, text: "请输入新密码" }); return; }
				if (password !== confirm) { setActionMsg({ err: true, text: "两次输入不一致" }); return; }
				setBusy(true); setActionMsg(null);
				fetch("/api/auth/password", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password })
				}).then((res) => res.json().catch(() => ({}))).then((data) => {
					if (data && data.ok) {
						setPassword(""); setConfirm("");
						setActionMsg({ err: false, text: "密码已保存，其它会话已退出" });
						void loadStatus(); void loadSessions();
					} else setActionMsg({ err: true, text: (data && data.error) || "保存失败" });
				}).catch(() => setActionMsg({ err: true, text: "无法连接服务器" }))
				.finally(() => setBusy(false));
			};

			const revoke = (id, current) => {
				if (busy) return;
				setBusy(true); setActionMsg(null);
				fetch("/api/auth/sessions/revoke", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id })
				}).then((res) => res.json().catch(() => ({}))).then((data) => {
					if (!(data && data.ok && data.revoked)) {
						setActionMsg({ err: true, text: (data && data.error) || "删除失败" });
						return;
					}
					if (current) { window.location.reload(); return; }
					void loadSessions();
				}).catch(() => setActionMsg({ err: true, text: "无法连接服务器" }))
				.finally(() => setBusy(false));
			};

			const title = "dsh-web-auth";
			const description = "内网/LAN 访问密码认证与信任插件";
			const sourceLabel = info === null || !info.passwordConfigured ? "" : info.passwordSource === "passwordFile" ? "密码文件" : info.passwordSource === "env" ? "环境变量" : "未知";

			return react.createElement(react.Fragment, null,
				react.createElement("style", { "data-plugin-css": "dsh-web-auth/card", dangerouslySetInnerHTML: { __html: CARD_CSS } }),
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
					open && react.createElement("div", { className: "dsh-o-body" },
						failed
						? react.createElement("p", { className: "dsh-o-err", style: { margin: 0 } }, "（需登录后查看）")
						: info === null
							? react.createElement("p", { style: { margin: 0 } }, "加载中…")
							: react.createElement(react.Fragment, null,
								react.createElement("p", { style: { margin: "0 0 8px" } },
									react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 500, marginRight: 8 } }, "当前密码"),
									info.passwordConfigured ? `已配置（${sourceLabel}）· 会话 ${String(info.ttlHours)} 小时` : "未配置"),
								react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 } },
									react.createElement("input", {
										type: "password", className: "dsh-o-input", placeholder: "新访问密码", value: password,
										onChange: (e) => setPassword(e.target.value)
									}),
									react.createElement("input", {
										type: "password", className: "dsh-o-input", placeholder: "再输一次", value: confirm,
										onChange: (e) => setConfirm(e.target.value),
										onKeyDown: (e) => { if (e.key === "Enter") savePassword(); }
									}),
									react.createElement("div", { className: "dsh-o-footer", style: { borderTop: "none", padding: "4px 0 0", justifyContent: "flex-start" } },
										react.createElement("button", {
											type: "button", className: "dsh-o-btn dsh-o-btn-save", disabled: busy, onClick: savePassword
										}, busy ? "保存中…" : "保存密码"))),
								react.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 500, margin: "4px 0 6px" } }, `已登录（${String(sessions.length)}）`),
								sessions.length === 0
									? react.createElement("p", { className: "dsh-o-status" }, "暂无活动会话（本机回环访问不发 cookie）")
									: sessions.map((s) => react.createElement("div", {
										key: s.id,
										style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" }
									},
										react.createElement("div", { style: { flex: 1, minWidth: 0 } },
											react.createElement("div", { style: { color: "var(--dsw-alias-label-primary)" } },
												s.peer || "未知地址",
												s.current ? react.createElement("span", { style: { marginLeft: 6, color: "var(--dsw-alias-state-success-primary)", fontSize: 12 } }, "当前") : null),
											react.createElement("div", { className: "dsh-o-status", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
												`最近 ${formatTs(s.lastSeen)} · 签发 ${formatTs(s.issuedAt)}`)),
										react.createElement("button", {
											type: "button", className: "dsh-o-btn-mini", disabled: busy, onClick: () => revoke(s.id, s.current)
										}, "删除"))),
								actionMsg ? react.createElement("p", { style: { margin: "8px 0 0", color: actionMsg.err ? "var(--dsw-alias-label-error)" : "var(--dsw-alias-state-success-primary)", fontSize: 12 } }, actionMsg.text) : null,
								react.createElement("p", { className: "dsh-o-status", style: { marginTop: 10 } },
									"保存密码会写入密码文件（优先于环境变量，立即生效），并踢掉其它已登录会话。")))));
		}

		function apply(ctx) {
			const overlay = document.createElement("div");
			overlay.id = "dsh-web-auth-overlay";
			overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:none;" +
				"align-items:center;justify-content:center;background:rgba(10,12,18,0.72);" +
				"font-family:system-ui,-apple-system,sans-serif;";

			const card = document.createElement("div");
			card.style.cssText = "width:360px;box-sizing:border-box;padding:28px;border-radius:12px;" +
				"background:#ffffff;color:#1c2024;box-shadow:0 18px 60px rgba(0,0,0,0.35);";

			const title = document.createElement("h1");
			title.textContent = "访问需要密码";
			title.style.cssText = "margin:0 0 6px;font-size:18px;font-weight:600;";

			const hint = document.createElement("p");
			hint.textContent = "请输入该 dsh 实例的访问密码";
			hint.style.cssText = "margin:0 0 18px;font-size:13px;color:#5a6472;";

			const input = document.createElement("input");
			input.type = "password";
			input.placeholder = "访问密码";
			input.style.cssText = "width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:12px;" +
				"border:1px solid #d4d9e0;border-radius:8px;font-size:14px;outline:none;";

			const error = document.createElement("p");
			error.style.cssText = "margin:0 0 12px;font-size:13px;color:#c0392b;display:none;";

			const button = document.createElement("button");
			button.textContent = "登录";
			button.style.cssText = "width:100%;padding:10px 0;border:0;border-radius:8px;" +
				"background:#1f6feb;color:#ffffff;font-size:14px;font-weight:600;cursor:pointer;";

			card.append(title, hint, input, error, button);
			overlay.appendChild(card);

			const show = (message) => {
				if (message) {
					error.textContent = message;
					error.style.display = "block";
				}
				overlay.style.display = "flex";
			};
			const doLogin = async () => {
				button.disabled = true;
				button.textContent = "验证中…";
				error.style.display = "none";
				try {
					const res = await fetch("/api/auth/login", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ password: input.value })
					});
					const data = await res.json().catch(() => ({}));
					if (res.ok && data && data.ok) {
						window.location.reload();
						return;
					}
					show((data && data.error) || "登录失败");
					input.select();
				} catch {
					show("无法连接服务器");
				}
				button.disabled = false;
				button.textContent = "登录";
			};
			button.addEventListener("click", doLogin);
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") void doLogin();
			});

			const mount = () => {
				(document.body || document.documentElement).appendChild(overlay);
			};
			if (document.body) mount();
			else document.addEventListener("DOMContentLoaded", mount);

			// Probe auth status once at boot; the host answers 200 for loopback
			// peers, so the overlay only appears on pages that need auth.
			(async () => {
				try {
					const res = await fetch("/api/auth/status", {
						method: "GET",
						credentials: "same-origin"
					});
					if (res.status === 200) return;
					if (res.status === 503) {
						show("服务端未配置访问密码");
						return;
					}
					show("");
				} catch {
					show("无法连接服务器");
				}
			})();

			// Register the 插件配置 card so the deployment can see auth status.
			// priority 1：排在官方默认卡片（priority 0）之后。
			const slots = ctx.get("slots");
			if (slots !== void 0) {
				slots.inject("settings.plugin.item", () => slots.register(
					{ name: "settings.plugin.item", key: "dsh-web-auth", priority: 1 },
					() => react.createElement(AuthInfoCard)
				));
			}

			// Shadow the official "打开配置文件" header action: same list-slot id
			// `open-document` at a lower priority wins the cell (SlotCore picks the
			// first live entry per id in priority order), so the remote page gets a
			// working viewer instead of the native-opener RPC that fails headless.
			const settingsScope = ctx.get("settingsScope");
			const connection = ctx.get("connection");
			if (slots !== void 0 && settingsScope !== void 0 && connection !== void 0) {
				const describe = settingsScope.describe();
				const api = connection.api;
				slots.inject("settings.action", () => slots.register(
					{
						name: "settings.action",
						id: "open-document",
						priority: -1,
						inject: () => ({ describe, api })
					},
					(props) => react.createElement(SettingsDocumentAction, props)
				));
			}

			ctx.effect(() => () => {
				overlay.remove();
			}, "dsh-web-auth: overlay cleanup");
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
