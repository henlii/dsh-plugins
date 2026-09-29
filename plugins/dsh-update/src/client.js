// dsh-update client half — the "dsh 更新" card on this plugin's page under
// Plugins → Installed.
//
// The card is the whole surface: it never injects a banner or touches the shell,
// because an upgrade is an operator action, not a notification. It shows the
// running version next to each source's idea of the newest, lets the operator
// switch the release channel, lists the recent releases with a search box, pins
// any of them, and keeps upgrade progress and the restart button in view.
//
// Upgrading and restarting are deliberately two buttons: npm replacing the
// install does not change the running process, so the operator decides when to
// pay the restart (which drops every live WebSocket, including this page).
window.__ModuleLoader__.load({
	id: "@henlii/dsh-update",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-update-client";
		// Only the slot service is a hard dependency; everything else is fetched
		// over HTTP from the host half, so the card works regardless of which
		// other client plugins happen to be mounted.
		const inject = ["slots"];
		const PACKAGE_NAME = "@henlii/dsh-update";
		const ROUTE = "/api/dsh-update";

		// How the running dsh copy was installed. Shown verbatim so an operator can
		// see which tool will be invoked before pressing update.
		const LAYOUT_LABELS = {
			"npm-global": "npm 全局",
			"pnpm-global": "pnpm 全局",
			"yarn-global": "yarn 全局",
			"bun-global": "bun 全局",
			profile: "profile 本地",
			source: "源码树",
			unknown: "无法判定"
		};

		const CARD_CSS = `
.dsh-u-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.dsh-u-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px}
.dsh-u-body{padding:16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.dsh-u-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.dsh-u-ver{color:var(--dsw-alias-label-primary);font-weight:600;font-size:15px;font-variant-numeric:tabular-nums}
.dsh-u-tag{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-u-up{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-brand-primary));font-weight:500}
.dsh-u-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-u-mut{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsh-u-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.dsh-u-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsh-u-btn:disabled{opacity:.4;cursor:default}
.dsh-u-btn-main{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-u-btn-ghost{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dsh-u-btn-danger{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-error);background:0 0}
.dsh-u-btn-mini{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 8px;font-size:12px;line-height:18px;background:0 0;color:var(--dsw-alias-label-secondary)}
.dsh-u-btn-mini:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dsh-u-btn-mini:disabled{opacity:.4;cursor:default}
.dsh-u-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:30px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:12px;line-height:1.5;box-sizing:border-box}
.dsh-u-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsh-u-list{list-style:none;margin:8px 0 0;padding:0;max-height:230px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.dsh-u-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px}
.dsh-u-item:first-child{border-top:none}
.dsh-u-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-u-item-cur{background:var(--dsw-alias-bg-layer-2)}
.dsh-u-itemv{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;min-width:96px}
.dsh-u-itemd{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-u-notes{margin:8px 0 0;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;white-space:pre-wrap;max-height:160px;overflow:auto}
.dsh-u-log{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.dsh-u-err{color:var(--dsw-alias-label-error);font-size:12px;margin:6px 0 0}
.dsh-u-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary));font-size:12px;margin:6px 0 0}
.dsh-u-sep{border-top:1px solid var(--dsw-alias-border-l1);margin:14px 0 0;padding-top:12px}`;

		// ── helpers ──────────────────────────────────────────────────────────

		function formatTime(iso) {
			if (typeof iso !== "string" || iso.length === 0) return "";
			const at = new Date(iso);
			if (Number.isNaN(at.getTime())) return "";
			const days = Math.floor((Date.now() - at.getTime()) / 86400000);
			const stamp = `${String(at.getFullYear()).slice(2)}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
			if (days <= 0) return `${stamp}（今天）`;
			if (days === 1) return `${stamp}（昨天）`;
			return `${stamp}（${String(days)} 天前）`;
		}

		function formatElapsed(ms) {
			if (typeof ms !== "number" || ms < 0) return "";
			const sec = Math.floor(ms / 1000);
			if (sec < 60) return `${String(sec)} 秒`;
			return `${String(Math.floor(sec / 60))} 分 ${String(sec % 60)} 秒`;
		}

		async function postJson(path, body) {
			const res = await fetch(`${ROUTE}${path}`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {})
			});
			const data = await res.json().catch(() => ({}));
			return { status: res.status, ok: res.ok && data && data.ok === true, data: data || {} };
		}

		async function getJson(path) {
			const res = await fetch(`${ROUTE}${path}`, { method: "GET", credentials: "same-origin" });
			const data = await res.json().catch(() => ({}));
			return { status: res.status, ok: res.ok && data && data.ok === true, data: data || {} };
		}

		// ── the card ─────────────────────────────────────────────────────────

		function UpdaterCard() {
			const [status, setStatus] = react.useState(null);
			const [versions, setVersions] = react.useState(null);
			const [query, setQuery] = react.useState("");
			const [busy, setBusy] = react.useState("");
			const [message, setMessage] = react.useState(null);
			const [error, setError] = react.useState("");
			// Set only to render the immediate "restarting" state after the host
			// accepts the request; the page is about to be disconnected.
			const [restarting, setRestarting] = react.useState(false);

			const applyStatus = (data) => {
				setStatus(data);
				if (data && Array.isArray(data.versions)) setVersions(data.versions);
			};

			const loadVersions = async (q) => {
				const result = await getJson(`/versions${q ? `?q=${encodeURIComponent(q)}` : ""}`);
				if (result.ok && Array.isArray(result.data.versions)) {
					setVersions(result.data.versions);
					return result.data;
				}
				return null;
			};

			const refresh = async (force) => {
				setError("");
				try {
					const result = force ? await postJson("/check") : await getJson("/status");
					if (!result.ok) {
						setError((result.data && result.data.error) || `请求失败（HTTP ${String(result.status)}）`);
						return;
					}
					applyStatus(result.data);
					if (!force) void loadVersions("");
				} catch {
					setError("无法连接服务器");
				}
			};

			// The host keeps install phase and log in memory; poll only while an
			// install is running, so an idle card costs nothing.
			const installingRef = react.useRef(false);
			installingRef.current = status !== null && status.update !== null && status.update !== void 0 && status.update.phase === "installing";

			react.useEffect(() => {
				void refresh(false);
				const timer = setInterval(() => {
					if (!installingRef.current) return;
					void (async () => {
						try {
							const result = await getJson("/status");
							if (result.ok) applyStatus(result.data);
						} catch {
							/* a dropped poll while the service restarts is expected */
						}
					})();
				}, 2000);
				return () => clearInterval(timer);
			}, []);

			const switchChannel = async (channel) => {
				setBusy("channel");
				setError("");
				try {
					const result = await postJson("/channel", { channel });
					if (!result.ok) setError((result.data && result.data.error) || "切换通道失败");
					else {
						applyStatus(result.data);
						setMessage({ ok: true, text: `已切换到 ${channel} 通道` });
					}
				} catch {
					setError("无法连接服务器");
				}
				setBusy("");
			};

			const runUpdate = async (version) => {
				setBusy("update");
				setError("");
				setMessage(null);
				try {
					const result = await postJson("/update", version ? { version } : {});
					if (result.status !== 202 || !(result.data && result.data.started)) {
						setError((result.data && result.data.error) || "无法开始更新");
						setBusy("");
						return;
					}
					setMessage({ ok: true, text: `正在安装 ${String(result.data.target)}…` });
					// Pull the host's "installing" phase right away so the poll below
					// sees it; otherwise the card would wait for the first interval tick
					// and could miss progress on a fast install.
					const now = await getJson("/status");
					if (now.ok) applyStatus(now.data);
				} catch {
					setError("无法连接服务器");
				}
				setBusy("");
			};

			const doRestart = async () => {
				setBusy("restart");
				setError("");
				try {
					const result = await postJson("/restart");
					if (!(result.data && result.data.ok)) {
						setError((result.data && result.data.error) || "重启失败");
						setBusy("");
						return;
					}
					setRestarting(true);
				} catch {
					setError("无法连接服务器");
					setBusy("");
				}
			};

			if (status === null) {
				return react.createElement(react.Fragment, null,
					react.createElement("style", { "data-plugin-css": "dsh-update/card", dangerouslySetInnerHTML: { __html: CARD_CSS } }),
					react.createElement("ul", { className: "dsh-u-cards" },
						react.createElement("li", { className: "dsh-u-card" },
							react.createElement("div", { className: "dsh-u-body" },
								error.length > 0
									? react.createElement("p", { className: "dsh-u-err", style: { margin: 0 } }, error)
									: "加载中…"))));
			}

			const update = status.update || {};
			const installing = update.phase === "installing";
			const install = status.install || null;
			const channel = status.channel;
			const entry = (status.channels && status.channels[channel]) || {};
			const current = status.current;
			const newest = entry.version;
			const upToDate = typeof newest === "string" && newest === current;
			const list = versions === null ? [] : versions;

			const head = react.createElement("div", null,
				react.createElement("div", { className: "dsh-u-head" },
					react.createElement("span", { className: "dsh-u-ver" }, current === null ? "版本未知" : `当前 v${String(current)}`),
					current !== null && current !== newest
						? react.createElement("span", { className: "dsh-u-mut" }, "→")
						: null,
					current !== null && typeof newest === "string" && current !== newest
						? react.createElement("span", { className: "dsh-u-ver dsh-u-up" },
							`${status.hasUpdate ? "最新" : "该通道"} v${String(newest)}`)
						: null,
					react.createElement("span", { className: "dsh-u-tag" }, `${String(channel)} 通道`),
					react.createElement("span", { className: "dsh-u-tag" },
						status.sources && status.sources.registry && status.sources.registry.ok ? "registry ✓" : "registry ✗"),
					react.createElement("span", { className: "dsh-u-tag" },
						status.sources && status.sources.github && status.sources.github.ok ? "github ✓" : "github ✗")),
				react.createElement("div", { className: "dsh-u-mut" },
					upToDate
						? react.createElement("span", { className: "dsh-u-ok" }, "已是该通道的最新版本")
						: status.isDowngrade
							? `该通道当前指向 ${String(newest)}，低于运行版本（可显式选择其它版本）`
							: typeof newest === "string"
								? `可更新到 v${String(newest)}${entry.source ? `（来源 ${String(entry.source)}）` : ""}`
								: "两个来源都不可达，无法判断是否有新版本"),
				status.installRoot
					? react.createElement("div", { className: "dsh-u-mut", style: { wordBreak: "break-all" } },
						`安装位置 ${String(status.installRoot)}`)
					: null,
				install
					? react.createElement("div", { className: "dsh-u-mut" },
						`安装方式 ${String(LAYOUT_LABELS[install.layout] || install.layout)}` +
						(install.manager ? ` · 由 ${String(install.manager)} 更新` : "") +
						(install.usable === false ? "（该命令不可用）" : ""))
					: null,
				react.createElement("div", { className: "dsh-u-mut" },
					`registry ${String(status.registryBase || "")}` +
					(status.systemdUnit ? ` · 服务 ${String(status.systemdUnit)}` : " · 非 systemd 托管")),
				react.createElement("div", { className: "dsh-u-mut" }, `检查于 ${formatTime(status.checkedAt) || "未知"}`));

			const controls = react.createElement("div", null,
				react.createElement("div", { className: "dsh-u-row" },
					react.createElement("span", { className: "dsh-u-mut" }, "通道"),
					["latest", "next", "alpha"].map((tag) =>
						react.createElement("button", {
							key: tag,
							type: "button",
							className: tag === channel ? "dsh-u-btn dsh-u-btn-main" : "dsh-u-btn dsh-u-btn-ghost",
							disabled: busy !== "" || installing,
							onClick: () => { void switchChannel(tag); }
						}, tag))),
				react.createElement("div", { className: "dsh-u-row" },
					react.createElement("button", {
						type: "button", className: "dsh-u-btn dsh-u-btn-main",
						disabled: installing || busy !== "" || typeof newest !== "string" || upToDate,
						onClick: () => { void runUpdate(""); }
					}, installing ? "安装中…" : typeof newest === "string" ? `更新到 v${String(newest)}` : "更新"),
					react.createElement("button", {
						type: "button", className: "dsh-u-btn dsh-u-btn-ghost",
						disabled: busy !== "",
						onClick: () => { void refresh(true); }
					}, "重新检查")));

			// One release row. Built in a helper so the list markup stays readable:
			// deep createElement nesting is where bracket mistakes hide.
			const versionRow = (row) => {
				const isCurrent = row.version === current;
				const cells = [
					react.createElement("span", { key: "v", className: "dsh-u-itemv" },
						`v${String(row.version)}`,
						isCurrent ? react.createElement("span", { className: "dsh-u-tag", style: { marginLeft: 6 } }, "当前") : null)
				];
				if (row.tags && row.tags.length > 0) {
					cells.push(react.createElement("span", { key: "tag", className: "dsh-u-tag" }, row.tags.join(" / ")));
				} else if (row.prerelease) {
					cells.push(react.createElement("span", { key: "pre", className: "dsh-u-tag" }, "预发行"));
				}
				if (!row.onRegistry) {
					cells.push(react.createElement("span", {
						key: "gh", className: "dsh-u-tag", title: "registry 尚未收录，来自 GitHub release"
					}, "仅 GitHub"));
				}
				cells.push(react.createElement("span", { key: "at", className: "dsh-u-itemd" }, formatTime(row.at) || "—"));
				if (row.url) {
					cells.push(react.createElement("a", {
						key: "notes", href: row.url, target: "_blank", rel: "noreferrer",
						className: "dsh-u-btn-mini", style: { textDecoration: "none" }
					}, "说明"));
				}
				cells.push(react.createElement("button", {
					key: "install", type: "button", className: "dsh-u-btn-mini",
					disabled: installing || busy !== "" || isCurrent,
					title: isCurrent ? "已是当前版本" : `安装 v${String(row.version)}`,
					onClick: () => { void runUpdate(row.version); }
				}, isCurrent ? "已装" : "装这个"));
				return react.createElement("li", {
					key: row.version,
					className: isCurrent ? "dsh-u-item dsh-u-item-cur" : "dsh-u-item"
				}, cells);
			};

			const searchRow = react.createElement("div", { className: "dsh-u-row", style: { marginTop: 6 } },
				react.createElement("input", {
					className: "dsh-u-input",
					style: { flex: 1, minWidth: 140 },
					placeholder: "搜索版本，如 0.1.7、rc、0.2",
					value: query,
					onChange: (e) => setQuery(e.target.value),
					onKeyDown: (e) => { if (e.key === "Enter") void loadVersions(query); }
				}),
				react.createElement("button", {
					type: "button", className: "dsh-u-btn-mini",
					onClick: () => { void loadVersions(query); }
				}, "搜索"),
				query.length > 0
					? react.createElement("button", {
						type: "button", className: "dsh-u-btn-mini",
						onClick: () => { setQuery(""); void loadVersions(""); }
					}, "清除")
					: null);

			const history = react.createElement("div", { className: "dsh-u-sep" },
				react.createElement("div", { className: "dsh-u-head" },
					react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 500 } }, "近期版本"),
					react.createElement("span", { className: "dsh-u-mut" },
						`共 ${String(list.length)} 个${query.length > 0 ? "（已筛选）" : ""}`)),
				searchRow,
				react.createElement("ul", { className: "dsh-u-list" },
					list.length === 0
						? react.createElement("li", { className: "dsh-u-item dsh-u-mut" }, "没有匹配的版本")
						: list.map(versionRow)));

			// Release notes for the version the search box last matched: showing the
			// newest entry's notes keeps the card useful without a per-row expander.
			const noted = list.find((row) => typeof row.notes === "string" && row.notes.length > 0) || null;
			const notes = noted === null
				? null
				: react.createElement("div", null,
					react.createElement("div", { className: "dsh-u-mut", style: { marginTop: 10 } }, `v${String(noted.version)} 更新说明`),
					react.createElement("pre", { className: "dsh-u-notes" }, String(noted.notes)));

			const progress = react.createElement("div", { className: "dsh-u-sep" },
				react.createElement("div", { className: "dsh-u-head" },
					react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontWeight: 500 } }, "更新状态"),
					react.createElement("span", { className: update.phase === "done" ? "dsh-u-tag dsh-u-ok" : "dsh-u-tag" },
						update.phase === "installing" ? "安装中"
							: update.phase === "done" ? "已完成"
								: update.phase === "failed" ? "失败" : "空闲")),
				update.phase !== "idle" || update.target !== null
					? react.createElement("div", { className: "dsh-u-mut" },
						`目标 v${String(update.target || "")}` +
						(update.versionBefore ? ` · 开始前 v${String(update.versionBefore)}` : "") +
						(update.versionAfter ? ` · 结束后 v${String(update.versionAfter)}` : "") +
						(installing && typeof update.elapsedMs === "number" ? ` · 已用 ${formatElapsed(update.elapsedMs)}` : ""))
					: react.createElement("div", { className: "dsh-u-mut" }, "本次会话还没有执行过更新"),
				Array.isArray(update.log) && update.log.length > 0
					? react.createElement("pre", { className: "dsh-u-log" }, update.log.join("\n"))
					: null,
				update.phase === "done" && update.versionAfter !== null
					? react.createElement("p", { className: "dsh-u-warn" }, "安装已完成，但运行中的进程仍是旧版本；点下面的「重启服务」后生效。")
					: null,
				react.createElement("div", { className: "dsh-u-row" },
					react.createElement("button", {
						type: "button", className: "dsh-u-btn dsh-u-btn-danger",
						disabled: busy !== "" || installing || restarting,
						onClick: () => { void doRestart(); }
					}, restarting ? "已触发重启…" : "重启服务"),
					react.createElement("span", { className: "dsh-u-mut" },
						restarting
							? "服务正在重启，本页会断开，稍后刷新即可"
							: status.systemdUnit
								? `通过 systemctl --user 重启 ${String(status.systemdUnit)}（会断开当前页面）`
								: "非 systemd 托管：由看门狗脚本按原命令行重拉（会断开当前页面）")),
				status.restart && status.restart.ok
					? react.createElement("div", { className: "dsh-u-mut" }, `上次重启：${formatTime(status.restart.at)} · ${String(status.restart.mode || "")}`)
					: null);

			return react.createElement(react.Fragment, null,
				react.createElement("style", { "data-plugin-css": "dsh-update/card", dangerouslySetInnerHTML: { __html: CARD_CSS } }),
				react.createElement("ul", { className: "dsh-u-cards" },
					react.createElement("li", { className: "dsh-u-card" },
						react.createElement("div", { className: "dsh-u-body" },
							head,
							controls,
							message ? react.createElement("p", { className: message.ok ? "dsh-u-mut dsh-u-ok" : "dsh-u-err", style: { margin: "8px 0 0" } }, message.text) : null,
							error.length > 0 ? react.createElement("p", { className: "dsh-u-err", style: { margin: "8px 0 0" } }, error) : null,
							history,
							notes,
							progress))));
		}

		function apply(ctx) {
			ctx.inject(["slots"], (scope) => {
				// Settings → independent page. `settings.section` renders one page per
				// entry and the `label` is what puts it in the settings nav, so this is
				// the "own tab" placement: reachable without hunting for the plugin row
				// under Plugins → Installed. The card is the same component in both
				// seats, so the two never drift.
				scope.slots.inject("settings.section", () => scope.slots.register(
					{ name: "settings.section", id: "dsh-update", order: 40, label: () => "dsh 更新" },
					(props) => react.createElement(UpdaterCard, props)
				));

				// Plugins → Installed → this package's detail page keeps the same card,
				// so the plugin is discoverable from where an operator manages plugins.
				scope.slots.inject("plugins.detail.section", () => scope.slots.register(
					{ name: "plugins.detail.section", id: "dsh-update", order: 20 },
					(props) => {
						const pkg = props !== void 0 && props.subject !== void 0 ? props.subject.pkg : void 0;
						if (pkg === void 0 || pkg.name !== PACKAGE_NAME) return null;
						return react.createElement(UpdaterCard, props);
					}
				));
			});
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
