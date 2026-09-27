// dsh-web-mobile client half — narrow-viewport chrome for the shipped dsh web shell.
//
// Narrow viewports only (width < the shell's own 1024 auto-collapse point; a
// wide window keeps the official three-column layout untouched):
//
//   1. The left sidebar becomes an overlay drawer. The shell collapses it to a
//      52px rail below 1024px; that rail eats 14% of a phone width forever, so
//      it is hidden and the expanded panel is presented as a fixed overlay with
//      a mask. The shell publishes the state we need on the frame element
//      (`data-sidebar-collapsed`), so the drawer state is mirrored, never
//      owned: collapsing the panel closes the drawer from the shell's side too.
//      The right column is deliberately left alone — the shell already turns it
//      into a full-width drawer below its own 768px presentation threshold.
//   2. Settings becomes two levels: the modal's nav is a full-width list, and
//      picking a section swaps to the section page with a back button, instead
//      of a nav column squeezing the content into one character per line.
//   3. Chat spacing: 16px inputs (iOS zoom guard) and safe-area padding.
//
// It deliberately does NOT touch the document's scrolling model: the shell's
// narrow layout scrolls the document and keeps the composer stuck to the
// viewport bottom with `position: sticky`. Locking html/body (or giving the
// frame its own viewport height) turns that sticky into a static element that
// scrolls away with the transcript — the composer then drifts off screen.
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

		// Narrow-viewport threshold. The shell's own layout constant is
		// SIDEBAR_AUTO_COLLAPSE = 1024 (`ui-layout`): below it the sidebar
		// auto-collapses to the 52px rail and expanding it pushes the conversation.
		// Matching that number — instead of a phone-only heuristic — is what keeps
		// a single switch: resizing past it must not show a state where the rail is
		// already collapsed but the drawer chrome is not there yet.
		const NARROW_MAX = 1024;

