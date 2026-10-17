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
// Settings card: contributes the "访问认证" section to this plugin's own page
// under Plugins → Installed (plugins.detail.section), next to the configuration
// the official page renders from the Host form. The section stays inert for
// every other subject. The same card is also a Settings page of its own
// (settings.section — the seat dsh-update uses), so the password and the bind
// controls are reachable without hunting for the plugin's detail page.
//
// Bind control: the web server's host/port live under the password UI. Writing
// them cannot happen in the browser or at runtime — the Host hands the choice to
// the official `configEditor`, which persists the row and reconciles the Loader,
// so the save usually answers nothing (the connection dies with the old
// listener). The card therefore treats a network error as "submitted" and probes
// the new address itself.
window.__ModuleLoader__.load({
	id: "@henlii/dsh-web-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-web-auth-client";
		// 本插件包名：详情页只有这一个 subject 需要渲染。
		const PACKAGE_NAME = "@henlii/dsh-web-auth";
		// 只声明 0.1.7 客户端确实存在的服务。configForms / remote.settings 由
		// 下面 ctx.inject 延迟取用（装载顺序不确定，声明在 inject 里会一直 pending）。
		const inject = ["slots"];

		// 卡片壳样式（PluginCard.module.css 语义，变量随主题）。
		const CARD_CSS = `
.dsh-o-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.dsh-o-cardBody{padding:16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.dsh-o-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px}
.dsh-o-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex;flex-wrap:wrap}
.dsh-o-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsh-o-btn:disabled{opacity:.4;cursor:default}
.dsh-o-btn-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dsh-o-btn-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-o-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box;width:100%}
.dsh-o-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-o-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dsh-o-err{color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5;margin:6px 0 0}
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

		function SettingsDocumentModal({ doc, onClose, onCopy, copied, onDownload, onSave, saving, saveError, canOpenNative, onOpenNative, openNativeError }) {
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
					openNativeError ? react.createElement("p", { role: "alert", style: { margin: 0, color: "#c0392b", fontSize: 12 } }, openNativeError) : null,
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						react.createElement("button", {
							type: "button", onClick: onCopy,
							style: { padding: "6px 12px", border: "1px solid #d4d9e0", borderRadius: 8, background: "#fff", color: "#1c2024", font: "inherit", cursor: "pointer" }
						}, copied ? "已复制" : "复制内容"),
						react.createElement("button", {
							type: "button", onClick: onDownload,
							style: { padding: "6px 12px", border: "1px solid #d4d9e0", borderRadius: 8, background: "#fff", color: "#1c2024", font: "inherit", cursor: "pointer" }
						}, "下载文件"),
						// 有桌面打开器的宿主（例如就坐在服务器前面）可以交给本机程序打开，
						// 远程浏览器里它只是多余的一个按钮。
						canOpenNative ? react.createElement("button", {
							type: "button", onClick: onOpenNative,
							style: { padding: "6px 12px", border: "1px solid #d4d9e0", borderRadius: 8, background: "#fff", color: "#1c2024", font: "inherit", cursor: "pointer" }
						}, "在服务器本机打开") : null,
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

		function SettingsDocumentAction({ describe, openNative }) {
			const [doc, setDoc] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [copied, setCopied] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [saveError, setSaveError] = react.useState(null);
			const [canOpenNative, setCanOpenNative] = react.useState(false);
			const [openNativeError, setOpenNativeError] = react.useState(null);
			const snap = react.useSyncExternalStore(
				(cb) => describe.subscribe(cb),
				() => describe.getSnapshot()
			);
			react.useEffect(() => { void describe.ensure(); }, [describe]);
			const hasDocument = snap.view !== void 0 && snap.view.hasDocument;

			// 一律在浏览器里打开：宿主能原生打开也只是一条额外选项（“在服务器本机打开”），
			// 因为远程访客看不到服务器桌面（以前这里反而是默认路径，于是点了像没反应）。
			const open = () => {
				if (busy) return;
				setBusy(true); setError(null); setSaveError(null); setOpenNativeError(null);
				fetch("/api/dsh-web-auth/settings-document", { credentials: "same-origin" })
					.then((res) => res.json().catch(() => ({})))
					.then((data) => {
						if (!(data && data.ok)) {
							setError((data && data.error) || "无法读取配置文件");
							return;
						}
						setCanOpenNative(Boolean(data.canOpenNative));
						setDoc({ path: data.path, content: data.content });
						setCopied(false);
					})
					.catch((err) => setError(err instanceof Error && err.message.length > 0 ? err.message : "无法连接服务器"))
					.finally(() => setBusy(false));
			};
			const openOnHost = () => {
				setOpenNativeError(null);
				openNative().then((r) => {
					if (!(r && r.ok)) setOpenNativeError((r && r.error && r.error.message) || "无法打开配置文件");
				}).catch((err) => setOpenNativeError(err instanceof Error && err.message.length > 0 ? err.message : "无法打开配置文件"));
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
					onSave: save, saving, saveError, canOpenNative, onOpenNative: openOnHost, openNativeError
				}) : null);
		}

		function formatTs(ms) {
			if (!ms) return "—";
			try { return new Date(ms).toLocaleString("zh-CN", { hour12: false }); }
			catch { return String(ms); }
		}

		// ── 服务绑定（host / port）──────────────────────────────────────────
		// 面板只把选择 POST 给宿主，宿主用官方 configEditor 写进当前 profile 的
		// patch 并重启 webserver fiber。重启关掉旧监听时本页连接一起断，保存响应
		// 经常回不来，所以网络错误按「已提交」处理，再去探新地址是否真的起来。
		// 候选地址由宿主给（本机网卡 + 回环，逐个过 webserver 的 schema 筛过；
		// dsh 0.2.1-rc.2 起 0.0.0.0 会被 schema 拒，就不会出现在这里）。
		const BIND_HOST_LABELS = {
			"127.0.0.1": "仅本机（127.0.0.1）",
			"0.0.0.0": "所有网卡（0.0.0.0）"
		};

		function ServiceBindBlock() {
			const [state, setState] = react.useState(null);
			const [hosts, setHosts] = react.useState([]);
			const [host, setHost] = react.useState("127.0.0.1");
			const [port, setPort] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			const [target, setTarget] = react.useState(null);

			const load = react.useCallback(() => {
				return fetch("/api/dsh-web-auth/bind", { credentials: "same-origin", cache: "no-store" })
					.then((res) => res.json().catch(() => ({})).then((data) => ({ res, data })))
					.then(({ res, data }) => {
						if (!res.ok || !data || !data.ok) {
							setState({
								editable: false,
								reason: res.status === 404
									? "宿主还没加载绑定接口（重启 dsh 后可用）"
									: (data && data.error) || "无法读取绑定状态"
							});
							return;
						}
						setState(data);
						if (Array.isArray(data.hosts)) setHosts(data.hosts);
						if (typeof data.host === "string" && data.host.length > 0) setHost(data.host);
						if (typeof data.port === "number") setPort(String(data.port));
					})
					.catch(() => setState({ editable: false, reason: "无法连接服务器" }));
			}, []);
			react.useEffect(() => { void load(); }, [load]);

			// 重启期间旧 origin 会有几百毫秒不可达，重试几次再下结论。
			const reloadState = async (attempts) => {
				for (let i = 0; i < attempts; i += 1) {
					await new Promise((resolve) => setTimeout(resolve, 600));
					const alive = await fetch("/api/dsh-web-auth/bind", { credentials: "same-origin", cache: "no-store" })
						.then((res) => res.ok, () => false);
					if (alive) { await load(); return; }
				}
			};
			// 跨源读不到响应，但 opaque 请求成功/失败本身就能说明「有没有东西在听」。
			const reachable = (url, attempts) => {
				const probe = (attempt) => fetch(url, { mode: "no-cors", cache: "no-store" })
					.then(() => true, () => attempt + 1 < attempts
						? new Promise((resolve) => setTimeout(resolve, 700)).then(() => probe(attempt + 1))
						: false);
				return probe(0);
			};

			const applied = (result) => {
				const nextPort = typeof result.port === "number" ? result.port : Number(port);
				const previous = state === null ? null : state.port;
				if (typeof previous === "number" && previous === nextPort) {
					setMsg({ kind: "ok", text: "已保存，服务正在按新配置重启监听…" });
					void reloadState(6);
					return;
				}
				if (nextPort === 0) {
					setMsg({ kind: "info", text: "已保存：端口交回系统随机分配，重启 dsh 后需在本机日志里看实际端口。" });
					return;
				}
				const url = `http://${window.location.hostname}:${String(nextPort)}/`;
				setTarget({ url });
				setMsg({ kind: "info", text: `已提交，服务正在 ${url} 重启监听…` });
				void reachable(url, 8).then((ok) => {
					setMsg(ok
						? { kind: "ok", text: `已生效：${url}` }
						: { kind: "err", text: `新地址暂时不通（${url}）。端口被占用时改动会自动回滚，可回到原地址确认。` });
				});
			};

			const save = () => {
				if (busy || state === null || state.editable !== true) return;
				const value = port.trim();
				if (!/^\d+$/.test(value) || Number(value) > 65535) {
					setMsg({ kind: "err", text: "端口要是 0-65535 的整数（0 = 由系统分配）" });
					return;
				}
				const nextPort = Number(value);
				setBusy(true); setMsg(null); setTarget(null);
				fetch("/api/dsh-web-auth/bind", {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ host, port: nextPort })
				}).then((res) => res.json().catch(() => ({})).then((data) => ({ res, data })))
					.then(({ res, data }) => {
						if (res.ok && data && data.ok) { applied(data); return; }
						if (res.status === 404 || res.status === 405) {
							setMsg({ kind: "err", text: "宿主还没加载绑定接口（重启 dsh 后可用）" });
							return;
						}
						setMsg({ kind: "err", text: (data && data.error) || `保存失败（HTTP ${String(res.status)}）` });
					})
					// 连接被重启切断：宿主那边多半已经写成功，按已提交处理并去探新地址。
					.catch(() => applied({ host, port: nextPort }))
					.finally(() => setBusy(false));
			};

			const editable = state !== null && state.editable === true;
			const reason = state !== null && state.editable !== true ? state.reason : null;
			const tone = msg === null
				? null
				: msg.kind === "err" ? "var(--dsw-alias-label-error)"
					: msg.kind === "ok" ? "var(--dsw-alias-state-success-primary)"
						: "var(--dsw-alias-label-secondary)";

			return react.createElement(react.Fragment, null,
				react.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 500, margin: "14px 0 6px" } }, "服务绑定"),
				react.createElement("p", { className: "dsh-o-status", style: { margin: "0 0 8px" } }, `当前访问地址：${window.location.origin}/`),
				react.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
					react.createElement("select", {
						className: "dsh-o-input", value: host, disabled: !editable || busy,
						"aria-label": "绑定地址", style: { flex: 1, minWidth: 0 },
						onChange: (e) => setHost(e.target.value)
					}, (hosts.length > 0 ? hosts : [host]).map((value) => react.createElement("option", { key: value, value }, BIND_HOST_LABELS[value] ?? value))),
					react.createElement("input", {
						className: "dsh-o-input", inputMode: "numeric", value: port, disabled: !editable || busy,
						"aria-label": "端口", placeholder: "端口", style: { width: 110, flex: "0 0 auto" },
						onChange: (e) => setPort(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") save(); }
					})),
				react.createElement("div", { className: "dsh-o-footer", style: { borderTop: "none", padding: "4px 0 0", justifyContent: "flex-start" } },
					react.createElement("button", {
						type: "button", className: "dsh-o-btn dsh-o-btn-save", disabled: !editable || busy, onClick: save
					}, busy ? "提交中…" : "保存绑定"),
					target === null ? null : react.createElement("a", {
						className: "dsh-o-btn dsh-o-btn-discard", href: target.url, style: { textDecoration: "none" }
					}, "打开新地址")),
				reason === null ? null : react.createElement("p", { className: "dsh-o-status", style: { margin: "6px 0 0" } }, reason),
				msg === null ? null : react.createElement("p", { style: { margin: "6px 0 0", color: tone, fontSize: 12, lineHeight: 1.5 } }, msg.text),
				react.createElement("p", { className: "dsh-o-status", style: { marginTop: 6 } },
					"绑定写入当前 profile 的 patch。保存后 webserver 重启监听：本页连接会断开，改端口时请用新地址重新打开。"));
		}

		function AuthInfoCard() {
			const [info, setInfo] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
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
				void loadSessions();
				const timer = setInterval(() => { void loadSessions(); }, 10000);
				return () => clearInterval(timer);
			}, [loadSessions]);

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

			const sourceLabel = info === null || !info.passwordConfigured ? "" : info.passwordSource === "passwordFile" ? "密码文件" : info.passwordSource === "env" ? "环境变量" : "未知";

			return react.createElement(react.Fragment, null,
				react.createElement("style", { "data-plugin-css": "dsh-web-auth/card", dangerouslySetInnerHTML: { __html: CARD_CSS } }),
				react.createElement("ul", { className: "dsh-o-cards" },
				react.createElement("li", { className: "dsh-o-card" },
					react.createElement("div", { className: "dsh-o-cardBody" },
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
								react.createElement(ServiceBindBlock),
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
									"保存密码会写入密码文件（优先于环境变量，立即生效），并踢掉其它已登录会话。"))))));
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

			// 「插件」页 → 已安装 → @henlii/dsh-web-auth 详情页里的一块：认证状态、改访问
			// 密码、已登录会话。宿主把 plugins.detail.section 渲染进每个详情页（每个条目
			// 都拿到 subject），所以这里只认自己那个包，其余返回 null。
			const slots = ctx.get("slots");
			if (slots !== void 0) {
				slots.inject("plugins.detail.section", () => slots.register(
					{ name: "plugins.detail.section", id: "dsh-web-auth", order: 10 },
					(props) => {
						const pkg = props !== void 0 && props.subject !== void 0 ? props.subject.pkg : void 0;
						if (pkg === void 0 || pkg.name !== PACKAGE_NAME) return null;
						return react.createElement(AuthInfoCard, props);
					}
				));

				// 设置面板里单开一页，与 dsh-update 同一种席位：`label` 进左侧导航，
				// 内容渲染进设置面板的内容列，不必先翻到插件详情页。order 45 紧跟在
				// dsh 更新 / 插件市场之后（它们在 40）。页头自己画，因为这页没有别的
				// 外壳标题。
				slots.inject("settings.section", () => slots.register(
					{ name: "settings.section", id: "dsh-web-auth", order: 45, label: "访问认证" },
					() => react.createElement(react.Fragment, null,
						react.createElement("h2", {
							style: { margin: "0 0 6px", fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }
						}, "访问认证"),
						react.createElement("p", {
							style: { margin: "0 0 12px", color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: 1.5 }
						}, "非回环访问要过密码门；这里同时能改密码与 web 服务的绑定地址、端口。"),
						react.createElement(AuthInfoCard, null))
				));
			}

			// Shadow the official "打开配置文件" header action: same list-slot id
			// `open-document` at a lower priority wins the cell (SlotCore picks the
			// first live entry per id in priority order), so the remote page gets a
			// working viewer instead of the native-opener RPC that fails headless.
			ctx.inject(["configForms", "remote", "remote.settings"], (settingsCtx) => {
				const describe = settingsCtx.configForms.describe();
				const openNative = () => settingsCtx.remote.settings.openSettingsDocument();
				settingsCtx.slots.inject("settings.action", () => settingsCtx.slots.register(
					{
						name: "settings.action",
						id: "open-document",
						priority: -1,
						inject: () => ({ describe, openNative })
					},
					(props) => react.createElement(SettingsDocumentAction, props)
				));
			});

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
