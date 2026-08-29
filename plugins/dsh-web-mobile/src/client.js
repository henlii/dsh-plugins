// dsh-web-mobile client half — phone chrome for the official 3-column shell.
//
// Phone: conversation stays on screen. Left/right header buttons open the
// official session list and the workspace column as overlays. No bottom tab
// bar. Sibling plugins are feature-detected from the DOM, never imported.
// Hidden columns use display:none so streaming chat does not paint them;
// document MutationObserver / visualViewport / resize are rAF-coalesced.
// Streaming jank mitigations adapted from @linxin666/dsh-perf: session-list
// set-gate (projection-only publishes ~1Hz) and content-visibility:auto on
// off-screen message / session rows.
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
		const BTN = 40;

		const CSS = [
			"html[data-dsh-mobile],html[data-dsh-mobile] body{overflow:hidden;height:100%;overscroll-behavior:none}",
			"html[data-dsh-mobile]{--dshm-kb:0px;--dshm-safe-b:env(safe-area-inset-bottom,0px);--dshm-safe-t:env(safe-area-inset-top,0px);--dshm-btn:" + BTN + "px}",
			"html[data-dsh-mobile] [class$=\"frame\"]{grid-template-columns:0 minmax(0,1fr) 0 !important;height:100dvh;height:100svh;box-sizing:border-box;padding-bottom:calc(var(--dshm-safe-b) + var(--dshm-kb))}",
			"html[data-dsh-mobile] [class$=\"handle\"]{display:none !important}",
			"html[data-dsh-mobile] [class$=\"centerCol\"]{padding-right:0 !important;--dsh-chat-content-width:100%;--dsh-composer-side-clearance:8px;--dsh-composer-dock-inset:4px;min-width:0}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] textarea,html[data-dsh-mobile] [class$=\"centerCol\"] input{font-size:16px !important}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] [class$=\"header\"]{padding:8px calc(var(--dshm-btn) + 10px) 0 !important;background:var(--dsw-alias-bg-base,#fff) !important;z-index:3}",
			"html[data-dsh-mobile] [class$=\"sessionLogButton\"]{display:none !important}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] [class$=\"crumb\"]{max-width:46vw !important}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] [class$=\"headline\"]{font-size:20px !important;line-height:26px !important;column-gap:6px !important}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] [class$=\"scroll\"]{padding-left:12px !important;padding-right:12px !important}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] table{display:block;width:100%;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}",
			"html[data-dsh-mobile] [class$=\"centerCol\"] pre{max-width:100%;overflow-x:auto}",
			"html[data-dsh-mobile] [class$=\"composerStack\"] [class$=\"card\"]~*{display:none !important}",
			"html[data-dsh-mobile] button[aria-label=\"收起侧边栏\"],html[data-dsh-mobile] button[aria-label=\"打开侧边栏\"],html[data-dsh-mobile] [class$=\"railFish\"]{display:none !important}",
			"html[data-dsh-mobile]:not([data-dsh-mobile-pane=\"sessions\"]) [class$=\"sidebarCol\"]{display:none!important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"sessions\"] [class$=\"sidebarCol\"]{display:block;position:fixed;inset:0 auto 0 0;width:min(22rem,86vw)!important;height:100dvh;z-index:36;overflow:auto;content-visibility:visible;contain:layout paint;box-shadow:8px 0 32px rgba(0,0,0,.2);background:var(--dsw-specific-sidebar-fill,#f6f7f9);padding-top:calc(var(--dshm-safe-t) + var(--dshm-btn));box-sizing:border-box}",
			"html[data-dsh-mobile]:not([data-dsh-mobile-pane=\"workspace\"]) [class$=\"detailsCol\"]{display:none!important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] [class$=\"detailsCol\"]{display:block;position:fixed;inset:0;width:100vw!important;height:100dvh;z-index:36;overflow:hidden;content-visibility:visible;contain:layout paint;background:var(--dsw-specific-sidebar-fill,#f6f7f9);padding-top:calc(var(--dshm-safe-t) + var(--dshm-btn));box-sizing:border-box}",
			"html[data-dsh-mobile]:not([data-dsh-mobile-pane=\"workspace\"]) nav[aria-label=\"dsh-sidebar 导航\"]{display:none !important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] nav[aria-label=\"dsh-sidebar 导航\"]{display:flex !important;flex-direction:row !important;justify-content:space-around !important;align-items:center !important;top:calc(var(--dshm-safe-t) + var(--dshm-btn)) !important;left:0 !important;right:0 !important;bottom:auto !important;width:100% !important;height:48px !important;padding:0 8px !important;z-index:37 !important;border-left:none !important;border-bottom:1px solid var(--dsw-alias-border-l1,#e2e6ec);box-sizing:border-box !important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] nav[aria-label=\"dsh-sidebar 导航\"]>div{display:none !important}",
			"html[data-dsh-mobile][data-dsh-mobile-pane=\"workspace\"] [role=\"complementary\"][aria-label=\"工作区侧边栏\"]{padding-right:0 !important;padding-top:48px}",
			"html[data-dsh-mobile] .wterm{display:none !important}",
			"html[data-dsh-mobile] [data-chat-flow-kind=\"assistant-step\"],html[data-dsh-mobile] [data-chat-flow-kind=\"tool-call\"]{content-visibility:auto;contain-intrinsic-size:auto 120px}",
			"html[data-dsh-mobile] [class$=\"sidebarCol\"] [class*=\"sessionRow\"]{content-visibility:auto;contain-intrinsic-size:auto 32px}",
			"html[data-dsh-mobile] [class$=\"overlayLayer\"]{z-index:50 !important}",
			"html[data-dsh-mobile] [class$=\"overlay\"]>[class$=\"panel\"]{flex-direction:column !important;width:100% !important;max-width:100% !important;height:100% !important;max-height:100% !important;border-radius:0 !important;margin:0 !important}",
			"html[data-dsh-mobile] [class$=\"overlay\"]>[class$=\"panel\"]>[class$=\"nav\"]{width:100% !important;max-width:none !important;flex:none !important;height:auto !important;max-height:36vh;overflow:auto;border-right:none !important}",
			"html[data-dsh-mobile] [class$=\"overlay\"]>[class$=\"panel\"]>[class$=\"content\"]{width:100% !important;max-width:none !important;flex:1 1 auto !important;min-width:0 !important;min-height:0 !important;overflow:auto !important}",
			"html[data-dsh-mobile] [class$=\"overlay\"] [class$=\"close\"]{position:fixed !important;top:10px;right:12px;z-index:60}",
			"html[data-dsh-mobile] [class$=\"overlay\"] [class$=\"navTitle\"]{padding-right:48px !important}",
			"html[data-dsh-mobile] [role=\"dialog\"],html[data-dsh-mobile] [role=\"listbox\"],html[data-dsh-mobile] [role=\"menu\"]{max-width:calc(100vw - 16px) !important;max-height:min(70dvh,520px) !important;overflow:auto !important;box-sizing:border-box !important}",
			"html[data-dsh-mobile] [data-radix-popper-content-wrapper],html[data-dsh-mobile] [class*=\"popover\"],html[data-dsh-mobile] [class*=\"Popover\"],html[data-dsh-mobile] [class*=\"dropdown\"],html[data-dsh-mobile] [class*=\"Dropdown\"]{max-width:calc(100vw - 16px) !important;max-height:min(70dvh,520px) !important}",
			"html[data-dsh-mobile] #dsh-web-auth-overlay>div{width:min(360px,calc(100vw - 32px)) !important;max-width:calc(100vw - 32px) !important;margin:var(--dshm-safe-t) 16px var(--dshm-safe-b)}",
			"html[data-dsh-mobile] #dsh-web-auth-overlay input,html[data-dsh-mobile] #dsh-web-auth-overlay button{min-height:44px !important;font-size:16px !important}",
			"@media (max-width:639.98px){#dsh-web-auth-overlay>div{width:min(360px,calc(100vw - 32px)) !important}#dsh-web-auth-overlay input,#dsh-web-auth-overlay button{min-height:44px !important;font-size:16px !important}}",
			"#dsh-web-mobile-root{display:none}",
			"html[data-dsh-mobile] #dsh-web-mobile-root{display:block}",
			"html[data-dsh-mobile][data-dsh-mobile-modal] #dsh-web-mobile-root{display:none}",
			".dshm-backdrop{position:fixed;inset:0;z-index:34;background:rgba(10,12,18,.45);border:0;padding:0;margin:0;cursor:pointer}",
			".dshm-sidebtn{position:fixed;top:max(6px,var(--dshm-safe-t));z-index:38;width:var(--dshm-btn);height:var(--dshm-btn);display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary,#1c2024);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;padding:0}",
			".dshm-sidebtn[aria-pressed=true]{color:var(--dsw-alias-brand-primary,#1f6feb);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#1f6feb) 12%,transparent)}",
			".dshm-sidebtn-left{left:4px}",
			".dshm-sidebtn-right{right:4px}",
			".dshm-sidebtn svg{display:block}",
			"@media (prefers-reduced-motion:reduce){html[data-dsh-mobile] [class$=\"sidebarCol\"],html[data-dsh-mobile] [class$=\"detailsCol\"]{transition:none !important}}"
		].join("");

		function sameEntryVisible(a, b) {
			if (a === b) return true;
			if (a === undefined || b === undefined) return false;
			const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
			keys.delete("projectionValues");
			for (const key of keys) if (!Object.is(a[key], b[key])) return false;
			return true;
		}

		function sameRecord(a, b) {
			if (a === b) return true;
			if (a === undefined || b === undefined) return false;
			const aKeys = Object.keys(a);
			const bKeys = Object.keys(b);
			if (aKeys.length !== bKeys.length) return false;
			for (const key of aKeys) {
				if (!(key in b)) return false;
				if (!Object.is(a[key], b[key])) return false;
			}
			return true;
		}

		function sameVisibleContent(a, b) {
			if (a === b) return true;
			if (!Object.is(a.current, b.current) || !Object.is(a.phase, b.phase) || !Object.is(a.currentAddress, b.currentAddress)) return false;
			const aIds = a.ids ?? [];
			const bIds = b.ids ?? [];
			if (aIds.length !== bIds.length) return false;
			for (let i = 0; i < aIds.length; i += 1) if (aIds[i] !== bIds[i]) return false;
			const aById = a.byId ?? {};
			const bById = b.byId ?? {};
			if (Object.keys(aById).length !== Object.keys(bById).length) return false;
			for (const key of Object.keys(aById)) if (!sameEntryVisible(aById[key], bById[key])) return false;
			return sameRecord(a.subagentsByParent, b.subagentsByParent) && sameRecord(a.jobsBySession, b.jobsBySession);
		}

		function makeListSetGate(options) {
			const coalesceMs = options.coalesceMs;
			let pending;
			let timer;
			let disposed = false;
			function flushPending() {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				if (pending === undefined) return;
				const next = pending;
				pending = undefined;
				options.publish(next);
			}
			return {
				set(next) {
					if (disposed) {
						options.publish(next);
						return;
					}
					if (!sameVisibleContent(options.getPublished(), next)) {
						if (timer !== undefined) {
							clearTimeout(timer);
							timer = undefined;
						}
						pending = undefined;
						options.publish(next);
						return;
					}
					pending = next;
					if (timer === undefined) timer = setTimeout(flushPending, coalesceMs);
				},
				dispose() {
					if (disposed) return;
					disposed = true;
					flushPending();
				}
			};
		}

		function installListGate(ctx) {
			let list;
			try {
				list = ctx.get("sessions")?.list;
			} catch {
				return () => {};
			}
			if (!list || typeof list.set !== "function" || typeof list.getSnapshot !== "function") return () => {};
			if (list.__dshmListGate) return () => {};
			const originalSet = list.set.bind(list);
			const gate = makeListSetGate({
				coalesceMs: 1000,
				getPublished: () => list.getSnapshot() ?? {},
				publish: (next) => originalSet(next)
			});
			list.set = gate.set;
			list.__dshmListGate = gate;
			return () => {
				gate.dispose();
				if (list.__dshmListGate === gate) {
					list.set = originalSet;
					delete list.__dshmListGate;
				}
			};
		}

		function isPhone() {
			const width = window.innerWidth;
			if (width < PHONE_ALWAYS) return true;
			if (width >= PHONE_NEVER) return false;
			return window.matchMedia(TOUCH_MQ).matches;
		}

		function detectExtras() {
			return {
				workspace: !!document.querySelector("[aria-label=\"工作区侧边栏\"], nav[aria-label=\"dsh-sidebar 导航\"]")
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
						react.createElement("p", { style: { margin: 0 } }, "窄屏默认会话页。顶栏左侧打开会话列表，右侧打开工作区（含文件 / Git / 信息 / 终端）。"),
						react.createElement("p", { style: { margin: "8px 0 0" } }, "输入框下的官方统计行已隐藏，用量看工作区「信息」。"))));
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
			const leftBtn = document.createElement("button");
			leftBtn.type = "button";
			leftBtn.className = "dshm-sidebtn dshm-sidebtn-left";
			leftBtn.setAttribute("aria-label", "会话列表");
			leftBtn.append(svg(["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"]));
			const rightBtn = document.createElement("button");
			rightBtn.type = "button";
			rightBtn.className = "dshm-sidebtn dshm-sidebtn-right";
			rightBtn.setAttribute("aria-label", "工作区");
			rightBtn.append(svg(["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"]));
			root.append(backdrop, leftBtn, rightBtn);
			const mount = () => {
				(document.body || document.documentElement).appendChild(root);
			};
			if (document.body) mount();
			else document.addEventListener("DOMContentLoaded", mount);

			const html = document.documentElement;
			let pane = "chat";
			let extras = detectExtras();
			let lastKb = -1;
			const kbSlot = { id: 0 };
			const modeSlot = { id: 0 };
			const treeSlot = { id: 0 };

			function rafOnce(slot, fn) {
				if (slot.id) return;
				slot.id = requestAnimationFrame(() => {
					slot.id = 0;
					fn();
				});
			}

			function cancelRafs() {
				if (kbSlot.id) cancelAnimationFrame(kbSlot.id);
				if (modeSlot.id) cancelAnimationFrame(modeSlot.id);
				if (treeSlot.id) cancelAnimationFrame(treeSlot.id);
				kbSlot.id = modeSlot.id = treeSlot.id = 0;
			}

			function col(suffix) {
				return document.querySelector(`[class$="${suffix}"]`);
			}

			function syncInert() {
				const side = col("sidebarCol");
				const details = col("detailsCol");
				const phone = html.hasAttribute("data-dsh-mobile");
				if (side) side.inert = !phone || pane !== "sessions";
				if (details) details.inert = !phone || pane !== "workspace";
			}

			function syncKeyboard() {
				const vv = window.visualViewport;
				if (!vv) {
					if (lastKb !== 0) {
						lastKb = 0;
						html.style.setProperty("--dshm-kb", "0px");
						html.removeAttribute("data-dsh-mobile-kb");
					}
					return;
				}
				const occluded = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
				if (occluded === lastKb) return;
				lastKb = occluded;
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

			function openWorkspaceRail() {
				const panel = document.querySelector("[role=\"complementary\"][aria-label=\"工作区侧边栏\"]");
				const body = panel && panel.firstElementChild;
				if (body && body.childElementCount > 0) return;
				const files = document.querySelector("nav[aria-label=\"dsh-sidebar 导航\"] button");
				if (files) files.click();
			}

			function paintButtons() {
				leftBtn.setAttribute("aria-pressed", pane === "sessions" ? "true" : "false");
				rightBtn.hidden = !extras.workspace;
				rightBtn.setAttribute("aria-pressed", pane === "workspace" ? "true" : "false");
			}

			function setPane(next) {
				if (!html.hasAttribute("data-dsh-mobile")) return;
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
				paintButtons();
				syncInert();
			}

			function enterPhone() {
				if (html.hasAttribute("data-dsh-mobile")) return;
				html.setAttribute("data-dsh-mobile", "");
				pane = "chat";
				html.setAttribute("data-dsh-mobile-pane", "chat");
				backdrop.hidden = true;
				setDetailsOpen(false);
				setSidebarExpanded(false);
				paintButtons();
				syncInert();
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
				html.removeAttribute("data-dsh-mobile-modal");
				html.style.removeProperty("--dshm-kb");
				lastKb = -1;
				backdrop.hidden = true;
				syncInert();
			}

			function syncMode() {
				extras = detectExtras();
				if (isPhone()) {
					enterPhone();
					paintButtons();
				} else {
					leavePhone();
				}
			}

			leftBtn.addEventListener("click", () => {
				setPane(pane === "sessions" ? "chat" : "sessions");
			});
			rightBtn.addEventListener("click", () => {
				setPane(pane === "workspace" ? "chat" : "workspace");
			});
			backdrop.addEventListener("click", () => setPane("chat"));

			// 只在选了会话（或新建会话）后收抽屉。工作区/分组行带 aria-expanded，
			// 点它是展开列表，收回的话手机上没法再点里面的会话。
			document.addEventListener("click", (event) => {
				if (!html.hasAttribute("data-dsh-mobile") || pane !== "sessions") return;
				const t = event.target;
				if (!t || !t.closest) return;
				if (t.closest("button[aria-label*=\"操作\"], button[aria-label*=\"设置\"], .dshm-sidebtn, .dshm-backdrop")) return;
				if (t.closest("button[aria-label*=\"新建会话\"]")) {
					setPane("chat");
					return;
				}
				const item = t.closest("[role=\"treeitem\"]");
				if (!item || item.hasAttribute("aria-expanded")) return;
				setPane("chat");
			}, true);

			function syncModal() {
				const settings = document.querySelector("[class$=\"overlay\"] > [class$=\"panel\"]");
				const layer = document.querySelector("[class$=\"overlayLayer\"]");
				const layerOpen = !!(layer && layer.querySelector("[class$=\"panel\"], [role=\"dialog\"]"));
				if (settings || layerOpen) html.setAttribute("data-dsh-mobile-modal", "");
				else html.removeAttribute("data-dsh-mobile-modal");
			}

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
				rafOnce(treeSlot, () => {
					if (!extras.workspace) {
						const next = detectExtras();
						if (next.workspace !== extras.workspace) {
							extras = next;
							if (html.hasAttribute("data-dsh-mobile")) paintButtons();
						}
					}
					attachFrameWatch();
					syncModal();
					syncInert();
				});
			});
			treeWatch.observe(document.documentElement, { childList: true, subtree: true });

			function onResize() { rafOnce(modeSlot, syncMode); }
			function onTouchMq() { rafOnce(modeSlot, syncMode); }
			function onViewport() { rafOnce(kbSlot, syncKeyboard); }
			const touchMq = window.matchMedia(TOUCH_MQ);
			window.addEventListener("resize", onResize);
			touchMq.addEventListener("change", onTouchMq);
			if (window.visualViewport) {
				window.visualViewport.addEventListener("resize", onViewport);
				window.visualViewport.addEventListener("scroll", onViewport);
			}

			syncMode();
			syncModal();
			const uninstallListGate = installListGate(ctx);

			const slots = ctx.get("slots");
			if (slots !== void 0) {
				slots.inject("settings.plugin.item", () => slots.register(
					{ name: "settings.plugin.item", key: "dsh-web-mobile" },
					() => react.createElement(MobileInfoCard)
				));
			}

			ctx.effect(() => () => {
				cancelRafs();
				uninstallListGate();
				style.remove();
				root.remove();
				attrWatch.disconnect();
				treeWatch.disconnect();
				window.removeEventListener("resize", onResize);
				touchMq.removeEventListener("change", onTouchMq);
				if (window.visualViewport) {
					window.visualViewport.removeEventListener("resize", onViewport);
					window.visualViewport.removeEventListener("scroll", onViewport);
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