const TABLE_CSS = `
/* 表格：唯一一条不限宽度的规则。
   宿主给 ≥4 列的宽表格容器做了"左右外扩"（width:100%+lead+spare、margin-left:-lead、
   padding-left:lead，把表格伸进正文列两侧的空白，同时让首列仍与正文对齐），并且把它的
   overflow-x 写死 hidden（桌面靠 hover 才切 scroll，触摸设备根本没有 hover）。
   本插件取消这个外扩，让容器正好等于正文列宽，再改成可横滚：表格和滚动条都留在会话区内，
   超宽时横着滚。md-table-wide 是宿主写死的字面类名（不是 CSS Module 哈希），可以直接命中。 */
[data-conversation-scroll] .md-table-wide{width:100%!important;max-width:100%!important;margin-left:0!important;padding-left:0!important;overflow-x:auto!important;overscroll-behavior-x:contain}
`;

		const CSS = `
/* 收起：第一轨已被归零，列自身 overflow:hidden，栏内容自然不可见。这里不能用 display:none —— 网格项一旦消失，后面的列会左移一轨，把对话挤进 0px。 */
html[data-dshm-narrow] [class$="frame"] [class$="sidebarCol"]{overflow:hidden}
/* 展开：抽屉挂在列的内层（列本身留在网格里，否则对话会掉进 0px 轨）。 */
html[data-dshm-narrow][data-dshm-left="open"] [class$="frame"] [class$="sidebarCol"]>div{display:block!important;position:fixed;inset:0 auto 0 0;width:min(20rem,86vw);height:100dvh;z-index:41;box-sizing:border-box;overflow:auto;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 0 32px rgba(0,0,0,.28)}
html[data-dshm-narrow][data-dshm-left="open"] [class$="frame"] [class$="sidebarCol"]>div>div{width:100%!important;max-width:100%!important}
#dshm-mask{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.42);opacity:0;pointer-events:none;transition:opacity .16s ease}
html[data-dshm-narrow][data-dshm-left="open"] #dshm-mask{opacity:1;pointer-events:auto}
#dshm-menu{appearance:none;flex:none;width:34px;height:34px;margin:0 2px 0 0;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#5a6472);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
#dshm-menu:active{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
#dshm-menu.dshm-float{position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:8px;z-index:30;background:var(--dsw-alias-bg-layer-3,#fff);box-shadow:0 1px 6px rgba(0,0,0,.14)}
html[data-dshm-narrow] textarea,html[data-dshm-narrow] input{font-size:16px!important}
html[data-dshm-narrow] [role="dialog"]:not(.dshm-settings){max-width:calc(100vw - 16px)!important;max-height:calc(100dvh - 16px)!important}
html[data-dshm-narrow] [data-radix-popper-content-wrapper]{max-width:calc(100vw - 16px)!important}
html[data-dshm-narrow] .dshm-settings{flex-direction:column!important}
html[data-dshm-narrow] .dshm-settings .dshm-nav{width:100%!important;max-width:none!important;flex:1 1 auto!important;min-height:0!important;overflow:auto;border-right:0!important;padding-top:calc(env(safe-area-inset-top,0px) + 4px);box-sizing:border-box}
html[data-dshm-narrow] .dshm-settings .dshm-content{width:100%!important;max-width:none!important;flex:1 1 auto!important;min-height:0!important;padding-top:env(safe-area-inset-top,0px);box-sizing:border-box}
html[data-dshm-narrow] .dshm-settings .dshm-navList{width:100%!important}
html[data-dshm-narrow] .dshm-settings .dshm-navCell{width:100%!important;max-width:none!important}
html[data-dshm-narrow] .dshm-settings[data-dshm-view="list"] .dshm-content{display:none!important}
html[data-dshm-narrow] .dshm-settings[data-dshm-view="page"] .dshm-nav{display:none!important}
.dshm-navClose,.dshm-back{appearance:none;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#5a6472);font-size:17px;line-height:1;cursor:pointer}
.dshm-navClose{margin-left:auto}
.dshm-back{margin:0 4px 0 0}
.dshm-navClose:active,.dshm-back:active{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
`;

		const isNarrow = () => window.innerWidth < NARROW_MAX;

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

			// Kept outside the narrow-gated sheet: a table that cannot be scrolled is
			// wrong at every width, and the narrow sheet is removed on a wide window.
			const tableStyle = document.createElement("style");
			tableStyle.dataset.dshmTables = "";
			tableStyle.textContent = TABLE_CSS;

			// The shell frame is a three-track grid (sidebar | center | rightbar).
			// Collapsing it to a single column moves the rightbar cell into a second
			// grid row, and the shell anchors its right panel to that cell with
			// `position:absolute` — the panel then parks below the fold. So only the
			// FIRST track is zeroed (the rail is what we are reclaiming); the center
			// and rightbar tracks keep exactly the values the shell wrote.
			const gridRule = document.createElement("style");
			gridRule.dataset.dshmGrid = "";

			const splitTracks = (value) => {
				const tracks = [];
				let depth = 0;
				let current = "";
				for (const ch of value) {
					if (ch === "(") depth += 1;
					if (ch === ")") depth -= 1;
					if (depth === 0 && ch === " ") {
						if (current !== "") tracks.push(current);
						current = "";
						continue;
					}
					current += ch;
				}
				if (current !== "") tracks.push(current);
				return tracks;
			};

			const applyFrameGrid = () => {
				const el = frame();
				const inline = el === null ? "" : el.style.getPropertyValue("grid-template-columns").trim();
				const tracks = inline === "" ? [] : splitTracks(inline);
				const next = tracks.length === 3
					? `html[data-dshm-narrow] [class$="frame"]{grid-template-columns:0px ${tracks.slice(1).join(" ")}!important}`
					: "";
				if (gridRule.textContent !== next) gridRule.textContent = next;
			};

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
				// Only the left drawer is ours: the shell already presents the right
				// column as a full-width drawer below its own 768px presentation
				// threshold (`autoFullscreen`), so touching it can only break it.
				const root = document.documentElement;
				if (el === null || !root.hasAttribute("data-dshm-narrow")) {
					root.removeAttribute("data-dshm-left");
					return;
				}
				if (el.hasAttribute("data-sidebar-collapsed")) root.removeAttribute("data-dshm-left");
				else root.setAttribute("data-dshm-left", "open");
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
				if (!document.documentElement.hasAttribute("data-dshm-narrow")) return;
				const target = event.target instanceof Element ? event.target : null;
				if (target === null) return;
				const col = sidebarCol();
				if (col !== null && col.contains(target) && target.closest('[class*="sessionRow"],[class*="panelRow"],[class*="newSession"]') !== null) {
					// 官方自己的点击处理先跑完，再收抽屉，避免打断导航。
					setTimeout(collapseSidebar, 0);
				}
			};

			// ── 窄屏开关 ─────────────────────────────────────────────────
			let raf = 0;
			const sync = () => {
				raf = 0;
				const root = document.documentElement;
				const narrow = isNarrow();
				if (narrow) {
					if (!root.hasAttribute("data-dshm-narrow")) root.setAttribute("data-dshm-narrow", "");
					if (style.parentElement === null) document.head.append(style);
					if (mask.parentElement === null) document.body.append(mask);
					ensureMenu();
					annotateSettings();
				} else {
					if (root.hasAttribute("data-dshm-narrow")) root.removeAttribute("data-dshm-narrow");
					style.remove();
					mask.remove();
					document.getElementById("dshm-menu")?.remove();
				}
				applyFrameGrid();
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
				syncDrawerState();
			});
			document.addEventListener("click", onDocumentClick, true);
			window.addEventListener("resize", schedule);
			window.addEventListener("orientationchange", schedule);

			document.head.append(style);
			document.head.append(tableStyle);
			document.head.append(gridRule);
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
					style.remove();
					gridRule.remove();
					mask.remove();
					document.getElementById("dshm-menu")?.remove();
					tableStyle.remove();
					document.documentElement.removeAttribute("data-dshm-narrow");
					document.documentElement.removeAttribute("data-dshm-left");
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
