// dsh-web-mobile client half — phone chrome for the shipped dsh web shell.
//
// Phone only (desktop keeps the official three-column layout untouched). Three
// things happen here:
//
//   1. Sidebars become overlay drawers. The shell collapses its sidebar to a
//      52px rail; on a phone that rail eats 14% of the width forever, so the
//      rail is hidden and the expanded panel is presented as a fixed overlay
//      with a mask. The shell already publishes the state we need on the frame
//      element (`data-sidebar-collapsed` / `data-rightbar-collapsed`), so the
//      drawer state is mirrored, never owned: collapsing the panel closes the
//      drawer from the shell's own side too.
//   2. Settings becomes two levels: the modal's nav is a full-width list, and
//      picking a section swaps to the section page with a back button, instead
//      of a nav column squeezing the content into one character per line.
//   3. Chat spacing: 16px inputs (iOS zoom guard), safe-area padding, 100dvh.
//
// Nothing here imports another plugin and no service is required: `ctx.layout`
// is read when present, and every element is found structurally, not by module
// hash (which changes on every host build).
window.__ModuleLoader__.load({
	id: "@henlii/dsh-web-mobile",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const name = "dsh-web-mobile-client";
		const inject = [];

		// Phone heuristics: always at a phone width, otherwise only for a coarse
		// pointer (a tablet-width touch device still wants the drawer).
		const PHONE_ALWAYS = 640;
		const PHONE_NEVER = 1024;
		const TOUCH_MQ = "(hover: none) and (pointer: coarse)";

		const CSS = `
html[data-dshm-phone] [class$="frame"]{grid-template-columns:minmax(0,1fr)!important;height:100dvh;box-sizing:border-box}
html[data-dshm-phone] [data-sidebar-collapsed] [class$="sidebarCol"]{display:none!important}html[data-dshm-phone][data-dshm-left="open"] [class$="frame"] [class$="sidebarCol"]{display:block!important;position:fixed;inset:0 auto 0 0;width:min(20rem,86vw)!important;height:100dvh;z-index:41;box-sizing:border-box;overflow:auto;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 0 32px rgba(0,0,0,.28)}
html[data-dshm-phone][data-dshm-left="open"] [class$="frame"] [class$="sidebarCol"]>div>div{width:100%!important;max-width:100%!important}
html[data-dshm-phone] [class$="rightbarCol"]{display:none!important}
html[data-dshm-phone][data-dshm-right="open"] [class$="rightbarCol"]{display:block!important;position:fixed;inset:0;width:100vw!important;height:100dvh;z-index:41;box-sizing:border-box;overflow:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);background:var(--dsw-alias-bg-layer-3,#fff)}
#dshm-mask{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.42);opacity:0;pointer-events:none;transition:opacity .16s ease}
html[data-dshm-phone][data-dshm-left="open"] #dshm-mask,html[data-dshm-phone][data-dshm-right="open"] #dshm-mask{opacity:1;pointer-events:auto}
#dshm-menu{appearance:none;flex:none;width:34px;height:34px;margin:0 2px 0 0;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#5a6472);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
#dshm-menu:active{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
#dshm-menu.dshm-float{position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:8px;z-index:30;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 1px 6px rgba(0,0,0,.14)}
html[data-dshm-phone] textarea,html[data-dshm-phone] input{font-size:16px!important}
html[data-dshm-phone] [role="dialog"]:not(.dshm-settings){max-width:calc(100vw - 16px)!important;max-height:calc(100dvh - 16px)!important}
html[data-dshm-phone] [data-radix-popper-content-wrapper]{max-width:calc(100vw - 16px)!important}
html[data-dshm-phone] .dshm-settings{flex-direction:column!important}
html[data-dshm-phone] .dshm-settings .dshm-nav{width:100%!important;max-width:none!important;flex:1 1 auto!important;min-height:0!important;overflow:auto;border-right:0!important;padding-top:calc(env(safe-area-inset-top,0px) + 4px);box-sizing:border-box}
html[data-dshm-phone] .dshm-settings .dshm-content{width:100%!important;max-width:none!important;flex:1 1 auto!important;min-height:0!important;padding-top:env(safe-area-inset-top,0px);box-sizing:border-box}
html[data-dshm-phone] .dshm-settings .dshm-navList{width:100%!important}
html[data-dshm-phone] .dshm-settings .dshm-navCell{width:100%!important;max-width:none!important}
html[data-dshm-phone] .dshm-settings[data-dshm-view="list"] .dshm-content{display:none!important}
html[data-dshm-phone] .dshm-settings[data-dshm-view="page"] .dshm-nav{display:none!important}
.dshm-navClose,.dshm-back{appearance:none;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#5a6472);font-size:17px;line-height:1;cursor:pointer}
.dshm-navClose{margin-left:auto}
.dshm-back{margin:0 4px 0 0}
.dshm-navClose:active,.dshm-back:active{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
`;

		const isPhone = () =>
			window.innerWidth <= PHONE_ALWAYS ||
			(window.innerWidth <= PHONE_NEVER && window.matchMedia(TOUCH_MQ).matches);

		const MENU_ICON =
			'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

		function apply(ctx) {
			// `ctx.layout` drives the shell's own sidebar state. Read lazily: a host
			// without the service still gets the CSS half (the drawer state comes
			// from the frame attributes either way).
			const layout = () => ctx.get("layout");

			const style = document.createElement("style");
			style.dataset.dshmStyle = "";
			style.textContent = CSS;

			const mask = document.createElement("div");
			mask.id = "dshm-mask";

			// 外壳把「收起」写成属性：收起时 `data-sidebar-collapsed="true"`，展开时
			// 整个属性被摘掉——所以判断展开是 `!hasAttribute`，不是读 "false"。
			const frame = () => {
				const el = document.querySelector('[class$="frame"]');
				if (el === null) return null;
				return el.querySelector('[class$="centerCol"],[data-dsh-center-col]') === null ? null : el;
			};
			const centerCol = () => document.querySelector("[data-dsh-center-col]") || document.querySelector('[class$="centerCol"]');
			const sidebarCol = () => document.querySelector('[class$="sidebarCol"]');

			// ── 抽屉状态：只镜像宿主的属性，不自己持有 ─────────────────────
			let frameWatched = null;
			const frameObserver = new MutationObserver(() => syncDrawerState());

			const syncDrawerState = () => {
				const el = frame();
				if (el !== null && el !== frameWatched) {
					frameObserver.disconnect();
					frameObserver.observe(el, {
						attributes: true,
						attributeFilter: ["data-sidebar-collapsed", "data-rightbar-collapsed"]
					});
					frameWatched = el;
				}
				const root = document.documentElement;
				if (el === null || !root.hasAttribute("data-dshm-phone")) {
					root.removeAttribute("data-dshm-left");
					root.removeAttribute("data-dshm-right");
					return;
				}
				const left = el.hasAttribute("data-sidebar-collapsed") ? "closed" : "open";
				const right = el.hasAttribute("data-rightbar-collapsed") ? "closed" : "open";
				if (left === "open") root.setAttribute("data-dshm-left", "open");
				else root.removeAttribute("data-dshm-left");
				if (right === "open") root.setAttribute("data-dshm-right", "open");
				else root.removeAttribute("data-dshm-right");
			};

			const collapseSidebar = () => {
				if (frame()?.hasAttribute("data-sidebar-collapsed") !== false) return;
				const service = layout();
				if (service !== void 0 && typeof service.toggleSidebar === "function") service.toggleSidebar();
				else document.querySelector('button[aria-label="收起侧边栏"]')?.click();
			};
			const expandSidebar = () => {
				if (frame()?.hasAttribute("data-sidebar-collapsed") !== true) return;
				const service = layout();
				if (service !== void 0 && typeof service.toggleSidebar === "function") service.toggleSidebar();
				else document.querySelector('button[aria-label="打开侧边栏"]')?.click();
			};
			const collapseRightbar = () => {
				const service = layout();
				if (service !== void 0 && typeof service.closeRightbar === "function") service.closeRightbar();
				else document.querySelector('button[aria-label="收起右侧边栏"]')?.click();
			};

			// ── 对话顶栏的 ☰ ────────────────────────────────────────────────
			const ensureMenu = () => {
				const existing = document.getElementById("dshm-menu");
				const col = centerCol();
				if (col === null) {
					existing?.remove();
					return;
				}
				const header = col.querySelector("header");
				const leading = header?.querySelector('[class*="headerLeading"]') ?? null;
				const button = existing ?? document.createElement("button");
				if (existing === null) {
					button.id = "dshm-menu";
					button.type = "button";
					button.setAttribute("aria-label", "打开侧边栏");
					button.innerHTML = MENU_ICON;
					button.addEventListener("click", () => {
						expandSidebar();
						syncDrawerState();
					});
				}
				if (leading !== null) {
					button.classList.remove("dshm-float");
					if (button.parentElement !== leading) leading.append(button);
				} else if (header !== null) {
					button.classList.add("dshm-float");
					if (button.parentElement !== document.body) document.body.append(button);
				}
			};

			// ── 设置：一级列表 / 二级页面 ───────────────────────────────────
			const settingsPanels = new Set();

			const closeSettings = (panel) => {
				panel.querySelector('[class*="close"]')?.click();
			};

			const installSettings = (nav) => {
				const panel = nav.parentElement;
				if (panel === null || panel.classList.contains("dshm-settings")) return;
				const content = [...panel.children].find((child) => child !== nav) ?? null;
				panel.classList.add("dshm-settings");
				nav.classList.add("dshm-nav");
				nav.querySelector('[class*="navList"]')?.classList.add("dshm-navList");
				content?.classList.add("dshm-content");
				panel.dataset.dshmView = "list";
				settingsPanels.add(panel);

				// 一级页的关闭按钮：官方 ✕ 住在内容区的头部，一级里它是隐藏的。
				const title = nav.querySelector('[class*="navTitle"]');
				if (title !== null && title.querySelector(".dshm-navClose") === null) {
					const close = document.createElement("button");
					close.type = "button";
					close.className = "dshm-navClose";
					close.setAttribute("aria-label", "关闭");
					close.textContent = "✕";
					close.addEventListener("click", () => closeSettings(panel));
					title.append(close);
				}

				// 二级页的返回按钮：进内容区头部，回到列表。
				const header = content?.querySelector('[class*="header"]') ?? null;
				if (header !== null && header.querySelector(".dshm-back") === null) {
					const back = document.createElement("button");
					back.type = "button";
					back.className = "dshm-back";
					back.setAttribute("aria-label", "返回设置列表");
					back.textContent = "‹";
					back.addEventListener("click", () => {
						panel.dataset.dshmView = "list";
					});
					header.prepend(back);
				}

				// 列表项 → 二级页。捕获阶段先改视图，官方自己的选中逻辑照常跑。
				nav.addEventListener(
					"click",
					(event) => {
						const cell = event.target instanceof Element ? event.target.closest('[class*="navCell"]') : null;
						if (cell !== null) panel.dataset.dshmView = "page";
					},
					true
				);
			};

			const annotateSettings = () => {
				for (const nav of document.querySelectorAll('nav[class$="_nav"]')) installSettings(nav);
				for (const panel of settingsPanels) if (!panel.isConnected) settingsPanels.delete(panel);
			};

			// 抽屉里点中会话 / 面板行 → 收起抽屉（跟 pidance 一致：选完就让位）。
			const onDocumentClick = (event) => {
				if (!document.documentElement.hasAttribute("data-dshm-phone")) return;
				const target = event.target instanceof Element ? event.target : null;
				if (target === null) return;
				const col = sidebarCol();
				if (col !== null && col.contains(target) && target.closest('[class*="sessionRow"],[class*="panelRow"],[class*="newSession"]') !== null) {
					// 官方自己的点击处理先跑完，再收抽屉，避免打断导航。
					setTimeout(collapseSidebar, 0);
				}
			};

			// ── phone 开关 ─────────────────────────────────────────────────
			let raf = 0;
			const sync = () => {
				raf = 0;
				const root = document.documentElement;
				const phone = isPhone();
				if (phone) {
					if (!root.hasAttribute("data-dshm-phone")) root.setAttribute("data-dshm-phone", "");
					if (style.parentElement === null) document.head.append(style);
					if (mask.parentElement === null) document.body.append(mask);
					ensureMenu();
					annotateSettings();
				} else {
					if (root.hasAttribute("data-dshm-phone")) root.removeAttribute("data-dshm-phone");
					style.remove();
					mask.remove();
					document.getElementById("dshm-menu")?.remove();
				}
				syncDrawerState();
			};
			const schedule = () => {
				if (raf === 0) raf = requestAnimationFrame(sync);
			};

			const treeObserver = new MutationObserver(() => {
				// 设置弹层每次打开都会新建节点；其余变异（流式消息）在 sync 里早退。
				schedule();
			});

			mask.addEventListener("click", () => {
				collapseSidebar();
				collapseRightbar();
				syncDrawerState();
			});
			document.addEventListener("click", onDocumentClick, true);
			window.addEventListener("resize", schedule);
			window.addEventListener("orientationchange", schedule);
			const touchMq = window.matchMedia(TOUCH_MQ);
			touchMq.addEventListener("change", schedule);

			document.head.append(style);
			document.body.append(mask);
			treeObserver.observe(document.body, { childList: true, subtree: true });
			sync();

			ctx.effect(
				() => () => {
					if (raf !== 0) cancelAnimationFrame(raf);
					treeObserver.disconnect();
					frameObserver.disconnect();
					document.removeEventListener("click", onDocumentClick, true);
					window.removeEventListener("resize", schedule);
					window.removeEventListener("orientationchange", schedule);
					touchMq.removeEventListener("change", schedule);
					style.remove();
					mask.remove();
					document.getElementById("dshm-menu")?.remove();
					document.documentElement.removeAttribute("data-dshm-phone");
					document.documentElement.removeAttribute("data-dshm-left");
					document.documentElement.removeAttribute("data-dshm-right");
					settingsPanels.clear();
				},
				"dsh-web-mobile: chrome cleanup"
			);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
