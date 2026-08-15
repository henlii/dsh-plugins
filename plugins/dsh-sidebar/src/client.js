// dsh-sidebar client half — pidance/OpenChamber-style right sidebar.
//
// Registers the `details` slot (the right column, replacing the shipped
// tool-details panel — 方案 A). Layout mirrors pidance's RightPanel: a
// persistent 44px icon rail at the panel's right edge with the navigation
// menu, plus a content panel that switches between 文件 / Git / 信息 tabs.
// Clicking a file opens a second-level editor view (content or diff mode).
// Data comes from the host half over the /api/dsh-sidebar/* routes.
window.__ModuleLoader__.load({
	id: "dsh-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");

		const name = "dsh-sidebar-client";
		const inject = ["slots"];

		const C = {
			panel: "var(--dsw-specific-sidebar-fill, #f6f7f9)",
			rail: "var(--dsw-alias-bg-layer-1, #ffffff)",
			border: "var(--dsw-alias-border-l1, #e2e6ec)",
			text: "var(--dsw-alias-label-primary, #1c2024)",
			muted: "var(--dsw-alias-label-secondary, #5a6472)",
			accent: "var(--dsw-alias-brand-primary, #1f6feb)",
			ok: "var(--dsw-alias-state-success-primary, #2e9e5b)",
			warn: "var(--dsw-alias-state-warn-primary, #c9820c)",
			err: "var(--dsw-alias-state-error-primary, #c0392b)",
			code: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
		};

		function SvgIcon({ children, size }) {
			return react.createElement("svg", {
				width: size || 16,
				height: size || 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, children);
		}

		function Icon({ kind, size }) {
			const common = { size };
			if (kind === "files") return react.createElement(SvgIcon, common, react.createElement("path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }));
			if (kind === "git") return react.createElement(SvgIcon, common,
				react.createElement("circle", { cx: 18, cy: 6, r: 3 }),
				react.createElement("circle", { cx: 6, cy: 18, r: 3 }),
				react.createElement("path", { d: "M6 15V9a3 3 0 0 1 3-3h6" }),
				react.createElement("path", { d: "m18 9 2 2-2 2" }),
				react.createElement("path", { d: "m6 15-2-2 2-2" }));
			if (kind === "info") return react.createElement(SvgIcon, common,
				react.createElement("circle", { cx: 12, cy: 12, r: 9 }),
				react.createElement("path", { d: "M12 8h.01" }),
				react.createElement("path", { d: "M11 12h1v4h1" }));
			if (kind === "refresh") return react.createElement(SvgIcon, common,
				react.createElement("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
				react.createElement("path", { d: "M3 3v5h5" }));
			if (kind === "back") return react.createElement(SvgIcon, common, react.createElement("path", { d: "M19 12H5" }), react.createElement("path", { d: "m12 19-7-7 7-7" }));
			if (kind === "save") return react.createElement(SvgIcon, common, react.createElement("path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" }), react.createElement("path", { d: "M17 21v-8H7v8" }), react.createElement("path", { d: "M7 3v5h8" }));
			if (kind === "folder") return react.createElement(SvgIcon, common, react.createElement("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }));
			if (kind === "file") return react.createElement(SvgIcon, common, react.createElement("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }), react.createElement("path", { d: "M14 2v6h6" }));
			if (kind === "chevron") return react.createElement(SvgIcon, common, react.createElement("path", { d: "m6 9 6 6 6-6" }));
			if (kind === "collapse") return react.createElement(SvgIcon, common, react.createElement("path", { d: "m9 18 6-6-6-6" }));
			if (kind === "terminal") return react.createElement(SvgIcon, common,
				react.createElement("path", { d: "M4 17l6-6-6-6" }),
				react.createElement("path", { d: "M12 19h8" }));
			return null;
		}

		// ── 终端面板（嵌在右侧栏的「终端」tab 里）────────────────────────────
		// REPL 式：点击终端直接输入，Enter 执行，Ctrl+C 中断；tab 切换多个终端。
		const wtRpc = async (method, args) => {
			const res = await fetch(`/api/dsh-web-terminal/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(args ?? {})
			});
			let data = {};
			try { data = await res.json(); } catch { /* non-json */ }
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			if (data.ok === false) throw new Error(data.error || "rpc failed");
			return data;
		};

		function SidebarTerminal({ sessionId }) {
			const el = react.createElement;
			const [terms, setTerms] = react.useState([]);
			const [activeId, setActiveId] = react.useState(null);
			const [output, setOutput] = react.useState("");
			const [line, setLine] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const outRef = react.useRef(null);

			react.useEffect(() => {
				if (!sessionId) return;
				let alive = true;
				let timer = null;
				const tick = async () => {
					try {
						const snap = await wtRpc("snapshot", { sessionId });
						if (!alive) return;
						setTerms(snap.terminals || []);
						setActiveId((cur) => {
							if (cur && (snap.terminals || []).some((t) => t.terminal_id === cur)) return cur;
							const mine = (snap.terminals || []).find((t) => t.mine);
							return (mine || (snap.terminals || [])[0] || {}).terminal_id || null;
						});
					} catch (e) { if (alive) setError(e.message); }
				};
				tick();
				timer = setInterval(tick, 1500);
				return () => { alive = false; if (timer) clearInterval(timer); };
			}, [sessionId]);

			react.useEffect(() => {
				if (!activeId || !sessionId) return;
				let alive = true;
				let timer = null;
				const read = async () => {
					try {
						const page = await wtRpc("read", { sessionId, id: activeId, count: 600 });
						if (alive) setOutput(page.text || "");
					} catch (e) { if (alive) setError(e.message); }
				};
				read();
				timer = setInterval(read, 1500);
				return () => { alive = false; if (timer) clearInterval(timer); };
			}, [activeId, sessionId]);

			react.useEffect(() => {
				if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
			}, [output]);

			const active = terms.find((t) => t.terminal_id === activeId) || null;

			const sendLine = (text) => {
				const t = text.trim();
				if (!t || !active || busy) return;
				setBusy(true); setError(null);
				wtRpc("send", { sessionId, id: active.terminal_id, text: t })
					.catch((e) => setError(e.message))
					.finally(() => setBusy(false));
			};
			const interrupt = () => {
				if (!active) return;
				setError(null);
				wtRpc("signal", { sessionId, id: active.terminal_id, signal: "SIGINT" }).catch((e) => setError(e.message));
			};
			const doNew = () => {
				setError(null);
				wtRpc("spawn", { sessionId, name: "终端", cwd: "/" }).then((r) => setActiveId(r.terminal_id)).catch((e) => setError(e.message));
			};
			const killTab = (id) => {
				setError(null);
				wtRpc("kill", { sessionId, id }).catch((e) => setError(e.message));
			};
			const handleKey = (e) => {
				if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); interrupt(); return; }
				if (e.key === "Enter") { e.preventDefault(); sendLine(line); setLine(""); return; }
				if (e.key === "Backspace") { e.preventDefault(); setLine((l) => l.slice(0, -1)); return; }
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					setLine((l) => l + e.key);
				}
			};

			return el("div", {
				style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", fontFamily: C.code, fontSize: 12, outline: "none" },
				tabIndex: 0,
				onKeyDown: handleKey,
				onClick: (e) => { if (e.target === e.currentTarget) e.currentTarget.focus(); }
			},
				// tab 条
				el("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "4px 2px", borderBottom: `1px solid ${C.border}`, overflowX: "auto", flex: "none" } },
					(terms.length === 0 ? [] : terms).map((t) =>
						el("span", {
							key: t.terminal_id,
							title: (t.mine ? "本会话 · " : "") + t.cwd,
							onClick: () => setActiveId(t.terminal_id),
							style: {
								cursor: "pointer", whiteSpace: "nowrap", padding: "2px 6px", fontSize: 12,
								color: t.terminal_id === activeId ? C.accent : C.muted,
								borderBottom: t.terminal_id === activeId ? `2px solid ${C.accent}` : "2px solid transparent"
							}
						},
							(t.mine ? "★" : "") + t.name,
							el("span", { onClick: (e) => { e.stopPropagation(); killTab(t.terminal_id); }, style: { marginLeft: 4, opacity: 0.6, cursor: "pointer" } }, "×"))
					),
					el("span", { onClick: doNew, style: { cursor: "pointer", color: C.muted, padding: "0 4px", fontSize: 14, flex: "none" } }, "+")
				),
				// 输出 + 直接输入
				el("div", {
					ref: outRef,
					style: { flex: 1, minHeight: 0, overflow: "auto", background: "#0d0f13", color: "#d4d7e0", padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5, cursor: "text" }
				},
					error ? el("div", { style: { color: "#f0a0a0" } }, "⚠ " + error) : null,
					output.length > 0
						? el("span", {}, output)
						: el("span", { style: { color: "#6b7280" } }, active ? "（无输出。直接输入命令，Enter 执行）" : "（暂无终端，点 + 新建）"),
					active ? el("span", {},
						el("span", { style: { color: "#2e9e5b" } }, "dsh$ "),
						line,
						el("span", { style: { display: "inline-block", width: 7, height: 13, background: "#d4d7e0", verticalAlign: "text-bottom", animation: "dsh-wt-blink 1s steps(1) infinite" } }, " ")
					) : null
				),
				el("style", {}, "@keyframes dsh-wt-blink{50%{opacity:0}}")
			);
		}

		/** Map a git change to a display badge. */
		function statusBadge(change) {
			const code = (change.worktree === " " ? change.index : change.worktree);
			const label = code === "?" ? "??" : code;
			const color = code === "?" ? C.muted : code === "A" ? C.ok : code === "D" ? C.err : C.warn;
			return react.createElement("span", {
				style: {
					fontSize: 10,
					fontWeight: 700,
					color,
					border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
					borderRadius: 4,
					padding: "0 3px",
					lineHeight: "15px",
					flex: "none"
				}
			}, label);
		}

		// Stats formatting, mirroring ui-conversation's StatsLine/ContextMeter so
		// the sidebar shows the same figures as the conversation UI.
		function formatTokens(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			if (n < 1e3) return String(n);
			if (n < 1e6) return `${scaled(n / 1e3)}K`;
			return `${scaled(n / 1e6)}M`;
		}
		function formatDuration(ms) {
			const s = ms / 1e3;
			if (s < 60) return `${Math.round(s * 10) / 10}s`;
			const whole = Math.round(s);
			return `${Math.floor(whole / 60)}m${whole % 60}s`;
		}
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}
		function billedInputTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		function cacheHitPercent(usage) {
			const denominator = billedInputTokens(usage);
			return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100);
		}
		function contextOccupancy(pressure) {
			const usedTokens = pressure ? pressure.projectedTokens ?? pressure.pressureTokens : void 0;
			if (usedTokens === void 0 || pressure === void 0 || pressure.contextWindow === void 0) return null;
			return {
				percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
				usedTokens,
				contextWindow: pressure.contextWindow
			};
		}

		function WorkspacePanel(props) {
			const { sessionId } = props;

			// The details column is "never unmounted" — it renders at width 0
			// when closed — so this panel mounts even while the column is
			// closed, and the layout only admits it for a real (non-blank)
			// session. Re-open on mount and on every session switch so the
			// sidebar follows the user; a manual close with no session change
			// is left alone (the effect does not re-run).
			react.useEffect(() => {
				setCollapsed(false);
				if (props.layout !== void 0 && typeof props.layout.openDetails === "function") {
					try {
						props.layout.openDetails();
					} catch {
						/* layout not wired yet — the column stays closed */
					}
				}
			}, [sessionId]);

			const [tab, setTab] = react.useState("files");
			const [collapsed, setCollapsed] = react.useState(false);
			const [data, setData] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [openDirs, setOpenDirs] = react.useState(() => new Set());
			const [edit, setEdit] = react.useState(null);
			const [draft, setDraft] = react.useState("");
			const [diffText, setDiffText] = react.useState("");
			const [diffMeta, setDiffMeta] = react.useState(null);
			const [saving, setSaving] = react.useState(false);

			// Live session projections (same sources as the conversation UI's
			// StatsLine and ContextMeter).
			const sessionStats = typeof props.useProjection === "function" ? props.useProjection("sessionStats") : void 0;
			const tokenUsage = typeof props.useProjection === "function" ? props.useProjection("tokenUsage") : void 0;
			const contextPressure = typeof props.useProjection === "function" ? props.useProjection("contextPressure") : void 0;
			const contextBreakdown = typeof props.useProjection === "function" ? props.useProjection("contextBreakdown") : void 0;

			const load = react.useCallback(async () => {
				if (!sessionId) return;
				setLoading(true);
				setError(null);
				try {
					const res = await fetch("/api/dsh-sidebar/snapshot", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId })
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok || !json.ok) {
						setError(json.error || "加载失败");
						setData(null);
						return;
					}
					setData(json);
				} catch {
					setError("无法连接服务器");
					setData(null);
				} finally {
					setLoading(false);
				}
			}, [sessionId]);

			react.useEffect(() => {
				void load();
			}, [load]);

			// path → git change map for badges.
			const changeMap = react.useMemo(() => {
				const map = new Map();
				if (data && data.git && Array.isArray(data.git.changes)) {
					for (const change of data.git.changes) map.set(change.path, change);
				}
				return map;
			}, [data]);

			const openFile = react.useCallback(async (path, mode) => {
				setEdit({ path, mode });
				setDraft("");
				setDiffText("");
				setDiffMeta(null);
				try {
					const res = await fetch(`/api/dsh-sidebar/${mode === "diff" ? "diff" : "read"}`, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, path })
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok || !json.ok) {
						setDiffText(json.error || "读取失败");
						return;
					}
					if (mode === "diff") {
						setDiffMeta({ untracked: !!json.untracked });
						setDiffText(json.untracked ? json.preview || "" : json.diff || "");
					} else {
						setDraft(json.content || "");
					}
				} catch {
					setDiffText("无法连接服务器");
				}
			}, [sessionId]);

			const save = react.useCallback(async () => {
				if (!edit || edit.mode !== "content") return;
				setSaving(true);
				try {
					const res = await fetch("/api/dsh-sidebar/write", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, path: edit.path, content: draft })
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok || !json.ok) {
						setError(json.error || "保存失败");
						setSaving(false);
						return;
					}
					setEdit(null);
					void load();
				} catch {
					setError("保存失败：无法连接服务器");
					setSaving(false);
				}
			}, [edit, draft, sessionId, load]);

			const toggleDir = (path) => {
				setOpenDirs((prev) => {
					const next = new Set(prev);
					if (next.has(path)) next.delete(path);
					else next.add(path);
					return next;
				});
			};

			const renderTree = (nodes, depth) => {
				if (!nodes || nodes.length === 0) return react.createElement("p", { style: { margin: 8, fontSize: 12, color: C.muted } }, "（空目录）");
				return nodes.map((node) => {
					const indent = { paddingLeft: 8 + depth * 13 };
					if (node.type === "dir") {
						const open = openDirs.has(node.path);
						return react.createElement("div", { key: node.path },
							react.createElement("button", {
								type: "button",
								onClick: () => toggleDir(node.path),
								style: { ...rowStyle, ...indent, color: C.text }
							},
								react.createElement("span", { style: { display: "inline-flex", width: 14, transform: open ? "none" : "rotate(-90deg)", transition: "transform .12s", color: C.muted } }, react.createElement(Icon, { kind: "chevron", size: 13 })),
								react.createElement("span", { style: { display: "inline-flex", color: C.warn } }, react.createElement(Icon, { kind: "folder", size: 15 })),
								react.createElement("span", { style: { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, node.name)),
							open ? renderTree(node.children, depth + 1) : null);
					}
					const change = changeMap.get(node.path);
					return react.createElement("button", {
						key: node.path,
						type: "button",
						title: node.path,
						onClick: () => void openFile(node.path, "content"),
						style: { ...rowStyle, ...indent, color: change ? C.text : C.muted }
					},
						react.createElement("span", { style: { display: "inline-flex", color: C.muted, marginRight: 2 } }, react.createElement(Icon, { kind: "file", size: 14 })),
						react.createElement("span", { style: { flex: 1, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, node.name),
						change ? statusBadge(change) : null);
				});
			};

			const header = (title, extra) => react.createElement("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 6,
					padding: "5px 8px",
					borderBottom: `1px solid ${C.border}`,
					flexShrink: 0
				}
			},
				react.createElement("span", { style: { flex: 1, fontSize: 12, fontWeight: 600, color: C.muted } }, title),
				extra);

			const iconBtn = (kind, label, onClick, active, badge) => react.createElement("button", {
				type: "button",
				onClick,
				title: label,
				"aria-label": label,
				"aria-pressed": active,
				style: {
					width: 34,
					height: 34,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					border: active ? `1px solid color-mix(in srgb, ${C.accent} 35%, transparent)` : "1px solid transparent",
					borderRadius: 7,
					background: active ? "color-mix(in srgb, var(--dsw-alias-bg-layer-2, #eef0f4) 60%, transparent)" : "transparent",
					color: active ? C.accent : C.muted,
					cursor: "pointer",
					position: "relative"
				}
			},
				react.createElement(Icon, { kind, size: 17 }),
				badge ? react.createElement("span", {
					"aria-hidden": true,
					style: { position: "absolute", right: 4, top: 4, width: 6, height: 6, borderRadius: "50%", background: C.accent, boxShadow: "0 0 0 2px var(--dsw-specific-sidebar-fill, #f6f7f9)" }
				}) : null);

			const rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 5,
				width: "100%",
				padding: "3px 6px",
				border: 0,
				background: "none",
				cursor: "pointer",
				font: "inherit",
				textAlign: "left",
				borderRadius: 6
			};

			// pidance-style rail: clicking a different tab switches to it;
			// clicking the already-active tab again retracts the content by
			// closing the details column (the fixed rail stays visible). Any
			// click while retracted reopens the column.
			const selectTab = (nextTab) => {
				if (nextTab === tab && !collapsed) {
					setCollapsed(true);
					if (props.layout !== void 0 && typeof props.layout.closeDetails === "function") {
						try {
							props.layout.closeDetails();
						} catch {
							/* layout not wired */
						}
					}
				} else {
					setCollapsed(false);
					setTab(nextTab);
					if (props.layout !== void 0 && typeof props.layout.openDetails === "function") {
						try {
							props.layout.openDetails();
						} catch {
							/* layout not wired */
						}
					}
				}
			};
			// The rail is fixed to the viewport's right edge so it stays visible
			// even when the details column is closed (dsh's layout only admits
			// widths ≥ 300px or 0 — there is no 44px column state).
			const rail = react.createElement("nav", {
				"aria-label": "dsh-sidebar 导航",
				style: {
					position: "fixed",
					right: 0,
					top: 0,
					bottom: 0,
					width: 44,
					zIndex: 30,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					gap: 4,
					paddingTop: 6,
					background: C.rail,
					borderLeft: `1px solid ${C.border}`
				}
			},
				iconBtn("files", "文件", () => selectTab("files"), tab === "files" && !collapsed),
				iconBtn("git", data && data.git && data.git.isGit && data.git.changes.length > 0 ? `Git (${data.git.changes.length})` : "Git", () => selectTab("git"), tab === "git" && !collapsed, data && data.git && data.git.isGit && data.git.changes.length > 0),
				iconBtn("info", "信息", () => selectTab("info"), tab === "info" && !collapsed),
				iconBtn("terminal", "终端", () => selectTab("terminal"), tab === "terminal" && !collapsed),
				react.createElement("div", { style: { flex: 1 } }));

			const content = () => {
				if (collapsed) return null;
				if (edit) {
					const isDiff = edit.mode === "diff";
					return react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
						header(edit.path,
							iconBtn("back", "返回", () => setEdit(null), false)),
						react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-1, #ffffff)" } },
							isDiff
								? react.createElement(react.Fragment, null,
									diffMeta && diffMeta.untracked
										? react.createElement("p", { style: { margin: "8px 10px", fontSize: 12, color: C.warn } }, "未跟踪文件（无 git diff，显示内容预览）")
										: null,
									react.createElement("pre", { style: { flex: 1, margin: 0, padding: 10, overflow: "auto", fontSize: 12, lineHeight: 1.5, color: C.text, fontFamily: C.code, whiteSpace: "pre-wrap", wordBreak: "break-all" } },
										diffText === "" && !diffMeta ? "加载中…" : diffText || "（无改动）"))
								: react.createElement("textarea", {
									value: draft,
									onChange: (event) => setDraft(event.target.value),
									spellCheck: false,
									style: {
										flex: 1,
										minHeight: 0,
										boxSizing: "border-box",
										width: "100%",
										padding: 10,
										border: 0,
										resize: "none",
										outline: "none",
										fontSize: 12.5,
										lineHeight: 1.5,
										fontFamily: C.code,
										color: C.text,
										background: "transparent"
									}
								}),
							react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 10px", borderTop: `1px solid ${C.border}` } },
								react.createElement("button", {
									type: "button",
									disabled: saving,
									onClick: () => void save(),
									style: { ...actionBtn, background: C.accent, color: "#fff", opacity: saving ? 0.6 : 1 }
								}, saving ? "保存中…" : "保存"))));
				}
				// 终端 tab：独立于文件/git 数据，直接渲染
				if (tab === "terminal") {
					return react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
						header("终端", null),
						react.createElement(SidebarTerminal, { sessionId }));
				}
				if (loading && !data) return react.createElement("p", { style: { margin: 12, fontSize: 12, color: C.muted } }, "加载中…");
				if (error && !data) return react.createElement("p", { style: { margin: 12, fontSize: 12, color: C.err } }, error);
				if (!data) return null;

				if (tab === "files") {
					return react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
						header(data.rootName || "工作区", iconBtn("refresh", "刷新", () => void load(), false)),
						react.createElement("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "4px 2px" } },
							renderTree(data.files, 0)));
				}
				if (tab === "git") {
					const git = data.git;
					return react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
						header(git && git.isGit ? (git.branch || "Git") : "Git", iconBtn("refresh", "刷新", () => void load(), false)),
						react.createElement("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "4px 2px" } },
							!git || !git.isGit
								? react.createElement("p", { style: { margin: 8, fontSize: 12, color: C.muted } }, "不是 git 仓库")
								: git.changes.length === 0
									? react.createElement("p", { style: { margin: 8, fontSize: 12, color: C.muted } }, "工作区干净")
									: git.changes.map((change) => react.createElement("button", {
										key: change.path,
										type: "button",
										onClick: () => void openFile(change.path, "diff"),
										title: change.path,
										style: rowStyle
									},
										statusBadge(change),
										react.createElement("span", { style: { flex: 1, fontSize: 12.5, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
											change.oldPath ? `${change.oldPath} → ${change.path}` : change.path)))));
				}
				// 会话信息 tab — session stats + context usage + basic info.
				// Stats mirror ui-conversation's StatsLine/ContextMeter from the
				// same projections, so the sidebar shows identical figures.
				const fmtTime = (ms) => {
					if (!ms) return null;
					try {
						return new Date(ms).toLocaleString();
					} catch {
						return String(ms);
					}
				};
				const statsGroups = [];
				if (sessionStats !== void 0 && sessionStats.steps > 0) {
					const counts = `${String(sessionStats.turns)} 轮 · ${String(sessionStats.steps)} 步`;
					const durations = [];
					if (sessionStats.llmMs > 0) durations.push(`LLM ${formatDuration(sessionStats.llmMs)}`);
					if (sessionStats.toolMs > 0) durations.push(`工具调用 ${formatDuration(sessionStats.toolMs)}`);
					const speeds = [];
					if (sessionStats.ttftSteps > 0) speeds.push(`首 token 平均 ${formatDuration(sessionStats.ttftMs / sessionStats.ttftSteps)}`);
					if (sessionStats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(sessionStats.decodeTokens / (sessionStats.decodeMs / 1e3))} tok/s`);
					statsGroups.push(counts);
					if (durations.length > 0) statsGroups.push(durations.join(" · "));
					if (speeds.length > 0) statsGroups.push(speeds.join(" · "));
				}
				if (tokenUsage !== void 0 && (billedInputTokens(tokenUsage) > 0 || tokenUsage.outputTokens > 0)) {
					const hit = cacheHitPercent(tokenUsage);
					if (hit !== null) statsGroups.push(`缓存命中 ${String(hit)}%`);
					statsGroups.push(`输入 ${formatTokens(billedInputTokens(tokenUsage))} tok · 输出 ${formatTokens(tokenUsage.outputTokens)} tok`);
				}
				const context = contextOccupancy(contextPressure);
				const infoRow = (label, value) => value == null ? null : react.createElement("div", {
					key: label,
					style: { marginBottom: 4, overflowWrap: "anywhere" }
				},
					react.createElement("strong", { style: { color: C.text, marginRight: 6 } }, label),
					"：",
					String(value));
				return react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
					header("会话信息", null),
					react.createElement("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px", fontSize: 12, lineHeight: 1.8, color: C.muted } },
						statsGroups.length > 0 && react.createElement("div", { style: { marginBottom: 12 } },
							statsGroups.map((group, i) => react.createElement("div", { key: i, style: { marginBottom: 3 } }, group))),
						context !== null && react.createElement("div", { style: { marginBottom: 12 } },
							react.createElement("div", { style: { fontWeight: 600, color: C.text, marginBottom: 4 } },
								`上下文已用 ${String(context.percent)}% ~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`),
							contextBreakdown !== void 0 && react.createElement("div", { style: { fontSize: 12, color: C.muted } },
								`系统提示词 ~${formatTokens(contextBreakdown.systemTokens)} · 工具 ~${formatTokens(contextBreakdown.toolsTokens)} · 对话消息 ~${formatTokens(contextBreakdown.messageTokens)}`)),
						infoRow("工作区", data.rootName),
						infoRow("路径", data.cwd),
						infoRow("会话 ID", sessionId),
						infoRow("Agent 预设", data.session ? data.session.agentPreset : null),
						infoRow("创建时间", data.session ? fmtTime(data.session.createdAt) : null),
						infoRow("Git", data.git && data.git.isGit ? (data.git.branch || "无分支") : "非 git 仓库")));
			};

			const actionBtn = {
				appearance: "none",
				font: "inherit",
				cursor: "pointer",
				border: 0,
				borderRadius: 6,
				padding: "5px 14px",
				fontSize: 12.5
			};

			return react.createElement("div", {
				role: "complementary",
				"aria-label": "工作区侧边栏",
				style: {
					height: "100%",
					position: "relative",
					background: C.panel,
					borderLeft: `1px solid ${C.border}`
				}
			},
				react.createElement("div", {
					style: {
						height: "100%",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
						paddingRight: 44
					}
				}, content()),
				rail);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === void 0) return;
			// The `inject` callback runs when the slot renders — by then the
			// layout service is wired, unlike at apply() time (mount order is
			// not strict tree order). The panel opens the details column in its
			// mount effect so the sidebar is visible without hunting the toggle.
			slots.inject("details", () => slots.register(
				{
					name: "details",
					id: "dsh-sidebar",
					priority: -1,
					inject: () => ({ layout: ctx.get("layout") })
				},
				(props) => react.createElement(WorkspacePanel, props)
			));

			// When the details column is retracted (frame gets
			// data-details-collapsed) the fixed rail would cover the center
			// column's right edge. Reserve its 44px via the center column's
			// right padding — the rail then occupies the reserved strip instead
			// of covering conversation content. Selectors use the stable
			// readable suffixes of the shell's hashed module classes.
			const style = document.createElement("style");
			style.textContent = '[class$="frame"][data-details-collapsed] [class$="centerCol"] { padding-right: 44px; }';
			document.head.appendChild(style);
			ctx.effect(() => () => {
				style.remove();
			}, "dsh-sidebar: rail reservation css");
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
