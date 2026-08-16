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

		function AuthInfoCard() {
			const [info, setInfo] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			const [open, setOpen] = react.useState(false);
			const [cur, setCur] = react.useState("");
			const [next, setNext] = react.useState("");
			const [confirm, setConfirm] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				fetch("/api/auth/status", { credentials: "same-origin" })
					.then((res) => res.json().catch(() => ({})))
					.then((data) => {
						if (!alive) return;
						if (data && data.ok) setInfo(data);
						else setFailed(true);
					})
					.catch(() => {
						if (alive) setFailed(true);
					});
				return () => {
					alive = false;
				};
			}, []);

			const title = "dsh-web-auth";
			const description = "内网/LAN 访问密码认证与信任插件";
			const sourceLabel = info === null || !info.passwordConfigured ? "" : info.passwordSource === "passwordFile" ? "密码文件" : info.passwordSource === "env" ? "环境变量" : "未知";

			const doChangePassword = async () => {
				setMsg(null);
				if (next.length < 8) { setMsg({ ok: false, text: "新密码至少 8 位" }); return; }
				if (next !== confirm) { setMsg({ ok: false, text: "两次输入的新密码不一致" }); return; }
				setBusy(true);
				try {
					const res = await fetch("/api/auth/password", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ currentPassword: cur, newPassword: next })
					});
					const data = await res.json().catch(() => ({}));
					if (res.ok && data && data.ok) {
						setMsg({ ok: true, text: "密码已修改，所有会话已下线，请重新登录" });
						setCur(""); setNext(""); setConfirm("");
						setTimeout(() => { window.location.reload(); }, 1200);
						return;
					}
					setMsg({ ok: false, text: (data && data.error) || "修改失败" });
				} catch {
					setMsg({ ok: false, text: "无法连接服务器" });
				}
				setBusy(false);
			};

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
							? react.createElement("p", { style: { margin: 0, color: "#c0392b" } }, "（需登录后查看状态）")
							: info === null
								? react.createElement("p", { style: { margin: 0 } }, "加载中…")
								: react.createElement(react.Fragment, null,
									react.createElement("p", { style: { margin: "6px 0 0" } },
										react.createElement("span", { style: { color: "#1c2024", fontWeight: 500, marginRight: 8 } }, "访问密码"),
										info.passwordConfigured ? `已配置（来源：${sourceLabel}）` : "未配置"),
									react.createElement("p", { style: { margin: "6px 0 0" } },
										react.createElement("span", { style: { color: "#1c2024", fontWeight: 500, marginRight: 8 } }, "会话有效期"),
										`${String(info.ttlHours)} 小时`)),
						react.createElement("p", { style: { margin: "10px 0 0", fontSize: 12, color: "#8a94a3", lineHeight: 1.6 } },
							"修改密码：写入 /root/.config/dsh/web-auth.password（优先于环境变量，即时生效，无需重启）；或编辑 /root/.config/dsh/dsh-web.sh 中的 DSH_WEB_AUTH_PASSWORD 后重启服务。"),
						react.createElement("div", { style: { marginTop: 14, borderTop: "1px solid #e4e8ee", paddingTop: 12 } },
							react.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: "#1c2024", marginBottom: 8 } }, "在页面修改密码"),
							react.createElement("input", {
								type: "password",
								placeholder: "当前密码",
								value: cur,
								onChange: (e) => setCur(e.target.value),
								style: { width: "100%", boxSizing: "border-box", padding: "8px 10px", marginBottom: 8, border: "1px solid #d4d9e0", borderRadius: 6, fontSize: 13, outline: "none" }
							}),
							react.createElement("input", {
								type: "password",
								placeholder: "新密码（至少 8 位）",
								value: next,
								onChange: (e) => setNext(e.target.value),
								style: { width: "100%", boxSizing: "border-box", padding: "8px 10px", marginBottom: 8, border: "1px solid #d4d9e0", borderRadius: 6, fontSize: 13, outline: "none" }
							}),
							react.createElement("input", {
								type: "password",
								placeholder: "确认新密码",
								value: confirm,
								onChange: (e) => setConfirm(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") void doChangePassword(); },
								style: { width: "100%", boxSizing: "border-box", padding: "8px 10px", marginBottom: 10, border: "1px solid #d4d9e0", borderRadius: 6, fontSize: 13, outline: "none" }
							}),
							msg !== null && react.createElement("p", { style: { margin: "0 0 8px", fontSize: 12, color: msg.ok ? "#1a7f37" : "#c0392b" } }, msg.text),
							react.createElement("button", {
								type: "button",
								disabled: busy,
								onClick: () => void doChangePassword(),
								style: { width: "100%", padding: "9px 0", border: 0, borderRadius: 6, background: "#1f6feb", color: "#fff", fontSize: 13, fontWeight: 600, cursor: busy ? "wait" : "pointer" }
							}, busy ? "保存中…" : "修改密码")))));
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
					{ name: "settings.plugin.item", id: "dsh-web-auth", order: 30, label: "dsh-web-auth" },
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
