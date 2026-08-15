// dsh-web-mobile client half — phone chrome for the official 3-column shell.
//
// Does not import sibling plugins. Auth / workspace / terminal are detected
// from stable DOM hooks those packages already expose. Desktop viewports
// leave the official grid and plugin chrome untouched.
window.__ModuleLoader__.load({
	id: "dsh-web-mobile",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-web-mobile-client";
		const inject = ["slots"];

		const PHONE_ALWAYS = 640;
		const PHONE_NEVER = 1024;
		const TOUCH_MQ = "(hover: none) and (pointer: coarse)";
		const TABBAR_H = 52;

		const CSS = [
			"html[data-dsh-mobile],html[data-dsh-mobile] body{overflow:hidden;height:100%;overscroll-behavior:none}",
			"html[data-dsh-mobile]{--dshm-chrome:" + TABBAR_H + "px;--dshm-kb:0px;--dshm-safe-b:env(safe-area-inset-bottom,0px);--dshm-safe-t:env(safe-area-inset-top,0px)}",
			"html[data-dsh-mobile][data-dsh-mobile-kb]{--dshm-chrome:0px}",
			"html[data-dsh-mobile] [class$=\"frame\"]{grid-template-columns:0 minmax(0,1fr) 0 !important;height:100dvh;height:100svh;box-sizing:border-box;padding-bottom:calc(var(--dshm-chrome) + var(--dshm-safe-b) + var(--dshm-kb))}",
			"html[data-dsh-mobile] [class$=\"handle\"]{display:none !important}",
			"html[data-dsh-mobile] [class$=\"centerCol\"]{padding-right:0 !important;--dsh-chat-content-width:100%;--dsh-composer-side-clearance:8px;--dsh-composer-dock-inset:4px}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] textarea,html[data-dsh-mobile] [class$=\"centerCol\"] input{font-size:16px !important}",
			"html[data-dsh-mobile]:not([data-dsh-mobile-pane=\"sessions\"]) [class$=\"sidebarCol\"]{visibility:hidden;pointer-events:none}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"sessions\"] [class$=\"sidebarCol\"]{position:fixed;inset:0 auto 0 0;width:min(22rem,86vw)!important;height:100dvh;z-index:36;overflow:auto;visibility:visible;pointer-events:auto;box-shadow:8px 0 32px rgba(0,0,0,.2);background:var(--dsw-specific-sidebar-fill,#f6f7f9);padding-bottom:calc(var(--dshm-chrome) + var(--dshm-safe-b));box-sizing:border-box}",
			"html[data-dsh-mobile]:not([data-dsh-mobile-pane=\"workspace\"]) [class$=\"detailsCol\"]{visibility:hidden;pointer-events:none}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] [class$=\"detailsCol\"]{position:fixed;inset:0;width:100vw!important;height:100dvh;z-index:36;overflow:hidden;visibility:visible;pointer-events:auto;background:var(--dsw-specific-sidebar-fill,#f6f7f9);padding-bottom:calc(var(--dshm-chrome) + var(--dshm-safe-b));box-sizing:border-box}",
			"html[data-dsh-mobile]:not([data-dsh-mobile-pane=\"workspace\"]) nav[aria-label=\"dsh-sidebar 导航\"]{display:none !important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] nav[aria-label=\"dsh-sidebar 导航\"]{display:flex !important;flex-direction:row !important;justify-content:space-around !important;align-items:center !important;top:0 !important;left:0 !important;right:0 !important;bottom:auto !important;width:100% !important;height:calc(48px + var(--dshm-safe-t)) !important;padding:var(--dshm-safe-t) 8px 0 !important;z-index:37 !important;border-left:none !important;border-bottom:1px solid var(--dsw-alias-border-l1,#e2e6ec)}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] nav[aria-label=\"dsh-sidebar 导航\"]>div{display:none !important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] [role=\"complementary\"][aria-label=\"工作区侧边栏\"]{padding-right:0 !important;padding-top:calc(48px + var(--dshm-safe-t))}",
			"html[data-dsh-mobile]:not([data-dsh-mobile-pane=\"terminal\"]) .wterm{display:none !important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"terminal\"] .wterm{display:flex !important;position:fixed;left:0;right:0;top:var(--dshm-safe-t);bottom:calc(var(--dshm-chrome) + var(--dshm-safe-b));z-index:36;margin:0 !important;padding:8px 10px 6px;background:var(--dsw-alias-bg-base,#fff);height:auto}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"terminal\"] .wterm-out{flex:1 1 auto !important;height:auto !important;min-height:120px}",
			"html[data-dsh-mobile] #dsh-web-auth-overlay>div{width:min(360px,calc(100vw - 32px)) !important;max-width:calc(100vw - 32px) !important;margin:var(--dshm-safe-t) 16px var(--dshm-safe-b)}",
			"html[data-dsh-mobile] #dsh-web-auth-overlay input,html[data-dsh-mobile] #dsh-web-auth-overlay button{min-height:44px !important;font-size:16px !important}",
			"@media (max-width:639.98px){#dsh-web-auth-overlay>div{width:min(360px,calc(100vw - 32px)) !important}#dsh-web-auth-overlay input,#dsh-web-auth-overlay button{min-height:44px !important;font-size:16px !important}}",
			"#dsh-web-mobile-root{display:none}",
			"html[data-dsh-mobile] #dsh-web-mobile-root{display:block}",
			"html[data-dsh-mobile][data-dsh-mobile-kb] #dsh-web-mobile-root .dshm-tabbar{display:none}",
			".dshm-backdrop{position:fixed;inset:0;z-index:34;background:rgba(10,12,18,.45);border:0;padding:0;margin:0;cursor:pointer}",
			".dshm-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:40;height:calc(" + TABBAR_H + "px + env(safe-area-inset-bottom,0px));padding:0 4px env(safe-area-inset-bottom,0px);display:flex;align-items:stretch;gap:2px;background:var(--dsw-alias-bg-layer-1,#fff);border-top:1px solid var(--dsw-alias-border-l1,#e2e6ec);box-sizing:border-box}",
			".dshm-tab{flex:1;min-width:0;min-height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5a6472);font:600 11px/1.2 system-ui,-apple-system,sans-serif;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;padding:6px 4px}",
			".dshm-tab[aria-current=page],.dshm-tab[aria-pressed=true]{color:var(--dsw-alias-brand-primary,#1f6feb)}",
			".dshm-tab svg{display:block;flex:none}",
			"@media (prefers-reduced-motion:reduce){html[data-dsh-mobile] [class$=\"sidebarCol\"],html[data-dsh-mobile] [class$=\"detailsCol\"],.dshm-tabbar{transition:none !important}}"
		].join("");

		function isPhone() {
			const width = window.innerWidth;
			if (width < PHONE_ALWAYS) return true;
			if (width >= PHONE_NEVER) return false;
			return window.matchMedia(TOUCH_MQ).matches;
		}

		function detectExtras() {
			return {
				workspace: !!document.querySelector("[aria-label=\"工作区侧边栏\"], nav[aria-label=\"dsh-sidebar 导航\"]"),
				terminal: !!document.querySelector(".wterm"),
				auth: !!document.getElementById("dsh-web-auth-overlay")
			};
		}

		function frameEl() {
			return document.querySelector("[class$=\"frame\"]");
		}

		function layoutOf(ctx) {
			try {
				return ctx.get("layout");
			} catch {
				return undefined;
			}
		}

		function svg(paths) {
			const ns = "http://www.w3.org/2000/svg";
			const el = document.createElementNS(ns, "svg");
			el.setAttribute("width", "20");
			el.setAttribute("height", "20");
			el.setAttribute("viewBox", "0 0 24 24");
			el.setAttribute("fill", "none");
			el.setAttribute("stroke", "currentColor");
			el.setAttribute("stroke-width", "1.8");
			el.setAttribute("stroke-linecap", "round");
			el.setAttribute("stroke-linejoin", "round");
			el.setAttribute("aria-hidden", "true");
			for (const d of paths) {
				const p = document.createElementNS(ns, "path");
				p.setAttribute("d", d);
				el.appendChild(p);
			}
			return el;
		}

		const ICONS = {
			sessions: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
			chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
			workspace: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
			terminal: ["M4 17l6-5-6-5", "M12 19h8"]
		};

		function ensureViewport() {
			let meta = document.querySelector("meta[name=\"viewport\"]");
			if (!meta) {
				meta = document.createElement("meta");
				meta.setAttribute("name", "viewport");
				document.head.appendChild(meta);
			}
			if (!String(meta.getAttribute("content") || "").includes("viewport-fit=cover")) {
				meta.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
			}
		}

		function MobileInfoCard() {
			const [open, setOpen] = react.useState(false);
			const extras = detectExtras();
			const bits = ["官方会话列表 + 对话"];
			if (extras.workspace) bits.push("工作区侧栏");
			if (extras.terminal) bits.push("终端面板");
			if (extras.auth) bits.push("登录浮层");
			return react.createElement("li", { style: { listStyle: "none" } },
				react.createElement("article", {
					style: {
						border: "1px solid var(--dsw-alias-border-l1, #d4d9e0)",
						borderRadius: 12,
						background: "var(--dsw-alias-bg-layer-1, #fff)",
						color: "var(--dsw-alias-label-primary, #1c2024)",
						overflow: "hidden"
					}
				},
					react.createElement("button", {
						type: "button",
						"aria-label": `${open ? "收起设置" : "展开设置"}: dsh-web-mobile`,
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
							react.createElement("div", { style: { fontSize: 15, fontWeight: 600 } }, "dsh-web-mobile"),
							react.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #8a94a3)", marginTop: 2 } }, "手机视口适配（独立安装，按需探测兄弟插件）")),
						react.createElement("span", {
							style: {
								color: "var(--dsw-alias-label-secondary, #8a94a3)",
								fontSize: 12,
								transition: "transform .14s",
								transform: open ? "rotate(180deg)" : "none"
							}
						}, "▾")),
					open && react.createElement("div", {
						style: {
							borderTop: "1px solid var(--dsw-alias-border-l1, #e4e8ee)",
							padding: "12px 16px 14px",
							fontSize: 13,
							color: "var(--dsw-alias-label-secondary, #5a6472)",
							lineHeight: 1.6
						}
					},
						react.createElement("p", { style: { margin: 0 } }, "当前探测到：", bits.join("、"), "。"),
						react.createElement("p", { style: { margin: "8px 0 0" } }, "无配置项。桌面视口不改官方三栏；窄屏用底栏切换会话 / 对话", extras.workspace ? " / 工作区" : "", extras.terminal ? " / 终端" : "", "。"))));
		}

		function apply(ctx) {
			ensureViewport();

			const style = document.createElement("style");
			style.dataset.plugin = "dsh-web-mobile";
			style.textContent = CSS;
			document.head.appendChild(style);

			const root = document.createElement("div");
			root.id = "dsh-web-mobile-root";
			const backdrop = document.createElement("button");
			backdrop.type = "button";
			backdrop.className = "dshm-backdrop";
			backdrop.hidden = true;
			backdrop.setAttribute("aria-label", "关闭面板");
			const tabbar = document.createElement("nav");
			tabbar.className = "dshm-tabbar";
			tabbar.setAttribute("aria-label", "手机导航");
			root.append(backdrop, tabbar);
			const mount = () => {
				(document.body || document.documentElement).appendChild(root);
			};
			if (document.body) mount();
			else document.addEventListener("DOMContentLoaded", mount);

			const html = document.documentElement;
			let pane = "chat";
			let extras = detectExtras();

			function syncKeyboard() {
				const vv = window.visualViewport;
				if (!vv) {
					html.style.setProperty("--dshm-kb", "0px");
					html.removeAttribute("data-dsh-mobile-kb");
					return;
				}
				const occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
				html.style.setProperty("--dshm-kb", `${occluded}px`);
				if (occluded > 80) html.setAttribute("data-dsh-mobile-kb", "");
				else html.removeAttribute("data-dsh-mobile-kb");
			}

			function setSidebarExpanded(expand) {
				const layout = layoutOf(ctx);
				const frame = frameEl();
				if (!layout || !frame) return;
				const collapsed = frame.hasAttribute("data-sidebar-collapsed");
				if (expand && collapsed) {
					try { layout.toggleSidebar(); } catch { /* layout not wired */ }
				}
				if (!expand && !collapsed) {
					try { layout.toggleSidebar(); } catch { /* layout not wired */ }
				}
			}

			function setDetailsOpen(open) {
				const layout = layoutOf(ctx);
				if (!layout) return;
				try {
					if (open) layout.openDetails();
					else layout.closeDetails();
				} catch {
					/* layout not wired */
				}
			}

			function ensureTerminalOpen() {
				if (document.querySelector(".wterm-out")) return;
				const bar = document.querySelector(".wterm-bar");
				if (bar) bar.click();
			}

			function openWorkspaceRail() {
				const panel = document.querySelector("[role=\"complementary\"][aria-label=\"工作区侧边栏\"]");
				const body = panel && panel.firstElementChild;
				// Rail click on the active tab retracts the panel — only poke it
				// when the content column is empty (internally collapsed).
				if (body && body.childElementCount > 0) return;
				const files = document.querySelector("nav[aria-label=\"dsh-sidebar 导航\"] button");
				if (files) files.click();
			}

			function setPane(next) {
				const phone = html.hasAttribute("data-dsh-mobile");
				if (!phone) return;
				if (pane === "sessions" && next !== "sessions") setSidebarExpanded(false);
				if (pane === "workspace" && next !== "workspace") setDetailsOpen(false);
				pane = next;
				html.setAttribute("data-dsh-mobile-pane", pane);
				backdrop.hidden = pane !== "sessions";
				if (pane === "sessions") setSidebarExpanded(true);
				if (pane === "workspace") {
					setDetailsOpen(true);
					openWorkspaceRail();
				}
				if (pane === "terminal") ensureTerminalOpen();
				paintTabs();
			}

			function paintTabs() {
				tabbar.replaceChildren();
				const items = [
					{ id: "sessions", label: "会话" },
					{ id: "chat", label: "对话" }
				];
				if (extras.workspace) items.push({ id: "workspace", label: "工作区" });
				if (extras.terminal) items.push({ id: "terminal", label: "终端" });
				for (const item of items) {
					const btn = document.createElement("button");
					btn.type = "button";
					btn.className = "dshm-tab";
					btn.dataset.pane = item.id;
					const active = pane === item.id;
					if (item.id === "chat") {
						if (active) btn.setAttribute("aria-current", "page");
					} else {
						btn.setAttribute("aria-pressed", active ? "true" : "false");
						if (active) btn.setAttribute("aria-current", "page");
					}
					btn.append(svg(ICONS[item.id]), document.createTextNode(item.label));
					btn.addEventListener("click", () => {
						if (item.id === "chat") setPane("chat");
						else if (pane === item.id) setPane("chat");
						else setPane(item.id);
					});
					tabbar.appendChild(btn);
				}
			}

			function enterPhone() {
				if (html.hasAttribute("data-dsh-mobile")) return;
				html.setAttribute("data-dsh-mobile", "");
				pane = "chat";
				html.setAttribute("data-dsh-mobile-pane", "chat");
				backdrop.hidden = true;
				setDetailsOpen(false);
				setSidebarExpanded(false);
				paintTabs();
				syncKeyboard();
			}

			function leavePhone() {
				if (!html.hasAttribute("data-dsh-mobile")) return;
				if (pane === "sessions") setSidebarExpanded(false);
				if (pane === "workspace") setDetailsOpen(false);
				pane = "chat";
				html.removeAttribute("data-dsh-mobile");
				html.removeAttribute("data-dsh-mobile-pane");
				html.removeAttribute("data-dsh-mobile-kb");
				html.style.removeProperty("--dshm-kb");
				backdrop.hidden = true;
			}

			function syncMode() {
				extras = detectExtras();
				if (isPhone()) {
					enterPhone();
					paintTabs();
				} else {
					leavePhone();
				}
			}

			backdrop.addEventListener("click", () => setPane("chat"));

			// Sidebar auto-opens details on session change; on phone that
			// would cover the transcript unless the user asked for 工作区.
			const attrWatch = new MutationObserver(() => {
				if (!html.hasAttribute("data-dsh-mobile")) return;
				const frame = frameEl();
				if (!frame) return;
				const detailsOpen = !frame.hasAttribute("data-details-collapsed");
				if (!detailsOpen) return;
				if (pane === "workspace") return;
				if (extras.workspace) setDetailsOpen(false);
				else setPane("workspace");
			});
			let watchingFrame = null;
			const attachFrameWatch = () => {
				const frame = frameEl();
				if (!frame || frame === watchingFrame) return;
				watchingFrame = frame;
				attrWatch.observe(frame, { attributes: true, attributeFilter: ["data-details-collapsed"] });
			};
			attachFrameWatch();

			const treeWatch = new MutationObserver(() => {
				const next = detectExtras();
				const changed = next.workspace !== extras.workspace || next.terminal !== extras.terminal;
				extras = next;
				if (changed && html.hasAttribute("data-dsh-mobile")) paintTabs();
				attachFrameWatch();
			});
			treeWatch.observe(document.documentElement, { childList: true, subtree: true });

			window.addEventListener("resize", syncMode);
			window.matchMedia(TOUCH_MQ).addEventListener("change", syncMode);
			if (window.visualViewport) {
				window.visualViewport.addEventListener("resize", syncKeyboard);
				window.visualViewport.addEventListener("scroll", syncKeyboard);
			}

			const onPointerDown = (event) => {
				if (!html.hasAttribute("data-dsh-mobile")) return;
				const handle = event.target && event.target.closest && event.target.closest(".wterm-resize");
				if (!handle) return;
				event.preventDefault();
				const out = document.querySelector(".wterm-out");
				if (!out) return;
				const startY = event.clientY;
				const startH = out.getBoundingClientRect().height;
				const onMove = (ev) => {
					const next = Math.max(80, Math.min(window.innerHeight * 0.85, startH + (startY - ev.clientY)));
					out.style.height = `${next}px`;
				};
				const onUp = () => {
					document.removeEventListener("pointermove", onMove);
					document.removeEventListener("pointerup", onUp);
				};
				document.addEventListener("pointermove", onMove);
				document.addEventListener("pointerup", onUp);
			};
			document.addEventListener("pointerdown", onPointerDown);

			syncMode();

			const slots = ctx.get("slots");
			if (slots !== void 0) {
				slots.inject("settings.plugin.item", () => slots.register(
					{ name: "settings.plugin.item", id: "dsh-web-mobile", order: 40, label: "dsh-web-mobile" },
					() => react.createElement(MobileInfoCard)
				));
			}

			ctx.effect(() => () => {
				style.remove();
				root.remove();
				attrWatch.disconnect();
				treeWatch.disconnect();
				window.removeEventListener("resize", syncMode);
				document.removeEventListener("pointerdown", onPointerDown);
				if (window.visualViewport) {
					window.visualViewport.removeEventListener("resize", syncKeyboard);
					window.visualViewport.removeEventListener("scroll", syncKeyboard);
				}
				leavePhone();
			}, "dsh-web-mobile: chrome cleanup");
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
