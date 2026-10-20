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
// 窄屏布局（从 dsh-web-mobile 迁入）：抽屉侧栏、两级设置、手机间距。
// 独立函数作用域，避免与下面认证面板的常量重名；由 factory 调用一次、apply 里安装。
function installMobileChrome(require) {
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
/* ── 手机可视高度校正（两条，都在 dvh 支持下生效）─────────────────────────
   背景：手机浏览器把 100%/100vh 算成「地址栏已隐藏」的那个高度；地址栏一显示，多出来的
   那 ~57px 就成了文档的可滚动溢出，按住输入框上方的空白能把整个应用（标题栏 + 会话区 +
   输入框）拖上去，右缘还冒滚动条。真机读数：html 695/751、over 56，拖到底 scrollHeight
   涨到 26738。
   1) 文档高度按当前可见高度，应用正好贴合可视区（顺带让输入框不再落在地址栏下面）；
   2) dsh-better-sidebar 的面板宿主在降级态是它自己的 position:absolute + height:100vh
      （sidebar.module.css），absolute 以初始包含块为参照，宿主的 overflow 裁不住它；它的
      100vh 就是那 57px 溢出的来源（真机读数：endsAtBottom div b752 h752 absolute
      clip=none{data-dsh-panel-host}）。把高度改回 dvh，底边正好落在可见区底部。
      它的 fixed 态不参与文档滚动，不受影响。 */
@supports (height:100dvh){html[data-dshm-narrow]{height:100dvh}
html[data-dshm-narrow] [data-dsh-panel-host][data-dsh-panel-host-degraded]{height:100dvh}}
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
/* 工作区树里「目录行 / 会话行」行尾的 ⋯ 菜单：宿主写成 hover（或菜单已开）才 display:inline-flex，
   触摸设备没有 hover —— 手机上这两类行因此永远没有行菜单入口（重命名 / 分叉 / 删除）。窄屏改成常驻。
   类名是 CSS Module 哈希（每次构建都换），按行与操作区的语义子串定位，不写死前缀。
   行内其余元素（时间、置顶标记）保持宿主原样：它们与按钮同显只是挤一点，标题已有省略号。 */
html[data-dshm-narrow] [class*="projectRow"] [class*="rowActions"],
html[data-dshm-narrow] [class*="sessionRow"] [class*="rowActions"]{display:inline-flex!important}
html[data-dshm-narrow] textarea,html[data-dshm-narrow] input{font-size:16px!important}
html[data-dshm-narrow] [role="dialog"]:not(.dshm-settings){max-width:calc(100vw - 16px)!important;max-height:calc(100dvh - 16px)!important}
html[data-dshm-narrow] [data-radix-popper-content-wrapper]{max-width:calc(100vw - 16px)!important}
/* 设置面板铺满可视区。宿主那套是桌面对话框：overlay 用 flex 居中，panel 是
   width:800px / max-width:calc(100vw - 48px)（手机上左右各留 24px）/ height:min(800px,
   calc(100vh - 48px))（100vh 是地址栏隐藏高度，居中的面板上下都越界，真机反馈「左右留白、
   上下超限」）。position:fixed + inset:0 让它脱离居中、贴住可见区左上角；100dvh 给正好可见
   的高度；圆角去掉、四边到边。上边安全区由面板内 nav/content 各自的 padding 处理（本插件已加），
   下边在这里补。 */
html[data-dshm-narrow] .dshm-settings{flex-direction:column!important;position:fixed!important;inset:0!important;width:100vw!important;max-width:none!important;height:100dvh!important;max-height:100dvh!important;border-radius:0!important;padding-bottom:env(safe-area-inset-bottom,0px)}
/* 窄屏不占滚动条位、也不画滚动条。宿主给会话与工作区树都写了 scrollbar-gutter:stable，手机浏览器
   用经典滚动条时那条保留位常驻 ~15px 且不画任何东西——卡片顶到边后就露成「右侧一条间隙」；设置
   面板是 fixed 到视口的，也会被同一个经典滚动条压窄。手机上本来也不画滚动条，去掉后布局里没有
   这条保留位。 */
html[data-dshm-narrow] *{scrollbar-gutter:auto;scrollbar-width:none}
html[data-dshm-narrow] *::-webkit-scrollbar{width:0;height:0}
/* 问答卡片（ask_user）与计划审批卡片左右不留白：它们的 frame 左右各留
   var(--dsh-composer-side-clearance) + 16px（默认 24px），窄屏直接顶到边。钩子是宿主自己的
   data-question-key / data-plan-review-key（滚动历史里的「已回答」小行是另一套 .row/.bubble，
   不受影响）。 */
html[data-dshm-narrow] [data-question-key],
html[data-dshm-narrow] [data-plan-review-key]{padding-left:0!important;padding-right:0!important}
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

			// 行尾动作区（`[class*="rowActions"]`）：工作区行里「⋯（工作区菜单）」与「新会话」都是
			// button.iconButton、都没有 aria-haspopup，只能按顺序认——⋯ 在前、新会话在后
			// （dsh-client-ui-workspace 的 Rows：先 Menu 锚点、再 Tooltip 包着的 + 按钮）。
			// 动作区还必须属于工作区行本身：会话行的动作区同样嵌在 projectRow 的子树里。
			const rowClassOf = (slot) => {
				let node = slot.parentElement;
				for (let i = 0; i < 3 && node !== null; i += 1) {
					const cls = String(node.getAttribute("class") || "");
					if (/projectRow|sessionRow|panelRow|searchResultRow/.test(cls)) return cls;
					node = node.parentElement;
				}
				return "";
			};
			const isWorkspaceNewSession = (target) => {
				const slot = target.closest('[class*="rowActions"]');
				if (slot === null || !rowClassOf(slot).includes("projectRow")) return false;
				const button = target.closest("button");
				if (button === null) return false;
				const buttons = slot.querySelectorAll("button");
				return buttons.length > 0 && button === buttons[buttons.length - 1];
			};

			// 抽屉什么时候让位：只有**导航**才收——点会话行 / 面板行本身、顶部「新建会话」、工作区行的
			// 「新会话」。行尾动作区里的按钮一概不收：那些是挂在行上的菜单（会话 ⋯ 走 portal，工作区 ⋯
			// 不走），抽屉一收，不 portal 的那个会被一起藏掉，portal 的那个也会瞬间从行上脱开。
			const onDocumentClick = (event) => {
				if (!document.documentElement.hasAttribute("data-dshm-narrow")) return;
				const target = event.target instanceof Element ? event.target : null;
				if (target === null) return;
				const col = sidebarCol();
				if (col === null || !col.contains(target)) return;
				if (target.closest('[class*="rowActions"]') !== null) {
					if (!isWorkspaceNewSession(target)) return;
				} else if (target.closest('[class*="sessionRow"],[class*="panelRow"],[class*="newSession"]') === null) {
					return;
				}
				// 官方自己的点击处理先跑完，再收抽屉，避免打断导航。
				setTimeout(collapseSidebar, 0);
			};

			// ── 手机上点编辑器工具行的按钮不要弹键盘 ──────────────────────────
			// 宿主给工具行的每个按钮都挂了「保焦」：onMouseDown → keepDraftFocus()
			// （event.preventDefault() + editor.focus()），「+」的 onClick 还会再
			// focusDraftEditor() 一次（dsh-client-ui-conversation）。桌面无感——键盘本来就
			// 在；手机上是：没在打字时点一下「+」，软键盘被这一下叫出来、挡住半个屏幕。
			// 这里只做收尾：按下之前焦点不在输入框里，就等宿主两个 handler 跑完把焦点收
			// 回来（键盘随之收起）；已经在打字（焦点本就在编辑器）则完全不插手——宿主保
			// 选区、菜单跟着输入过滤都照旧。
			const composerSeat = () => {
				const conversation = document.querySelector("[data-conversation-scroll]");
				return conversation === null ? null : conversation.lastElementChild;
			};
			const draftFocused = () => {
				const active = document.activeElement;
				if (active === null || active === document.body) return false;
				return active.isContentEditable === true || active.tagName === "TEXTAREA" || active.tagName === "INPUT";
			};
			let composerTapAt = 0;
			const onComposerPointerDown = (event) => {
				composerTapAt = 0;
				if (!document.documentElement.hasAttribute("data-dshm-narrow") || draftFocused()) return;
				const target = event.target instanceof Element ? event.target : null;
				const seat = composerSeat();
				if (target === null || seat === null) return;
				const button = target.closest("button");
				if (button === null || !seat.contains(button)) return;
				composerTapAt = performance.now();
			};
			const onComposerClick = () => {
				if (composerTapAt === 0 || performance.now() - composerTapAt > 700) return;
				composerTapAt = 0;
				// 宿主在 mousedown/click 里聚焦；等这一轮事件跑完（下一帧）再收焦点。
				requestAnimationFrame(() => {
					if (draftFocused()) document.activeElement?.blur();
				});
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
			// 冒泡阶段收尾：宿主（React 在 #root 上委派）的 handler 先跑，我们再收焦点。
			document.addEventListener("pointerdown", onComposerPointerDown, true);
			document.addEventListener("click", onComposerClick, false);
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
					document.removeEventListener("pointerdown", onComposerPointerDown, true);
					document.removeEventListener("click", onComposerClick, false);
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
		return { name, inject, apply };
	}

window.__ModuleLoader__.load({
	id: "@henlii/dsh-web-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");
		const mobileChrome = installMobileChrome(require);

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

		// ── Web 访问（手机 / 远程入口）───────────────────────────────────────
		// 本地监听固定回环，面板不暴露它；这里配置的是插件自带的代理：开关、端口，
		// 以及可直接在手机上打开的地址（密码在同一张卡片上半部分）。
		const ACCESS_ENDPOINT = "/api/dsh-web-auth/access";

		function ServiceBindBlock() {
			const [state, setState] = react.useState(null);
			const [enabled, setEnabled] = react.useState(true);
			const [port, setPort] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			const [copied, setCopied] = react.useState("");

			const load = react.useCallback(() => {
				return fetch(ACCESS_ENDPOINT, { credentials: "same-origin", cache: "no-store" })
					.then((res) => res.json().catch(() => ({})).then((data) => ({ res, data })))
					.then(({ res, data }) => {
						if (!res.ok || !data || !data.ok) {
							setState({
								editable: false,
								reason: res.status === 404
									? "宿主还没加载访问配置接口（重启 dsh 后可用）"
									: (data && data.error) || "无法读取访问配置"
							});
							return;
						}
						setState(data);
						if (typeof data.enabled === "boolean") setEnabled(data.enabled);
						if (typeof data.port === "number") setPort(String(data.port));
					})
					.catch(() => setState({ editable: false, reason: "无法连接服务器" }));
			}, []);
			react.useEffect(() => { void load(); }, [load]);

			const save = () => {
				if (busy || state === null || state.editable !== true) return;
				const value = port.trim();
				if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
					setMsg({ kind: "err", text: "入口端口要是 1-65535 的整数" });
					return;
				}
				setBusy(true); setMsg(null);
				fetch(ACCESS_ENDPOINT, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ enabled, port: Number(value) })
				}).then((res) => res.json().catch(() => ({})).then((data) => ({ res, data })))
					.then(({ res, data }) => {
						if (res.ok && data && data.ok) {
							setState(data);
							if (typeof data.port === "number") setPort(String(data.port));
							const first = Array.isArray(data.urls) && data.urls.length > 0 ? data.urls[0] : null;
							setMsg(first === null
								? { kind: "ok", text: "已保存：入口已关闭" }
								: { kind: "ok", text: `已保存：手机访问 ${first}` });
							return;
						}
						setMsg({ kind: "err", text: (data && data.error) || `保存失败（HTTP ${String(res.status)}）` });
					})
					.catch(() => setMsg({ kind: "err", text: "无法连接服务器" }))
					.finally(() => setBusy(false));
			};

			const copy = (url) => {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					navigator.clipboard.writeText(url).then(
						() => { setCopied(url); setTimeout(() => setCopied(""), 1500); },
						() => {}
					);
				}
			};

			const editable = state !== null && state.editable === true;
			const reason = state !== null && state.editable !== true ? state.reason : null;
			const urls = state !== null && Array.isArray(state.urls) ? state.urls : [];
			const tone = msg === null
				? null
				: msg.kind === "err" ? "var(--dsw-alias-label-error)"
					: msg.kind === "ok" ? "var(--dsw-alias-state-success-primary)"
						: "var(--dsw-alias-label-secondary)";

			return react.createElement(react.Fragment, null,
				react.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 500, margin: "14px 0 6px" } }, "Web 访问"),
				react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 13 } },
					react.createElement("input", {
						type: "checkbox", checked: enabled, disabled: !editable || busy,
						onChange: (e) => setEnabled(e.target.checked)
					}),
					"启用手机 / 远程访问"),
				react.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
					react.createElement("input", {
						className: "dsh-o-input", inputMode: "numeric", value: port,
						disabled: !editable || busy || !enabled,
						"aria-label": "入口端口", placeholder: "端口", style: { width: 120 },
						onChange: (e) => setPort(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") save(); }
					}),
					react.createElement("button", {
						type: "button", className: "dsh-o-btn dsh-o-btn-save", disabled: !editable || busy, onClick: save
					}, busy ? "提交中…" : "保存")),
				enabled && urls.length > 0 ? react.createElement("ul", {
					style: { listStyle: "none", margin: "0 0 8px", padding: 0, display: "flex", flexDirection: "column", gap: 6 }
				}, urls.map((url) => react.createElement("li", {
					key: url, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 }
				},
					react.createElement("a", { href: url, style: { color: "var(--dsw-alias-brand-text)", wordBreak: "break-all" } }, url),
					react.createElement("button", {
						type: "button", className: "dsh-o-btn dsh-o-btn-discard", style: { flex: "0 0 auto" },
						onClick: () => copy(url)
					}, copied === url ? "已复制" : "复制")))) : null,
				reason === null ? null : react.createElement("p", { className: "dsh-o-status", style: { margin: "6px 0 0" } }, reason),
				msg === null ? null : react.createElement("p", { style: { margin: "6px 0 0", color: tone, fontSize: 12, lineHeight: 1.5 } }, msg.text),
				react.createElement("p", { className: "dsh-o-status", style: { marginTop: 6 } },
					"手机与上面的密码一起使用；本机回环（127.0.0.1）访问不需要密码。这个开关同时管桌面端的「浏览器访问」，改动后需重启 DSH Desktop 生效。"));
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
			mobileChrome.apply(ctx);
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
