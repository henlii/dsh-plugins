window.__ModuleLoader__.load({
	id: "dsh-web-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const CSS = [
			".wterm-dock{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;flex-direction:column;gap:8px;padding:10px 12px;display:flex;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
			".wterm-head{align-items:center;gap:10px;display:flex;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".wterm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}",
			".wterm-dot.running{background:var(--dsw-alias-state-success-primary)}",
			".wterm-dot.idle{background:var(--dsw-alias-state-warn-primary)}",
			".wterm-dot.exited{background:var(--dsw-alias-state-error-primary)}",
			".wterm-title{font-weight:600;color:var(--dsw-alias-label-primary)}",
			".wterm-out{box-sizing:border-box;height:180px;overflow:auto;background:var(--dsw-alias-bg-layer-0,#0d0f13);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);flex:none}",
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
			".wterm-toggle{box-sizing:border-box;height:28px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:12px;line-height:18px;font-family:inherit}",
			".wterm-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".wterm-toggle.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}"
		].join("");

		// ── module-level panel-open store (shared by toggle + dock) ─────────
		let panelOpen = false;
		const listeners = new Set();
		function setPanelOpen(v) {
			if (panelOpen === v) return;
			panelOpen = v;
			listeners.forEach((l) => l());
		}
		function usePanelOpen() {
			const [open, setOpen] = React.useState(panelOpen);
			React.useEffect(() => {
				listeners.add(setOpen);
				return () => listeners.delete(setOpen);
			}, []);
			return open;
		}

		// ── RPC ─────────────────────────────────────────────────────────────
		const rpc = async (method, args) => {
			const res = await fetch(`/api/dsh-web-terminal/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(args ?? {})
			});
			let data = {};
			try { data = await res.json(); } catch { /* non-json */ }
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			if (data.ok === false) throw Object.assign(new Error(data.error || "rpc failed"), { code: data.code });
			return data;
		};

		function TerminalPanel(props) {
			const el = React.createElement;
			const sessionId = props.sessionId;
			const [sessions, setSessions] = React.useState([]);
			const [output, setOutput] = React.useState("");
			const [input, setInput] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [status, setStatus] = React.useState("idle");

			React.useEffect(() => {
				if (!sessionId) return;
				let alive = true;
				let timer = null;
				const tick = async () => {
					try {
						const snap = await rpc("snapshot", { sessionId });
						if (!alive) return;
						setSessions(snap.sessions || []);
						if (snap.sessions && snap.sessions.length > 0) {
							const s = snap.sessions[0];
							setStatus(s.status);
							const page = await rpc("read", { sessionId, id: s.sessionId, count: 500 });
							if (alive) setOutput(page.text || "");
						} else {
							setStatus("idle");
							setOutput("");
						}
					} catch (e) {
						if (alive) { setError(e.message); setStatus("error"); }
					}
				};
				tick();
				timer = setInterval(tick, 1000);
				return () => { alive = false; if (timer) clearInterval(timer); };
			}, [sessionId]);

			const act = async (fn) => {
				if (busy) return;
				setBusy(true); setError(null);
				try { await fn(); } catch (e) { setError(e.code === "SEND_ACTIVE" ? "agent 正在使用该终端（发送冲突）" : e.message); }
				finally { setBusy(false); }
			};

			const doSend = () => {
				const text = input.trim();
				if (!text) return;
				const id = sessions.length > 0 ? sessions[0].sessionId : "";
				act(async () => {
					await rpc("send", { sessionId, id, text });
					setInput("");
				});
			};
			const doSignal = (sig) => {
				const id = sessions.length > 0 ? sessions[0].sessionId : "";
				act(() => rpc("signal", { sessionId, id, signal: sig }));
			};
			const doKill = () => {
				const id = sessions.length > 0 ? sessions[0].sessionId : "";
				act(() => rpc("kill", { sessionId, id }));
			};
			const doSpawn = () => act(() => rpc("spawn", { sessionId }));

			const dot = status === "running" ? "running" : status === "exited" ? "exited" : "idle";
			return el("div", { className: "wterm-dock" },
				el("div", { className: "wterm-head" },
					el("span", { className: "wterm-dot " + dot }),
					el("span", { className: "wterm-title" }, "Agent 持久终端"),
					el("span", {}, "shell: " + (sessions.length > 0 ? sessions[0].sessionId : "未启动")),
					el("span", {}, "状态: " + status),
					sessions.length === 0
						? el("button", { className: "wterm-btn primary", disabled: busy, onClick: doSpawn }, "启动 shell")
						: el("button", { className: "wterm-btn", disabled: busy, onClick: () => { setSessions([]); setOutput(""); } }, "刷新")
				),
				el("div", { className: "wterm-out" },
					output.length > 0
						? output
						: el("span", { className: "wterm-empty" }, status === "running" ? "（运行中，无输出…）" : "（无输出。agent 执行 bash 命令或点击「启动 shell」后会显示）")
				),
				el("div", { className: "wterm-row" },
					el("input", {
						className: "wterm-input",
						value: input,
						placeholder: "输入命令发送到 agent 的 shell（Enter 发送，agent 会看到通知）",
						onChange: (e) => setInput(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") doSend(); },
						disabled: busy
					}),
					el("button", { className: "wterm-btn primary", disabled: busy || !input.trim(), onClick: doSend }, "发送"),
					el("button", { className: "wterm-btn", disabled: busy, onClick: () => doSignal("SIGINT") }, "中断"),
					el("button", { className: "wterm-btn danger", disabled: busy, onClick: () => doSignal("SIGKILL") }, "强杀"),
					el("button", { className: "wterm-btn danger", disabled: busy, onClick: doKill }, "关闭")
				),
				error ? el("div", { className: "wterm-note", style: { color: "var(--dsw-alias-state-error-primary)" } }, "⚠ " + error) : null,
				el("div", { className: "wterm-note" }, "你在终端里的发送/中断会以通知形式注入会话，agent 下一轮即可看到。")
			);
		}

		function TerminalToggle(props) {
			const el = React.createElement;
			const open = usePanelOpen();
			return el("button", {
				className: "wterm-toggle" + (open ? " on" : ""),
				title: "打开/关闭 agent 持久终端面板",
				onClick: () => setPanelOpen(!open)
			}, open ? "终端 ▾" : "终端");
		}

		function apply(ctx) {
			const style = document.createElement("style");
			style.textContent = CSS;
			document.head.appendChild(style);

			const slots = ctx.get("slots");
			if (slots === undefined) return;

			slots.inject("conversation.session.header.utilities", () => slots.register(
				{ name: "conversation.session.header.utilities", id: "web-terminal", order: 30 },
				(props) => React.createElement(TerminalToggle, props)
			));

			slots.inject("conversation.input.dock", () => slots.register(
				{ name: "conversation.input.dock", id: "web-terminal", order: 30 },
				(props) => {
					const open = usePanelOpen();
					if (!open) return null;
					return React.createElement(TerminalPanel, props);
				}
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
