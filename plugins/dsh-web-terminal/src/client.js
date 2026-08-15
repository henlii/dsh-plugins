window.__ModuleLoader__.load({
	id: "dsh-web-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const CSS = [
			".wterm{box-sizing:border-box;flex-direction:column;gap:4px;padding:2px 0 6px;display:flex;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}",
			// 分割线即拖动杆：与上方 composer 的底边重叠成一条细线（-1px），
			// 样式对齐右侧栏的 1px 分隔线；拖动提示只靠 row-resize 光标
			".wterm-resize{height:3px;flex:none;cursor:row-resize;border-top:1px solid rgba(0,0,0,0.1);margin:-1px 0 0;background:transparent;position:relative}",
			// 细线中间的小圆角方块（对齐右侧栏分隔线中间的标识块）
			".wterm-resize::after{content:'';position:absolute;left:50%;top:-2px;transform:translateX(-50%);width:44px;height:4px;border-radius:2px;background:rgba(0,0,0,0.12)}",
			".wterm-tabs{align-items:center;gap:6px;display:flex;overflow-x:auto;scrollbar-width:thin;flex:none;padding:0}",
			".wterm-tab{box-sizing:border-box;height:24px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:0;padding:0 8px;font-size:12px;line-height:24px;font-family:inherit;flex:none;display:inline-flex;align-items:center;gap:6px;border-bottom:2px solid transparent}",
			".wterm-tab.active{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}",
			".wterm-tab.mine{color:var(--dsw-alias-brand-primary)}",
			".wterm-tab .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}",
			".wterm-tab .dot.running{background:var(--dsw-alias-state-success-primary)}",
			".wterm-tab .dot.exited{background:var(--dsw-alias-state-error-primary)}",
			".wterm-tab .x{cursor:pointer;opacity:.6;padding:0 2px;font-size:13px;line-height:13px;font-family:inherit}",
			".wterm-tab .x:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}",
			".wterm-add{box-sizing:border-box;height:24px;min-width:24px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:0;font-size:15px;line-height:24px;flex:none;padding:0 4px}",
			".wterm-out{box-sizing:border-box;height:180px;overflow:auto;background:#0d0f13;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:8px 10px;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;color:#d4d7e0;flex:none;cursor:text}",
			".wterm-empty{color:#6b7280}",
			".wterm-line{white-space:pre-wrap;word-break:break-all}",
			".wterm-cursor{display:inline-block;width:7px;height:14px;background:#d4d7e0;vertical-align:text-bottom;animation:wterm-blink 1s steps(1) infinite}",
			"@keyframes wterm-blink{50%{opacity:0}}",
			".wterm-bar{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:28px;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;background:transparent;border:none;width:100%;text-align:left}",
			".wterm-bar:hover{color:var(--dsw-alias-label-primary)}",
			".wterm-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-family:inherit;flex:none;padding:0}"
		].join("");

		const rpc = async (method, args) => {
			const res = await fetch(`/api/dsh-web-terminal/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(args ?? {})
			});
			let data = {};
			try { data = await res.json(); } catch { /* non-json */ }
			if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code });
			if (data.ok === false) throw Object.assign(new Error(data.error || "rpc failed"), { code: data.code });
			return data;
		};

		// Terminal-style panel below the input box (conversation.composer.dock):
		// a REPL — type directly into the terminal, Enter sends, Ctrl+C interrupts.
		// No separate command box or action buttons; only a tab strip for
		// multi-terminal management.
		function TerminalPanel(props) {
			const el = React.createElement;
			const sessionId = props.sessionId;
			const [open, setOpen] = React.useState(false);
			const [terms, setTerms] = React.useState([]);
			const [activeId, setActiveId] = React.useState(null);
			const [output, setOutput] = React.useState("");
			const [line, setLine] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [height, setHeight] = React.useState(180);
			const outRef = React.useRef(null);
			const rootRef = React.useRef(null);

			// 抵消 composer.dock 容器（uV2eYG_root 之类）的水平 padding，
			// 让面板真正两端对齐：找到第一个带水平 padding 的祖先，读它的
			// padding 值做负 margin（一次性，稳定）。
			React.useEffect(() => {
				const el = rootRef.current;
				if (!el) return;
				let a = el.parentElement;
				while (a) {
					const cs = getComputedStyle(a);
					const pl = parseFloat(cs.paddingLeft) || 0;
					const pr = parseFloat(cs.paddingRight) || 0;
					if (pl > 0 || pr > 0) {
						el.style.marginLeft = pl > 0 ? "-" + pl + "px" : "0px";
						el.style.marginRight = pr > 0 ? "-" + pr + "px" : "0px";
						break;
					}
					a = a.parentElement;
				}
			}, [open]);

			// drag the handle to resize the terminal output height
			const startResize = (e) => {
				e.preventDefault();
				const startY = e.clientY;
				const startH = height;
				const onMove = (ev) => {
					const next = Math.max(60, Math.min(600, startH + (startY - ev.clientY)));
					setHeight(next);
				};
				const onUp = () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				};
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			};

			React.useEffect(() => {
				if (!sessionId || !open) return;
				let alive = true;
				let timer = null;
				const tick = async () => {
					try {
						const snap = await rpc("snapshot", { sessionId });
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
				timer = setInterval(tick, 1000);
				return () => { alive = false; if (timer) clearInterval(timer); };
			}, [sessionId, open]);

			React.useEffect(() => {
				if (!activeId || !sessionId || !open) return;
				let alive = true;
				let timer = null;
				const read = async () => {
					try {
						const page = await rpc("read", { sessionId, id: activeId, count: 800 });
						if (alive) setOutput(page.text || "");
					} catch (e) { if (alive) setError(e.message); }
				};
				read();
				timer = setInterval(read, 1000);
				return () => { alive = false; if (timer) clearInterval(timer); };
			}, [activeId, sessionId, open]);

			// keep scrolled to the newest output line
			React.useEffect(() => {
				if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
			}, [output, open]);

			const active = terms.find((t) => t.terminal_id === activeId) || null;

			const sendLine = (text) => {
				const t = text.trim();
				if (!t || !active) return;
				if (busy) return;
				setBusy(true); setError(null);
				rpc("send", { sessionId, id: active.terminal_id, text: t })
					.catch((e) => setError(e.code === "SEND_ACTIVE" ? "该终端正被使用（发送冲突）" : e.message))
					.finally(() => setBusy(false));
			};
			const interrupt = () => {
				if (!active) return;
				setError(null);
				rpc("signal", { sessionId, id: active.terminal_id, signal: "SIGINT" }).catch((e) => setError(e.message));
			};
			const doNew = () => {
				setError(null);
				rpc("spawn", { sessionId, name: "终端", cwd: "/" })
					.then((r) => setActiveId(r.terminal_id))
					.catch((e) => setError(e.message));
			};
			const killTab = (id) => {
				setError(null);
				rpc("kill", { sessionId, id }).catch((e) => setError(e.message));
			};

			// capture typing directly in the terminal
			const handleKey = (e) => {
				if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); interrupt(); return; }
				if (e.key === "Enter") { e.preventDefault(); sendLine(line); setLine(""); return; }
				if (e.key === "Backspace") { e.preventDefault(); setLine((l) => l.slice(0, -1)); return; }
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					setLine((l) => l + e.key);
				}
			};

			if (!open) {
				return el("button", {
					className: "wterm-bar",
					ref: rootRef,
					title: "打开终端面板（输入框下方）",
					onClick: () => setOpen(true)
				},
					el("span", {}, "▸ 终端"),
					el("span", {}, terms.length > 0 ? `（${terms.length} 个终端${terms.some(t => t.mine) ? " · 本会话 ★" : ""}）` : "（无终端）")
				);
			}

			return el("div", { className: "wterm", ref: rootRef, tabIndex: 0, onKeyDown: handleKey, onClick: (e) => { if (e.target === e.currentTarget) e.currentTarget.focus(); } },
				// 分割线即拖动杆：面板顶部 1px 分隔线可上下拖动调整高度
				el("div", { className: "wterm-resize", title: "拖动调整终端高度", onMouseDown: startResize }),
				el("div", { className: "wterm-tabs" },
					// 折叠按钮放最前
					el("button", { className: "wterm-tab", title: "收起", onClick: () => setOpen(false) }, "▾"),
					(terms.length === 0 ? [] : terms).map((t) =>
						el("button", {
							key: t.terminal_id,
							className: "wterm-tab" + (t.terminal_id === activeId ? " active" : "") + (t.mine ? " mine" : ""),
							title: (t.mine ? "本会话 · " : "") + t.cwd,
							onClick: () => setActiveId(t.terminal_id)
						},
							el("span", { className: "dot " + (t.status === "running" ? "running" : "exited") }),
							t.name + (t.mine ? " ★" : ""),
							el("span", {
								className: "x",
								onClick: (e) => { e.stopPropagation(); killTab(t.terminal_id); }
							}, "×")
						)
					),
					el("button", { className: "wterm-add", title: "新建终端", onClick: doNew }, "+"),
					el("span", { style: { flex: 1 } })
				),
				el("div", { className: "wterm-out", ref: outRef, style: { height: height + "px" } },
					error ? el("div", { style: { color: "var(--dsw-alias-state-error-primary)" }, className: "wterm-empty" }, "⚠ " + error) : null,
					output.length > 0
						? el("span", { className: "wterm-line" }, output)
						: el("span", { className: "wterm-empty" }, active ? "（无输出。直接在终端里输入命令，Enter 执行）" : "（暂无终端，点 + 新建）"),
					active ? el("span", { className: "wterm-line" },
						el("span", { style: { color: "var(--dsw-alias-state-success-primary)" } }, "dsh$ "),
						line,
						el("span", { className: "wterm-cursor" }, " ")
					) : null
				)
			);
		}

		function apply(ctx) {
			const style = document.createElement("style");
			style.textContent = CSS;
			document.head.appendChild(style);

			const slots = ctx.get("slots");
			if (slots === undefined) return;

			// Below the input box (composer card) — the bottom-most panel seat.
			slots.inject("conversation.composer.dock", () => slots.register(
				{ name: "conversation.composer.dock", id: "web-terminal", order: 10 },
				(props) => React.createElement(TerminalPanel, props)
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
