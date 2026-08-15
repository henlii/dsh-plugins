window.__ModuleLoader__.load({
	id: "dsh-web-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const CSS = [
			".wterm-dock{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;flex-direction:column;gap:6px;padding:6px 10px 10px;display:flex;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
			".wterm-tabs{align-items:center;gap:6px;display:flex;overflow-x:auto;scrollbar-width:thin}",
			".wterm-tab{box-sizing:border-box;height:26px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px 6px 0 0;padding:0 8px;font-size:12px;line-height:24px;font-family:inherit;flex:none;display:inline-flex;align-items:center;gap:6px}",
			".wterm-tab.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-0,#0d0f13)}",
			".wterm-tab.mine{outline:1px solid var(--dsw-alias-brand-primary)}",
			".wterm-tab .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}",
			".wterm-tab .dot.running{background:var(--dsw-alias-state-success-primary)}",
			".wterm-tab .dot.exited{background:var(--dsw-alias-state-error-primary)}",
			".wterm-tab .x{cursor:pointer;opacity:.6;padding:0 2px;font-size:14px;line-height:14px;font-family:inherit}",
			".wterm-tab .x:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}",
			".wterm-add{box-sizing:border-box;height:26px;width:26px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;font-size:16px;line-height:24px;flex:none}",
			".wterm-add:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}",
			".wterm-head{align-items:center;gap:10px;display:flex;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".wterm-title{font-weight:600;color:var(--dsw-alias-label-primary)}",
			".wterm-out{box-sizing:border-box;height:200px;overflow:auto;background:var(--dsw-alias-bg-layer-0,#0d0f13);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);flex:none}",
			".wterm-empty{color:var(--dsw-alias-label-dimmed)}",
			".wterm-row{align-items:center;gap:8px;display:flex}",
			".wterm-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;height:32px;padding:0 10px;font-size:13px;font-family:inherit;flex:1;min-width:0}",
			".wterm-input:focus{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".wterm-btn{box-sizing:border-box;height:32px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:12px;line-height:18px;font-family:inherit;flex:none}",
			".wterm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".wterm-btn.primary{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
			".wterm-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".wterm-btn:disabled{opacity:.5;cursor:default}",
			".wterm-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-dimmed);font-family:inherit}",
			".wterm-bar{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:30px;padding:0 4px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;background:transparent;border:none;width:100%;text-align:left}",
			".wterm-bar:hover{color:var(--dsw-alias-label-primary)}"
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

		// Self-contained bottom-bar panel: one component owns its open state,
		// tabs, output polling, and controls. No cross-slot shared state.
		function TerminalPanel(props) {
			const el = React.createElement;
			const sessionId = props.sessionId;
			const [open, setOpen] = React.useState(false);
			const [terms, setTerms] = React.useState([]);
			const [activeId, setActiveId] = React.useState(null);
			const [output, setOutput] = React.useState("");
			const [input, setInput] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);

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
						const page = await rpc("read", { sessionId, id: activeId, count: 500 });
						if (alive) setOutput(page.text || "");
					} catch (e) { if (alive) setError(e.message); }
				};
				read();
				timer = setInterval(read, 1000);
				return () => { alive = false; if (timer) clearInterval(timer); };
			}, [activeId, sessionId, open]);

			const act = async (fn) => {
				if (busy) return;
				setBusy(true); setError(null);
				try { await fn(); } catch (e) { setError(e.code === "SEND_ACTIVE" ? "该终端正被使用（发送冲突）" : e.message); }
				finally { setBusy(false); }
			};
			const active = terms.find((t) => t.terminal_id === activeId) || null;

			const doSend = () => {
				const text = input.trim();
				if (!text || !active) return;
				act(async () => { await rpc("send", { sessionId, id: active.terminal_id, text }); setInput(""); });
			};
			const doSignal = (sig) => { if (active) act(() => rpc("signal", { sessionId, id: active.terminal_id, signal: sig })); };
			const doKill = () => { if (active) act(() => rpc("kill", { sessionId, id: active.terminal_id })); };
			const doNew = () => act(async () => { const r = await rpc("spawn", { sessionId, name: "新终端", cwd: "/" }); setActiveId(r.terminal_id); });

			if (!open) {
				return el("button", {
					className: "wterm-bar",
					title: "打开终端面板",
					onClick: () => setOpen(true)
				},
					el("span", {}, "▸ 终端"),
					el("span", {}, terms.length > 0 ? `（${terms.length} 个终端${terms.some(t => t.mine) ? " · 本会话 ★" : ""}）` : "（无终端）")
				);
			}

			return el("div", { className: "wterm-dock" },
				el("div", { className: "wterm-head" },
					el("span", { className: "wterm-title" }, "终端" + (active ? " · " + active.name : "")),
					el("span", {}, active ? (active.status === "running" ? "运行中" : active.status) + (active.mine ? " · 本会话" : "") : "无终端"),
					el("span", { style: { flex: 1 } }),
					el("button", { className: "wterm-btn", onClick: () => setOpen(false) }, "收起"),
					el("span", { className: "wterm-note" }, "独立终端，与会话无关；命令结束会通知使用它的会话")
				),
				el("div", { className: "wterm-tabs" },
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
								onClick: (e) => { e.stopPropagation(); act(() => rpc("kill", { sessionId, id: t.terminal_id })); }
							}, "×")
						)
					),
					el("button", { className: "wterm-add", title: "新建终端", onClick: doNew }, "+")
				),
				el("div", { className: "wterm-out" },
					output.length > 0 ? output : el("span", { className: "wterm-empty" }, active ? "（无输出。agent 或你在本终端执行命令后显示）" : "（暂无终端，点 + 新建）")
				),
				el("div", { className: "wterm-row" },
					el("input", {
						className: "wterm-input",
						value: input,
						placeholder: "输入命令发送到当前终端（Enter 发送，执行结束会通知 agent）",
						onChange: (e) => setInput(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") doSend(); },
						disabled: busy || !active
					}),
					el("button", { className: "wterm-btn primary", disabled: busy || !active || !input.trim(), onClick: doSend }, "发送"),
					el("button", { className: "wterm-btn", disabled: busy || !active, onClick: () => doSignal("SIGINT") }, "中断"),
					el("button", { className: "wterm-btn danger", disabled: busy || !active, onClick: () => doSignal("SIGKILL") }, "强杀")
				),
				error ? el("div", { className: "wterm-note", style: { color: "var(--dsw-alias-state-error-primary)" } }, "⚠ " + error) : null
			);
		}

		function apply(ctx) {
			const style = document.createElement("style");
			style.textContent = CSS;
			document.head.appendChild(style);

			const slots = ctx.get("slots");
			if (slots === undefined) return;

			slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "web-terminal", order: 30 },
				(props) => React.createElement(TerminalPanel, props)
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
