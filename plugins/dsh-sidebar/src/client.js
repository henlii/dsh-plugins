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
			return null;
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
				// 会话信息 tab — render every field the host snapshot carries.
				const fmtTime = (ms) => {
					if (!ms) return null;
					try {
						return new Date(ms).toLocaleString();
					} catch {
						return String(ms);
					}
				};
				const s = data.session;
				const infoRows = [
					["工作区", data.rootName],
					["路径", data.cwd],
					["会话 ID", sessionId],
					["创建时间", s && fmtTime(s.createdAt)],
					["Agent 预设", s && s.agentPreset],
					["父会话", s && s.parentSession],
					["来源", s && s.origin === "subagent" ? "子代理" : s && s.origin],
					["委派深度", s && s.delegationDepth],
					["种子长度", s && s.seedLength],
					["Git", data.git && data.git.isGit ? (data.git.branch || "无分支") : "非 git 仓库"]
				];
				return react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
					header("会话信息", null),
					react.createElement("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px", fontSize: 12, lineHeight: 1.8, color: C.muted } },
						infoRows.map(([label, value]) => value == null ? null : react.createElement("div", {
							key: label,
							style: { marginBottom: 4, overflowWrap: "anywhere" }
						},
							react.createElement("strong", { style: { color: C.text, marginRight: 6 } }, label),
							"：",
							String(value)))));
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
