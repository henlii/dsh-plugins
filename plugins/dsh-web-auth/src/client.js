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
		const inject = ["slots"];

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

			return react.createElement("li", { style: { listStyle: "none" } },
				react.createElement("article", {
					style: {
						border: "1px solid #d4d9e0",
						borderRadius: 12,
						background: "#fff",
						color: "#1c2024",
						overflow: "hidden"
					}
				},
					react.createElement("button", {
						type: "button",
						"aria-label": `${open ? "收起设置" : "展开设置"}: ${title}`,
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						style: {
							width: "100%",
							display: "flex",
							alignItems: "center",
							gap: 12,
							padding: "14px 16px",
							border: 0,
							background: "none",
							cursor: "pointer",
							textAlign: "left",
							font: "inherit",
							color: "inherit"
						}
					},
						react.createElement("div", { style: { flex: 1, minWidth: 0 } },
							react.createElement("div", { style: { fontSize: 15, fontWeight: 600 } }, title),
							react.createElement("div", { style: { fontSize: 13, color: "#8a94a3", marginTop: 2 } }, description)),
						react.createElement("span", {
							style: {
								color: "#8a94a3",
								fontSize: 12,
								transition: "transform .14s",
								transform: open ? "rotate(180deg)" : "none"
							}
						}, "▾")),
					open && react.createElement("div", {
						style: {
							borderTop: "1px solid #e4e8ee",
							padding: "12px 16px 14px",
							fontSize: 13,
							color: "#5a6472",
							lineHeight: 1.6
						}
					},
						failed
						? react.createElement("p", { style: { margin: 0, color: "#c0392b" } }, "（需登录后查看）")
						: info === null
							? react.createElement("p", { style: { margin: 0 } }, "加载中…")
							: react.createElement(react.Fragment, null,
								react.createElement("p", { style: { margin: "0 0 8px" } },
									react.createElement("span", { style: { color: "#1c2024", fontWeight: 500, marginRight: 8 } }, "当前密码"),
									info.passwordConfigured ? `已配置（${sourceLabel}）· 会话 ${String(info.ttlHours)} 小时` : "未配置"),
								react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 } },
									react.createElement("input", {
										type: "password", placeholder: "新访问密码", value: password,
										onChange: (e) => setPassword(e.target.value),
										style: { boxSizing: "border-box", width: "100%", padding: "8px 10px", border: "1px solid #d4d9e0", borderRadius: 8, font: "inherit" }
									}),
									react.createElement("input", {
										type: "password", placeholder: "再输一次", value: confirm,
										onChange: (e) => setConfirm(e.target.value),
										onKeyDown: (e) => { if (e.key === "Enter") savePassword(); },
										style: { boxSizing: "border-box", width: "100%", padding: "8px 10px", border: "1px solid #d4d9e0", borderRadius: 8, font: "inherit" }
									}),
									react.createElement("button", {
										type: "button", disabled: busy, onClick: savePassword,
										style: { alignSelf: "flex-start", padding: "6px 12px", border: 0, borderRadius: 8, background: "#1f6feb", color: "#fff", font: "inherit", cursor: busy ? "default" : "pointer" }
									}, busy ? "保存中…" : "保存密码")),
								react.createElement("div", { style: { color: "#1c2024", fontWeight: 500, margin: "4px 0 6px" } }, `已登录（${String(sessions.length)}）`),
								sessions.length === 0
									? react.createElement("p", { style: { margin: 0, color: "#8a94a3" } }, "暂无活动会话（本机回环访问不发 cookie）")
									: sessions.map((s) => react.createElement("div", {
										key: s.id,
										style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: "1px solid #eef1f5" }
									},
										react.createElement("div", { style: { flex: 1, minWidth: 0 } },
											react.createElement("div", { style: { color: "#1c2024" } },
												s.peer || "未知地址",
												s.current ? react.createElement("span", { style: { marginLeft: 6, color: "#2e9e5b", fontSize: 12 } }, "当前") : null),
											react.createElement("div", { style: { fontSize: 12, color: "#8a94a3", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
												`最近 ${formatTs(s.lastSeen)} · 签发 ${formatTs(s.issuedAt)}`)),
										react.createElement("button", {
											type: "button", disabled: busy, onClick: () => revoke(s.id, s.current),
											style: { flex: "none", padding: "4px 8px", border: "1px solid #e2e6ec", borderRadius: 6, background: "#fff", color: "#c0392b", font: "inherit", cursor: busy ? "default" : "pointer" }
										}, "删除"))),
								actionMsg ? react.createElement("p", { style: { margin: "8px 0 0", color: actionMsg.err ? "#c0392b" : "#2e9e5b" } }, actionMsg.text) : null,
								react.createElement("p", { style: { margin: "10px 0 0", fontSize: 12, color: "#8a94a3", lineHeight: 1.6 } },
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
			const slots = ctx.get("slots");
			if (slots !== void 0) {
				slots.inject("settings.plugin.item", () => slots.register(
					{ name: "settings.plugin.item", key: "dsh-web-auth" },
					() => react.createElement(AuthInfoCard)
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
