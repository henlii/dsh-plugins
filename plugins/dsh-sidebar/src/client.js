// dsh-sidebar client half — 按 pidance 侧边栏重做的右侧工作区面板。
//
// 视觉与交互对齐 pidance 的 Chamber Native 侧边栏规范：
//   - 44px 常驻图标轨道 + 内容面板，行高 28/30px、6px 圆角、整行选中；
//   - 明暗主题令牌（body[data-ds-dark-theme]），状态色不单独承担语义；
//   - 文件树 / Git 更改 / 会话信息 / 终端四页签，文件与 Git 行可直接打开二级视图。
// 数据仍来自宿主半区暴露的 /api/dsh-sidebar/* 路由。
window.__ModuleLoader__.load({
	id: "dsh-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");
		var reactDom = require("react-dom");

		const name = "dsh-sidebar-client";
		const inject = ["slots", "layout"];
		const el = react.createElement;
		const Fragment = react.Fragment;

		// ── 主题令牌（pidance chamber-native 明暗两套）────────────────────────
		const SIDEBAR_CSS = `
[data-dsh-sidebar-root]{
  --dsh-sb-bg:#fdfcfa;
  --dsh-sb-panel:#f7f6f4;
  --dsh-sb-elevated:#ffffff;
  --dsh-sb-hover:#0000000d;
  --dsh-sb-selected:#b350172b;
  --dsh-sb-subtle:#f4f3f1;
  --dsh-sb-border:#e5e1de;
  --dsh-sb-border-strong:#cbc7c2;
  --dsh-sb-text:#393a34;
  --dsh-sb-muted:#5c5c54;
  --dsh-sb-dim:#797970;
  --dsh-sb-accent:#b35017;
  --dsh-sb-accent-hover:#9a4310;
  --dsh-sb-accent-strong:#9a4310;
  --dsh-sb-on-accent:#ffffff;
  --dsh-sb-running:#b35017;
  --dsh-sb-unread:#2d72c4;
  --dsh-sb-success:#5f8d3d;
  --dsh-sb-warning:#8d6c15;
  --dsh-sb-danger:#b7493f;
  --dsh-sb-code:#f4f3f1;
  --dsh-sb-rail:#f4f3f1;
  --dsh-sb-mono:ui-monospace,"Cascadia Code","SFMono-Regular",Consolas,Menlo,monospace;
  color-scheme:light;
}
body[data-ds-dark-theme] [data-dsh-sidebar-root]{
  --dsh-sb-bg:#120f0e;
  --dsh-sb-panel:#171615;
  --dsh-sb-elevated:#1c1a18;
  --dsh-sb-hover:#ffffff12;
  --dsh-sb-selected:#b9a5992b;
  --dsh-sb-subtle:#171616;
  --dsh-sb-border:#242323;
  --dsh-sb-border-strong:#504e4c;
  --dsh-sb-text:#c9c5ba;
  --dsh-sb-muted:#8f8b81;
  --dsh-sb-dim:#77736b;
  --dsh-sb-accent:#da7c47;
  --dsh-sb-accent-hover:#eb8c57;
  --dsh-sb-accent-strong:#eb8c57;
  --dsh-sb-on-accent:#120f0e;
  --dsh-sb-running:#da7c47;
  --dsh-sb-unread:#479fe6;
  --dsh-sb-success:#76ad4f;
  --dsh-sb-warning:#c67f13;
  --dsh-sb-danger:#da5b4a;
  --dsh-sb-code:#0e0c0b;
  --dsh-sb-rail:#141211;
  color-scheme:dark;
}
[data-dsh-sidebar-root],[data-dsh-sidebar-root] *,[data-dsh-sidebar-root] *::before,[data-dsh-sidebar-root] *::after{box-sizing:border-box}
[data-dsh-sidebar-root]{height:100%;position:relative;overflow:hidden;background:var(--dsh-sb-panel);color:var(--dsh-sb-text);font-size:12.5px;line-height:1.4}
[data-dsh-sidebar-root] button{font:inherit;color:inherit}
.dsh-sb-body{height:100%;min-width:0;display:flex;flex-direction:column;overflow:hidden;padding-right:44px;animation:dsh-sb-reveal .18s ease both;contain:layout style}
.dsh-sb-header{height:44px;flex:none;display:flex;align-items:center;gap:6px;padding:0 7px 0 10px;border-bottom:1px solid var(--dsh-sb-border);background:var(--dsh-sb-panel)}
.dsh-sb-header-title{min-width:0;flex:1;display:flex;align-items:baseline;gap:8px;overflow:hidden}
.dsh-sb-header-title>strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsh-sb-text)}
.dsh-sb-header-title>span{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsh-sb-dim);font-family:var(--dsh-sb-mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.dsh-sb-header-actions{flex:none;display:flex;align-items:center;gap:2px}
.dsh-sb-icon-btn{display:inline-flex;width:24px;height:24px;flex:none;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsh-sb-muted);cursor:pointer;transition:background .12s,color .12s}
.dsh-sb-icon-btn:hover:not(:disabled){background:var(--dsh-sb-hover);color:var(--dsh-sb-text)}
.dsh-sb-icon-btn:active:not(:disabled){background:var(--dsh-sb-selected)}
.dsh-sb-icon-btn:focus-visible{outline:2px solid var(--dsh-sb-accent);outline-offset:-2px}
.dsh-sb-icon-btn:disabled{color:var(--dsh-sb-dim);cursor:default}
.dsh-sb-icon-btn[data-active="true"],.dsh-sb-icon-btn[data-active="true"]:hover:not(:disabled){background:var(--dsh-sb-selected);color:var(--dsh-sb-accent-strong)}
.dsh-sb-scroll{min-height:0;flex:1;overflow-x:hidden;overflow-y:auto;padding:3px 0 10px}
.dsh-sb-row{display:flex;width:auto;height:28px;margin:1px 6px;padding:0 8px;align-items:center;gap:7px;border:0;border-radius:6px;background:transparent;color:var(--dsh-sb-muted);text-align:left;cursor:pointer;transition:background .1s,color .1s;content-visibility:auto;contain-intrinsic-size:auto 28px}
.dsh-sb-row:hover{background:var(--dsh-sb-hover);color:var(--dsh-sb-text)}
.dsh-sb-row[data-active="true"],.dsh-sb-row[data-active="true"]:hover{background:var(--dsh-sb-selected);color:var(--dsh-sb-accent-strong)}
.dsh-sb-row:focus-visible{outline:2px solid var(--dsh-sb-accent);outline-offset:-2px}
.dsh-sb-row:disabled{cursor:default;color:var(--dsh-sb-dim)}
.dsh-sb-row-icon{display:inline-flex;width:16px;height:16px;flex:none;align-items:center;justify-content:center;color:var(--dsh-sb-dim)}
.dsh-sb-row-icon svg{display:block}
.dsh-sb-row[data-active="true"] .dsh-sb-row-icon{color:inherit}
.dsh-sb-row-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.dsh-sb-row-meta{flex:none;color:var(--dsh-sb-dim);font-family:var(--dsh-sb-mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.dsh-sb-chevron{display:inline-flex;width:16px;height:16px;flex:none;align-items:center;justify-content:center;color:var(--dsh-sb-dim);transition:transform .12s ease}
.dsh-sb-status-code{flex:none;display:inline-flex;min-width:14px;height:14px;align-items:center;justify-content:center;border:0;font-family:var(--dsh-sb-mono);font-size:10.5px;font-weight:700;line-height:1;opacity:.95}
.dsh-sb-dot{width:6px;height:6px;flex:none;border-radius:50%;background:currentColor}
.dsh-sb-summary{padding:5px 14px 7px;color:var(--dsh-sb-dim);font-size:10.5px;line-height:1.45;overflow-wrap:anywhere}
.dsh-sb-empty{display:flex;min-height:120px;align-items:center;justify-content:center;padding:18px 16px;color:var(--dsh-sb-dim);font-size:11.5px;line-height:1.6;text-align:center}
.dsh-sb-card{margin:8px 12px;border:1px solid var(--dsh-sb-border);border-radius:9px;background:var(--dsh-sb-elevated);overflow:hidden}
.dsh-sb-card-title{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--dsh-sb-border);color:var(--dsh-sb-text);font-size:11px;font-weight:700}
.dsh-sb-card-body{padding:8px 10px;color:var(--dsh-sb-muted);font-size:11.5px;line-height:1.65}
.dsh-sb-info-grid{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:12px;row-gap:5px}
.dsh-sb-info-grid>dt{margin:0;color:var(--dsh-sb-dim);white-space:nowrap}
.dsh-sb-info-grid>dd{margin:0;min-width:0;color:var(--dsh-sb-text);text-align:right;overflow-wrap:anywhere;font-family:var(--dsh-sb-mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.dsh-sb-meter{height:6px;border-radius:999px;background:var(--dsh-sb-subtle);overflow:hidden}
.dsh-sb-meter>div{height:100%;border-radius:inherit;background:var(--dsh-sb-accent);transition:width .18s ease}
.dsh-sb-meter[data-level="warn"]>div{background:var(--dsh-sb-warning)}
.dsh-sb-meter[data-level="danger"]>div{background:var(--dsh-sb-danger)}
.dsh-sb-context-line{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:6px}
.dsh-sb-context-line>strong{color:var(--dsh-sb-text);font-size:11.5px;font-weight:700}
.dsh-sb-context-line>span{color:var(--dsh-sb-dim);font-family:var(--dsh-sb-mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.dsh-sb-breakdown{margin-top:6px;color:var(--dsh-sb-dim);font-size:10.5px;line-height:1.5}
.dsh-sb-diff{min-height:0;flex:1;overflow:auto;margin:0;padding:8px 0;background:var(--dsh-sb-code);color:var(--dsh-sb-text);font-family:var(--dsh-sb-mono);font-size:12px;line-height:1.55}
.dsh-sb-diff-line{padding:0 10px;white-space:pre-wrap;word-break:break-all}
.dsh-sb-diff-add{background:color-mix(in srgb,var(--dsh-sb-success) 16%,transparent)}
.dsh-sb-diff-del{background:color-mix(in srgb,var(--dsh-sb-danger) 14%,transparent)}
.dsh-sb-diff-hunk{color:var(--dsh-sb-accent-strong)}
.dsh-sb-editor{display:flex;min-height:0;flex:1;flex-direction:column;background:var(--dsh-sb-code)}
.dsh-sb-editor textarea{min-height:0;flex:1;box-sizing:border-box;width:100%;padding:10px 12px;border:0;resize:none;outline:none;background:transparent;color:var(--dsh-sb-text);font-family:var(--dsh-sb-mono);font-size:12.5px;line-height:1.6;tab-size:2}
.dsh-sb-editor-footer{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px;padding:8px 10px;border-top:1px solid var(--dsh-sb-border);background:var(--dsh-sb-panel)}
.dsh-sb-action-btn{height:26px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--dsh-sb-muted);font-size:11.5px;cursor:pointer;transition:background .12s,color .12s,opacity .12s}
.dsh-sb-action-btn:hover{background:var(--dsh-sb-hover);color:var(--dsh-sb-text)}
.dsh-sb-action-btn:focus-visible{outline:2px solid var(--dsh-sb-accent);outline-offset:-2px}
.dsh-sb-action-btn[data-kind="primary"]{background:var(--dsh-sb-accent);color:var(--dsh-sb-on-accent)}
.dsh-sb-action-btn[data-kind="primary"]:hover:not(:disabled){background:var(--dsh-sb-accent-hover)}
.dsh-sb-action-btn:disabled{opacity:.55;cursor:default}
.dsh-sb-error-banner{margin:0 12px 8px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--dsh-sb-danger) 45%,var(--dsh-sb-border));border-radius:6px;background:color-mix(in srgb,var(--dsh-sb-danger) 9%,var(--dsh-sb-panel));color:var(--dsh-sb-danger);font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.dsh-sb-rail{position:fixed;top:0;right:0;bottom:0;width:44px;z-index:30;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0;background:var(--dsh-sb-rail);border-left:1px solid var(--dsh-sb-border)}
.dsh-sb-rail-btn{display:inline-flex;width:34px;height:34px;flex:none;align-items:center;justify-content:center;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsh-sb-muted);cursor:pointer;position:relative;transition:background .12s,color .12s,border-color .12s}
.dsh-sb-rail-btn:hover{background:var(--dsh-sb-hover);color:var(--dsh-sb-text)}
.dsh-sb-rail-btn:focus-visible{outline:2px solid var(--dsh-sb-accent);outline-offset:2px}
.dsh-sb-rail-btn[data-active="true"],.dsh-sb-rail-btn[data-active="true"]:hover{background:var(--dsh-sb-selected);color:var(--dsh-sb-accent-strong);border-color:color-mix(in srgb,var(--dsh-sb-accent) 35%,var(--dsh-sb-border))}
.dsh-sb-rail-badge{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsh-sb-accent);box-shadow:0 0 0 2px var(--dsh-sb-rail)}
.dsh-sb-terminal{display:flex;min-height:0;flex:1;flex-direction:column;outline:none;background:var(--dsh-sb-bg)}
.dsh-sb-terminal-status{flex:none;padding:4px 10px;border-bottom:1px solid var(--dsh-sb-border);color:var(--dsh-sb-dim);font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sb-terminal-surface{min-height:0;flex:1;overflow:auto;padding:6px 8px 8px;color:var(--dsh-sb-text);font-family:var(--dsh-sb-mono);font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-all;cursor:text}
.dsh-sb-terminal-empty{color:var(--dsh-sb-dim)}
.dsh-sb-terminal-error{margin-bottom:6px;color:var(--dsh-sb-danger)}
.dsh-sb-terminal-caret{display:inline-block;width:7px;height:14px;margin-left:1px;background:var(--dsh-sb-accent);vertical-align:text-bottom;animation:dsh-sb-blink 1.05s steps(1) infinite}
.dsh-sb-terminal-chrome{flex:none;border-top:1px solid var(--dsh-sb-border);background:var(--dsh-sb-bg)}
.dsh-sb-terminal-chips{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:6px 8px;-webkit-overflow-scrolling:touch}
.dsh-sb-terminal-chip{flex:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--dsh-sb-border);border-radius:6px;background:var(--dsh-sb-panel);color:var(--dsh-sb-text);font-size:12px;white-space:nowrap;cursor:pointer}
.dsh-sb-terminal-chip:hover{background:var(--dsh-sb-hover)}
.dsh-sb-terminal-chip:focus-visible{outline:2px solid var(--dsh-sb-accent);outline-offset:1px}
.dsh-sb-terminal-chip:disabled{opacity:.55;cursor:default}
.dsh-sb-terminal-chip[data-active="true"]{background:var(--dsh-sb-selected);color:var(--dsh-sb-accent-strong);border-color:color-mix(in srgb,var(--dsh-sb-accent) 35%,var(--dsh-sb-border))}
.dsh-sb-terminal-chip[data-kind="icon"]{width:30px;padding:0;justify-content:center;color:var(--dsh-sb-muted)}
.dsh-sb-terminal-chip-x{display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsh-sb-dim);cursor:pointer}
.dsh-sb-terminal-chip-x:hover{background:var(--dsh-sb-hover);color:var(--dsh-sb-text)}
@media (hover:none),(pointer:coarse){.dsh-sb-terminal-chip{height:36px;min-width:38px;font-size:13px}.dsh-sb-terminal-chip[data-kind="icon"]{width:36px}}
.dsh-sb-file-row{position:relative}
.dsh-sb-row-actions{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:1px;opacity:0;pointer-events:none;transition:opacity .12s}
.dsh-sb-file-row:hover .dsh-sb-row-actions,.dsh-sb-file-row:focus-within .dsh-sb-row-actions{opacity:1;pointer-events:auto}
.dsh-sb-row-action{display:inline-flex;width:22px;height:22px;flex:none;align-items:center;justify-content:center;padding:0;border:0;border-radius:5px;background:var(--dsh-sb-panel);color:var(--dsh-sb-dim);cursor:pointer}
.dsh-sb-row-action:hover{background:var(--dsh-sb-hover);color:var(--dsh-sb-text)}
.dsh-sb-row-action:focus-visible{outline:2px solid var(--dsh-sb-accent);outline-offset:-2px}
.dsh-sb-row-action[data-active="true"]{background:var(--dsh-sb-selected);color:var(--dsh-sb-accent-strong)}
@media (hover:none), (pointer:coarse){.dsh-sb-row-actions{opacity:1;pointer-events:auto}}
.dsh-sb-draft{display:flex;align-items:center;gap:6px;height:26px;margin:1px 6px;padding:0 8px}
.dsh-sb-draft input{min-width:0;flex:1;height:22px;padding:0 7px;border:1px solid var(--dsh-sb-accent);border-radius:5px;background:var(--dsh-sb-elevated);color:var(--dsh-sb-text);font-size:12px;outline:none}
.dsh-sb-draft .dsh-sb-row-action{background:transparent}
.dsh-sb-menu{position:fixed;z-index:640;min-width:180px;padding:4px;border:1px solid var(--dsh-sb-border-strong);border-radius:8px;background:var(--dsh-sb-elevated);box-shadow:0 10px 30px rgba(0,0,0,.18);color:var(--dsh-sb-text)}
.dsh-sb-menu button{display:flex;width:100%;height:28px;align-items:center;gap:8px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:var(--dsh-sb-muted);font-size:12px;text-align:left;cursor:pointer}
.dsh-sb-menu button:hover{background:var(--dsh-sb-hover);color:var(--dsh-sb-text)}
.dsh-sb-menu button[data-danger="true"]{color:var(--dsh-sb-danger)}
.dsh-sb-menu button[data-danger="true"]:hover{background:color-mix(in srgb,var(--dsh-sb-danger) 12%,transparent)}
.dsh-sb-menu-sep{height:1px;margin:3px 6px;background:var(--dsh-sb-border)}
.dsh-sb-overlay{position:fixed;inset:0;z-index:620;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.32)}
.dsh-sb-dialog{width:min(440px,100%);max-height:min(560px,80vh);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsh-sb-border-strong);border-radius:10px;background:var(--dsh-sb-elevated);box-shadow:var(--dsh-sb-shadow,0 18px 50px rgba(0,0,0,.24))}
.dsh-sb-dialog-header{display:flex;height:40px;flex:none;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--dsh-sb-border)}
.dsh-sb-dialog-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}
.dsh-sb-dialog-body{min-height:0;flex:1;overflow:auto;padding:6px}
.dsh-sb-dialog-footer{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px;padding:8px 10px;border-top:1px solid var(--dsh-sb-border)}
.dsh-sb-config{padding:8px 10px;border-bottom:1px solid var(--dsh-sb-border);background:var(--dsh-sb-panel)}
.dsh-sb-config-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 12px}
.dsh-sb-config label{display:flex;min-width:0;align-items:center;gap:6px;color:var(--dsh-sb-dim);font-size:10.5px}
.dsh-sb-config input[type="number"],.dsh-sb-config input[type="text"]{width:76px;height:21px;padding:0 5px;border:1px solid var(--dsh-sb-border);border-radius:5px;background:var(--dsh-sb-bg);color:var(--dsh-sb-text);font-size:10.5px;outline:none}
.dsh-sb-config input[type="checkbox"]{accent-color:var(--dsh-sb-accent)}
.dsh-sb-config-actions{display:flex;align-items:center;gap:6px;margin-top:7px}
.dsh-sb-config-hint{margin-left:4px;color:var(--dsh-sb-dim);font-size:10px}
.dsh-sb-upload{border-bottom:1px solid var(--dsh-sb-border);padding:7px 10px}
.dsh-sb-upload-row{display:flex;align-items:center;gap:8px;min-height:20px;color:var(--dsh-sb-muted);font-size:11px}
.dsh-sb-upload-progress{height:3px;margin-top:4px;overflow:hidden;border-radius:2px;background:var(--dsh-sb-border)}
.dsh-sb-upload-progress>div{height:100%;background:var(--dsh-sb-muted);transition:width .12s ease}
.dsh-sb-upload-conflict{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--dsh-sb-warning) 50%,var(--dsh-sb-border));background:color-mix(in srgb,var(--dsh-sb-warning) 8%,var(--dsh-sb-panel));color:var(--dsh-sb-warning);font-size:11px;line-height:1.4}
.dsh-sb-upload-conflict button{height:22px;padding:0 8px;border:1px solid var(--dsh-sb-border);border-radius:5px;background:transparent;color:var(--dsh-sb-text);font-size:10.5px;cursor:pointer}
.dsh-sb-upload-conflict button[data-primary="true"]{border-color:var(--dsh-sb-danger);color:var(--dsh-sb-danger)}

@keyframes dsh-sb-blink{50%{opacity:0}}
@keyframes dsh-sb-reveal{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  .dsh-sb-body{animation:none}
  .dsh-sb-chevron,.dsh-sb-meter>div,.dsh-sb-row,.dsh-sb-icon-btn,.dsh-sb-rail-btn,.dsh-sb-action-btn{transition:none}
}
html[data-dsh-mobile] .dsh-sb-body{animation:none}
html[data-dsh-mobile] .dsh-sb-rail-btn,html[data-dsh-mobile] .dsh-sb-row,html[data-dsh-mobile] .dsh-sb-icon-btn{touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  .dsh-sb-terminal-caret{animation:none}
}
@media (max-width:639.98px){
  html[data-dsh-mobile][data-dsh-mobile-pane="workspace"] .dsh-sb-body{padding-right:0}
  html[data-dsh-mobile][data-dsh-mobile-pane="workspace"] .dsh-sb-header{height:40px}
}
`;

		const T = {
			bg: "var(--dsh-sb-bg)",
			panel: "var(--dsh-sb-panel)",
			elevated: "var(--dsh-sb-elevated)",
			hover: "var(--dsh-sb-hover)",
			selected: "var(--dsh-sb-selected)",
			subtle: "var(--dsh-sb-subtle)",
			border: "var(--dsh-sb-border)",
			borderStrong: "var(--dsh-sb-border-strong)",
			text: "var(--dsh-sb-text)",
			muted: "var(--dsh-sb-muted)",
			dim: "var(--dsh-sb-dim)",
			accent: "var(--dsh-sb-accent)",
			accentHover: "var(--dsh-sb-accent-hover)",
			accentStrong: "var(--dsh-sb-accent-strong)",
			onAccent: "var(--dsh-sb-on-accent)",
			running: "var(--dsh-sb-running)",
			unread: "var(--dsh-sb-unread)",
			success: "var(--dsh-sb-success)",
			warning: "var(--dsh-sb-warning)",
			danger: "var(--dsh-sb-danger)",
			code: "var(--dsh-sb-code)",
			rail: "var(--dsh-sb-rail)",
			mono: "var(--dsh-sb-mono)"
		};

		// ── 图标 ─────────────────────────────────────────────────────────────
		// svg() 必须收 rest 参数：之前只把第一个 child 交给 <svg>，
		// Git / 信息 / 终端等多 path 图标就只剩一个空文件轮廓。
		function Icon({ kind, size }) {
			const common = {
				width: size || 16,
				height: size || 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			};
			const svg = (...children) => el("svg", common, ...children);
			if (kind === "files") return svg(el("path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }));
			// GitBranch：不用 FileDiff。三个轨道项都是文件轮廓时一眼不分得清。
			if (kind === "git") return svg(
				el("line", { x1: 6, x2: 6, y1: 3, y2: 15 }),
				el("circle", { cx: 18, cy: 6, r: 3 }),
				el("circle", { cx: 6, cy: 18, r: 3 }),
				el("path", { d: "M18 9a9 9 0 0 1-9 9" }));
			if (kind === "info") return svg(
				el("circle", { cx: 12, cy: 12, r: 10 }),
				el("path", { d: "M12 16v-4" }),
				el("path", { d: "M12 8h.01" }));
			if (kind === "terminal") return svg(
				el("rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }),
				el("path", { d: "m7 11 2-2-2-2" }),
				el("path", { d: "M11 13h4" }));
			if (kind === "refresh") return svg(el("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }), el("path", { d: "M3 3v5h5" }));
			if (kind === "back") return svg(el("path", { d: "m12 19-7-7 7-7" }), el("path", { d: "M19 12H5" }));
			if (kind === "save") return svg(
				el("path", { d: "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" }),
				el("path", { d: "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" }),
				el("path", { d: "M7 3v4a1 1 0 0 0 1 1h7" }));
			if (kind === "close") return svg(el("path", { d: "M18 6 6 18" }), el("path", { d: "m6 6 12 12" }));
			if (kind === "chevron") return svg(el("path", { d: "m6 9 6 6 6-6" }));
			if (kind === "chevronRight") return svg(el("path", { d: "m9 18 6-6-6-6" }));
			if (kind === "check") return svg(el("path", { d: "M20 6 9 17l-5-5" }));
			if (kind === "alert") return svg(
				el("circle", { cx: 12, cy: 12, r: 10 }),
				el("line", { x1: 12, x2: 12, y1: 8, y2: 12 }),
				el("line", { x1: 12, x2: 12.01, y1: 16, y2: 16 }));
			if (kind === "upload") return svg(el("path", { d: "M12 16V4" }), el("path", { d: "m7 9 5-5 5 5" }), el("path", { d: "M5 20h14" }));
			if (kind === "newFile") return svg(el("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }), el("path", { d: "M14 2v6h6" }), el("path", { d: "M12 18v-6" }), el("path", { d: "M9 15h6" }));
			if (kind === "newFolder") return svg(el("path", { d: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }), el("path", { d: "M12 11v6" }), el("path", { d: "M9 14h6" }));
			if (kind === "config") return svg(el("circle", { cx: 12, cy: 12, r: 3 }), el("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" }));
			if (kind === "more") return svg(el("circle", { cx: 12, cy: 5, r: 1 }), el("circle", { cx: 12, cy: 12, r: 1 }), el("circle", { cx: 12, cy: 19, r: 1 }));
			if (kind === "copy") return svg(
				el("rect", { x: 8, y: 8, width: 14, height: 14, rx: 2 }),
				el("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }));
			if (kind === "trash") return svg(
				el("path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }),
				el("path", { d: "M3 6h18" }),
				el("path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }));
			if (kind === "rename") return svg(
				el("path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }),
				el("path", { d: "m15 5 4 4" }));
			if (kind === "move") return svg(
				el("path", { d: "M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" }),
				el("path", { d: "M2 13h10" }),
				el("path", { d: "m9 16 3-3-3-3" }));
			return null;
		}

		function FolderGlyph({ open, size }) {
			const s = size || 16;
			if (open) {
				return el("svg", { width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
					el("path", { d: "M1 4.5A1 1 0 0 1 2 3.5H5.5L7 5h7.5v1H1V4.5Z", fill: "currentColor", opacity: 0.65 }),
					el("path", { d: "M1 6h14.5L14 13H2L1 6Z", stroke: "currentColor", strokeWidth: 1, fill: "currentColor", fillOpacity: 0.12 }));
			}
			return el("svg", { width: s, height: s, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				el("path", {
					d: "M1 4.5A1 1 0 0 1 2 3.5H5.5L7 5H14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4.5Z",
					stroke: "currentColor",
					strokeWidth: 1,
					fill: "currentColor",
					fillOpacity: 0.1
				}));
		}

		function fileKind(name) {
			const lower = String(name || "").toLowerCase();
			const base = lower.split("/").pop() || lower;
			const ext = base.includes(".") ? base.split(".").pop() : "";
			if (base === "dockerfile" || base.startsWith("dockerfile.")) return "docker";
			if (base === ".env" || base.startsWith(".env.")) return "env";
			if (base === ".gitignore" || base === ".gitattributes" || base === ".gitmodules") return "gitfile";
			if (base === "package-lock.json" || base === "yarn.lock" || base === "bun.lock" || base === "pnpm-lock.yaml" || base === "cargo.lock" || ext === "lock") return "lock";
			if (base.endsWith(".config.ts") || base.endsWith(".config.js") || base.endsWith(".config.mjs") || base.endsWith(".config.cjs")) return "config";
			if (["ts", "tsx", "js", "mjs", "cjs", "jsx", "py", "rs", "go", "java", "c", "h", "cpp", "cc", "cs"].includes(ext)) return "code";
			if (["json", "jsonl", "yaml", "yml", "toml", "xml", "sql", "graphql", "gql", "tf", "hcl"].includes(ext)) return "data";
			if (["md", "mdx", "txt", "rst", "pdf", "docx"].includes(ext)) return "doc";
			if (["css", "scss", "less"].includes(ext)) return "style";
			if (["html", "htm", "svg", "vue", "svelte"].includes(ext)) return "markup";
			if (["sh", "bash", "zsh", "fish", "ps1"].includes(ext)) return "shell";
			return "file";
		}

		/** 16px 类型符号，不用纸张+3px 字。字标在这个尺寸会糊成噪点。 */
		function FileGlyph({ name, size }) {
			const s = size || 16;
			const kind = fileKind(name);
			const svg = (...children) => el("svg", {
				width: s,
				height: s,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, ...children);
			if (kind === "code") return svg(
				el("path", { d: "M6.2 3.5 2.8 8l3.4 4.5" }),
				el("path", { d: "M9.8 3.5 13.2 8l-3.4 4.5" }),
				el("path", { d: "M8.8 2.8 7.2 13.2" }));
			if (kind === "data") return svg(
				el("path", { d: "M6 3.4c-1.8 0-2.6 1.1-2.6 2.6v4c0 1.5.8 2.6 2.6 2.6" }),
				el("path", { d: "M10 3.4c1.8 0 2.6 1.1 2.6 2.6v4c0 1.5-.8 2.6-2.6 2.6" }));
			if (kind === "doc") return svg(
				el("path", { d: "M4 2.5h5.5L12.5 5.5V13.5H4V2.5Z" }),
				el("path", { d: "M9.5 2.5V5.5H12.5" }),
				el("path", { d: "M6 8h4.2" }),
				el("path", { d: "M6 10.2h4.2" }),
				el("path", { d: "M6 12.2h2.6" }));
			if (kind === "style") return svg(
				el("path", { d: "M6.4 3.2 5.2 12.8" }),
				el("path", { d: "M10.8 3.2 9.6 12.8" }),
				el("path", { d: "M3.6 6.2h9.2" }),
				el("path", { d: "M3.2 9.8h9.2" }));
			if (kind === "markup") return svg(
				el("path", { d: "M6 4 3 8l3 4" }),
				el("path", { d: "M10 4l3 4-3 4" }));
			if (kind === "shell") return svg(
				el("path", { d: "M3.5 5.2 7 8l-3.5 2.8" }),
				el("path", { d: "M8.2 11.6H13" }));
			if (kind === "lock") return svg(
				el("rect", { x: 4, y: 7.2, width: 8, height: 6.2, rx: 1.2 }),
				el("path", { d: "M5.6 7.2V5.4a2.4 2.4 0 0 1 4.8 0v1.8" }));
			if (kind === "gitfile") return svg(
				el("circle", { cx: 5, cy: 4.2, r: 1.6 }),
				el("circle", { cx: 11, cy: 4.2, r: 1.6 }),
				el("circle", { cx: 5, cy: 11.8, r: 1.6 }),
				el("path", { d: "M5 5.8v4.4" }),
				el("path", { d: "M11 5.8v1.4a3.2 3.2 0 0 1-3.2 3.2H6.6" }));
			if (kind === "config") return svg(
				el("circle", { cx: 8, cy: 8, r: 2.1 }),
				el("path", { d: "M8 2.8v1.6M8 11.6v1.6M2.8 8h1.6M11.6 8h1.6M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M4.1 11.9l1.1-1.1M10.8 5.2l1.1-1.1" }));
			if (kind === "docker") return svg(
				el("rect", { x: 3.2, y: 6.2, width: 3.2, height: 2.4, rx: 0.4 }),
				el("rect", { x: 6.8, y: 6.2, width: 3.2, height: 2.4, rx: 0.4 }),
				el("rect", { x: 3.2, y: 9.2, width: 3.2, height: 2.4, rx: 0.4 }),
				el("rect", { x: 6.8, y: 9.2, width: 6, height: 2.4, rx: 0.4 }));
			if (kind === "env") return svg(
				el("circle", { cx: 6, cy: 8, r: 2.2 }),
				el("path", { d: "M8.1 8H13M11.2 8v2.2" }));
			return svg(
				el("path", { d: "M4 2.4h5.6L12.6 5.6V13.6H4V2.4Z" }),
				el("path", { d: "M9.6 2.4V5.6H12.6" }));
		}

		// ── 终端面板（嵌在右侧栏的「终端」tab 里）────────────────────────────
		const wtRpc = async (method, args) => {
			const res = await fetch(`/api/dsh-web-terminal/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(args ?? {})
			});
			let data = {};
			try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			if (data.ok === false) throw new Error(data.error || "rpc failed");
			return data;
		};

		function stripAnsi(value) {
			return String(value || "")
				.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
				.replace(/\u001b\][^\u0007]*\u0007/g, "")
				.replace(/\r(?!\n)/g, "\n");
		}

		function SidebarTerminal({ sessionId, cwd }) {
			const [terms, setTerms] = react.useState([]);
			const [activeId, setActiveId] = react.useState(null);
			const [output, setOutput] = react.useState("");
			const [line, setLine] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [lastSent, setLastSent] = react.useState(null);
			const [lastRc, setLastRc] = react.useState(null);
			const outRef = react.useRef(null);
			const rootRef = react.useRef(null);

			react.useEffect(() => {
				if (!sessionId) return;
				let alive = true;
				let timer = null;
				const tick = async () => {
					if (document.hidden) return;
					try {
						const snap = await wtRpc("snapshot", { sessionId });
						if (!alive) return;
						const next = snap.terminals || [];
						setError(null);
						setTerms((cur) => {
							if (cur.length === next.length && cur.every((t, i) => t.terminal_id === next[i].terminal_id && t.mine === next[i].mine)) return cur;
							return next;
						});
						setActiveId((cur) => {
							if (cur && next.some((t) => t.terminal_id === cur)) return cur;
							const mine = next.find((t) => t.mine);
							return (mine || next[0] || {}).terminal_id || null;
						});
					} catch (e) { if (alive) setError(e.message); }
				};
				tick();
				timer = setInterval(tick, 2000);
				document.addEventListener("visibilitychange", tick);
				return () => { alive = false; if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
			}, [sessionId]);

			react.useEffect(() => {
				if (!activeId || !sessionId) return;
				let alive = true;
				let timer = null;
				const read = async () => {
					if (document.hidden) return;
					try {
						const page = await wtRpc("read", { sessionId, id: activeId, count: 600 });
						if (!alive) return;
						const text = page.text || "";
						setError(null);
						setOutput((cur) => (cur === text ? cur : text));
					} catch (e) {
						if (!alive) return;
						const msg = e && e.message ? String(e.message) : "";
						if (/no such terminal|unknown PTY session/i.test(msg)) { setError(null); return; }
						setError(msg);
					}
				};
				read();
				timer = setInterval(read, 2000);
				document.addEventListener("visibilitychange", read);
				return () => { alive = false; if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", read); };
			}, [activeId, sessionId]);

			react.useEffect(() => {
				if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
			}, [output, line]);

			react.useEffect(() => {
				if (rootRef.current) rootRef.current.focus();
			}, [sessionId]);

			const active = terms.find((t) => t.terminal_id === activeId) || null;
			const sendLine = (text) => {
				const t = text.trim();
				if (!t || !active || busy) return;
				setBusy(true); setError(null); setLastSent(t.slice(0, 24));
				wtRpc("send", { sessionId, id: active.terminal_id, text: t })
					.then((r) => {
						if (r && r.terminal_id) setActiveId(r.terminal_id);
						setLastRc(r && r.exitCode != null ? r.exitCode : null);
					})
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
				wtRpc("spawn", { sessionId, name: "终端", cwd: cwd || (active && active.cwd) || "/" }).then((r) => setActiveId(r.terminal_id)).catch((e) => setError(e.message));
			};
			const killTab = (id) => {
				setError(null);
				wtRpc("kill", { sessionId, id }).catch((e) => setError(e.message));
			};
			const handleKey = (e) => {
				if (e.nativeEvent && e.nativeEvent.isComposing) return;
				if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); interrupt(); return; }
				if (e.key === "Enter") { e.preventDefault(); sendLine(line); setLine(""); return; }
				if (e.key === "Backspace") { e.preventDefault(); setLine((l) => l.slice(0, -1)); return; }
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					setLine((l) => l + e.key);
				}
			};
			const handlePaste = (e) => {
				const text = e.clipboardData && e.clipboardData.getData("text");
				if (!text) return;
				e.preventDefault();
				setLine((l) => l + text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
			};

			const statusBits = [];
			if (error) statusBits.push(error);
			else if (!active) statusBits.push("未连接");
			else if (busy) statusBits.push("运行中");
			else statusBits.push("已连接");
			const shownCwd = (active && active.cwd) || cwd;
			if (shownCwd) statusBits.push(shownCwd);
			if (lastSent && !error) statusBits.push(`已发送 ${lastSent}`);
			if (lastRc !== null && !busy && !error) statusBits.push(`退出码 ${lastRc}`);

			const chip = (key, props, ...children) => el("button", {
				key,
				type: "button",
				className: "dsh-sb-terminal-chip",
				...props
			}, ...children);

			const visible = stripAnsi(output);
			return el("div", {
				ref: rootRef,
				className: "dsh-sb-terminal",
				tabIndex: 0,
				onKeyDown: handleKey,
				onPaste: handlePaste,
				onClick: (e) => {
					const hit = e.target && e.target.closest ? e.target : null;
					if (hit && hit.closest(".dsh-sb-terminal-chrome")) return;
					if (rootRef.current) rootRef.current.focus();
				}
			},
				el("div", { className: "dsh-sb-terminal-status" }, statusBits.join(" · ")),
				el("div", { ref: outRef, className: "dsh-sb-terminal-surface" },
					error ? el("div", { className: "dsh-sb-terminal-error" }, error) : null,
					visible.length > 0 ? visible : (!active ? el("span", { className: "dsh-sb-terminal-empty" }, "点 + 新建终端") : null),
					active ? el("span", {}, line, el("span", { className: "dsh-sb-terminal-caret", "aria-hidden": true })) : null),
				el("div", { className: "dsh-sb-terminal-chrome" },
					el("div", { className: "dsh-sb-terminal-chips", role: "tablist", "aria-label": "终端" },
						terms.map((t) => chip(t.terminal_id, {
							role: "tab",
							"aria-selected": t.terminal_id === activeId,
							"data-active": t.terminal_id === activeId ? "true" : void 0,
							title: t.cwd || t.name,
							onClick: () => setActiveId(t.terminal_id)
						}, t.name, el("span", {
							className: "dsh-sb-terminal-chip-x",
							role: "button",
							"aria-label": `关闭 ${t.name}`,
							onClick: (e) => { e.stopPropagation(); killTab(t.terminal_id); }
						}, el(Icon, { kind: "close", size: 11 })))),
						chip("new", { "data-kind": "icon", "aria-label": "新建终端", title: "新建终端", onClick: doNew }, "+"),
						chip("ctrl-c", { onClick: interrupt, disabled: !active, title: "中断" }, "Ctrl-C")))
			);
		}

		// ── 统计格式化（对齐会话区的 StatsLine/ContextMeter 口径）────────────
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

		// ── Git 状态语义（与 pidance GitPanel 相同的排序/颜色/文字）──────────
		const GIT_RANK = { conflict: 0, modified: 1, added: 2, deleted: 3, renamed: 4, untracked: 5 };
		const GIT_LABELS = {
			conflict: "冲突",
			modified: "已修改",
			added: "新增",
			deleted: "已删除",
			renamed: "重命名",
			untracked: "未跟踪"
		};
		function gitChangeKind(change) {
			const index = change.index;
			const worktree = change.worktree;
			const pair = `${index}${worktree}`;
			if (index === "U" || worktree === "U" || pair === "DD" || pair === "AA" || pair === "UU") return "conflict";
			if (index === "?" || worktree === "?") return "untracked";
			if (index === "A" || worktree === "A") return "added";
			if (index === "D" || worktree === "D") return "deleted";
			if (index === "R" || index === "C") return "renamed";
			return "modified";
		}
		function gitChangeCode(change) {
			if (change.index === "?" || change.worktree === "?") return "??";
			if (change.index === "R" || change.index === "C") return change.index;
			if (change.index !== " ") return change.index;
			return change.worktree;
		}
		function gitChangeColor(kind) {
			if (kind === "conflict") return T.danger;
			if (kind === "added") return T.success;
			if (kind === "deleted") return T.danger;
			if (kind === "renamed") return T.unread;
			if (kind === "untracked") return T.muted;
			return T.warning;
		}
		function sortedChanges(changes) {
			if (!Array.isArray(changes)) return [];
			return [...changes].sort((a, b) => {
				const rank = GIT_RANK[gitChangeKind(a)] - GIT_RANK[gitChangeKind(b)];
				return rank !== 0 ? rank : String(a.path || "").localeCompare(String(b.path || ""));
			});
		}
		function GitCodeBadge({ change }) {
			const kind = gitChangeKind(change);
			return el("span", {
				className: "dsh-sb-status-code",
				"aria-label": GIT_LABELS[kind],
				title: GIT_LABELS[kind],
				style: { color: gitChangeColor(kind) }
			}, gitChangeCode(change));
		}

		// ── 通用小件 ────────────────────────────────────────────────────────
		function ToolbarButton({ kind, label, onClick, active, disabled }) {
			return el("button", {
				type: "button",
				className: "dsh-sb-icon-btn",
				"aria-label": label,
				title: label,
				"data-active": active ? "true" : void 0,
				disabled,
				onClick
			}, el(Icon, { kind, size: 15 }));
		}

		function PanelHeader({ title, meta, back, actions }) {
			return el("div", { className: "dsh-sb-header" },
				back ? ToolbarButton({ kind: "back", label: "返回", onClick: back }) : null,
				el("div", { className: "dsh-sb-header-title" },
					el("strong", { title: title }, title),
					meta ? el("span", { title: meta }, meta) : null),
				actions ? el("div", { className: "dsh-sb-header-actions" }, actions) : null);
		}

		function EmptyState({ text }) {
			return el("div", { className: "dsh-sb-empty" }, text);
		}

		function ErrorBanner({ text }) {
			if (!text) return null;
			return el("div", { className: "dsh-sb-error-banner", role: "alert" }, text);
		}

		// ── 文件操作 RPC 与本地配置 ─────────────────────────────────────────
		const FILE_CONFIG_KEY = "dsh-sidebar.file-config.v1";
		const DEFAULT_FILE_CONFIG = {
			showHidden: false,
			maxDepth: 5,
			maxEntries: 1200,
			skipDirs: ["node_modules", ".git", ".next", ".venv", "__pycache__", ".cache", "dist", "build", ".turbo", ".output", ".pnpm"]
		};
		function loadFileConfig() {
			try {
				const raw = JSON.parse(localStorage.getItem(FILE_CONFIG_KEY) || "null");
				if (raw === null || typeof raw !== "object") return DEFAULT_FILE_CONFIG;
				return {
					showHidden: raw.showHidden === true,
					maxDepth: Math.min(10, Math.max(1, Math.round(Number(raw.maxDepth) || DEFAULT_FILE_CONFIG.maxDepth))),
					maxEntries: Math.min(5000, Math.max(10, Math.round(Number(raw.maxEntries) || DEFAULT_FILE_CONFIG.maxEntries))),
					skipDirs: Array.isArray(raw.skipDirs)
						? raw.skipDirs.filter((item) => typeof item === "string" && item.length > 0).slice(0, 60)
						: DEFAULT_FILE_CONFIG.skipDirs
				};
			} catch {
				return DEFAULT_FILE_CONFIG;
			}
		}
		function saveFileConfig(config) {
			try { localStorage.setItem(FILE_CONFIG_KEY, JSON.stringify(config)); } catch { /* 存储不可用时保持会话内配置 */ }
		}
		async function fileRpc(method, body) {
			const res = await fetch(`/api/dsh-sidebar/${method}`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const json = await res.json().catch(() => ({}));
			if (res.status === 409) {
				const conflictError = new Error(json.error || `HTTP ${res.status}`);
				conflictError.status = res.status;
				conflictError.data = json;
				throw conflictError;
			}
			if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
			return json;
		}
		async function copyText(value) {
			try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
		}
		function fileToBase64(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = reader.result;
					if (typeof result === "string") {
						const comma = result.indexOf(",");
						resolve(comma === -1 ? result : result.slice(comma + 1));
					} else {
						const bytes = new Uint8Array(result);
						let binary = "";
						for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
						resolve(btoa(binary));
					}
				};
				reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
				reader.readAsDataURL(file);
			});
		}
		function changedDirectoryPaths(changeMap, cwd) {
			const dirs = new Set();
			const norm = String(cwd || "").replace(/\\/g, "/").replace(/\/$/, "");
			for (const filePath of changeMap.keys()) {
				const normalized = String(filePath).replace(/\\/g, "/");
				let dir = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
				while (dir !== "" && dir !== norm) {
					dirs.add(dir);
					const next = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
					if (next === dir) break;
					dir = next;
				}
			}
			return dirs;
		}

		function NameDraftRow({ defaultValue, placeholder, paddingLeft, onSubmit, onCancel }) {
			const [value, setValue] = react.useState(defaultValue || "");
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const inputRef = react.useRef(null);
			react.useEffect(() => {
				if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
			}, []);
			const submit = async () => {
				const name = value.trim();
				if (!name || busy) return;
				setBusy(true);
				setError(null);
				try { await onSubmit(name); } catch (submitError) {
					setError(submitError instanceof Error ? submitError.message : String(submitError));
					setBusy(false);
				}
			};
			return el("div", { className: "dsh-sb-draft", style: { paddingLeft } },
				el("input", {
					ref: inputRef,
					value,
					placeholder,
					"aria-label": placeholder,
					disabled: busy,
					onChange: (event) => setValue(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter") { event.preventDefault(); void submit(); }
						else if (event.key === "Escape") { event.preventDefault(); onCancel(); }
					},
					onBlur: () => { if (!busy) onCancel(); }
				}),
				error ? el("span", { style: { color: T.danger, fontSize: 10, flex: "none", maxWidth: "42%", overflow: "hidden", textOverflow: "ellipsis" } }, error) : null);
		}

		function RowMenu({ state, onClose, onAction }) {
			react.useEffect(() => {
				if (state === null) return;
				const close = (event) => {
					if (event.type === "keydown" && event.key === "Escape") { onClose(); return; }
					if (event.type === "pointerdown") {
						const target = event.target;
						if (target instanceof Node && target.closest(".dsh-sb-menu")) return;
						onClose();
					}
				};
				document.addEventListener("keydown", close, true);
				document.addEventListener("pointerdown", close, true);
				window.addEventListener("scroll", onClose, true);
				return () => {
					document.removeEventListener("keydown", close, true);
					document.removeEventListener("pointerdown", close, true);
					window.removeEventListener("scroll", onClose, true);
				};
			}, [state, onClose]);
			if (state === null) return null;
			const item = (label, action, icon, danger) => el("button", {
				key: label,
				type: "button",
				role: "menuitem",
				"data-danger": danger ? "true" : void 0,
				onClick: (event) => { event.stopPropagation(); onClose(); onAction(action); }
			}, el("span", { style: { display: "inline-flex" } }, el(Icon, { kind: icon, size: 14 })), label);
			const top = Math.max(8, Math.min(state.y + 4, window.innerHeight - 240));
			const left = Math.max(8, Math.min(state.x, window.innerWidth - 190));
			const children = [];
			if (state.node.type === "dir") {
				children.push(item("新建文件", "new-file", "newFile"));
				children.push(item("新建文件夹", "new-folder", "newFolder"));
				children.push(el("div", { key: "sep1", className: "dsh-sb-menu-sep" }));
			}
			children.push(item("复制路径", "copy-path", "copy"));
			children.push(item("重命名", "rename", "rename"));
			children.push(item("移动…", "move", "move"));
			children.push(item("复制…", "copy", "copy"));
			children.push(el("div", { key: "sep2", className: "dsh-sb-menu-sep" }));
			children.push(item("删除", "delete", "trash", true));
			return reactDom.createPortal(el("div", {
				className: "dsh-sb-menu",
				role: "menu",
				"aria-label": "文件操作",
				style: { top, left },
				onClick: (event) => event.stopPropagation()
			}, children), document.body);
		}

		function DirectoryPicker({ state, files, cwd, onClose, onSelect }) {
			const [selected, setSelected] = react.useState(cwd || ".");
			const [openDirs, setOpenDirs] = react.useState(() => new Set());
			react.useEffect(() => {
				const close = (event) => { if (event.key === "Escape") onClose(); };
				document.addEventListener("keydown", close);
				return () => document.removeEventListener("keydown", close);
			}, [onClose]);
			const renderDirs = (nodes, depth) => nodes.filter((node) => node.type === "dir").map((node) => {
				const open = openDirs.has(node.path);
				const active = selected === node.path;
				return el("div", { key: node.path },
					el("button", {
						type: "button",
						className: "dsh-sb-row",
						"data-active": active ? "true" : void 0,
						style: { paddingLeft: 10 + depth * 14 },
						onClick: () => { setSelected(node.path); if (!open) setOpenDirs((prev) => new Set(prev).add(node.path)); }
					},
						el("span", { className: "dsh-sb-chevron", style: { transform: open ? "none" : "rotate(-90deg)" }, "aria-hidden": true }, el(Icon, { kind: "chevron", size: 12 })),
						el("span", { className: "dsh-sb-row-icon" }, el(FolderGlyph, { open, size: 16 })),
						el("span", { className: "dsh-sb-row-name" }, node.name)),
					open ? renderDirs(node.children, depth + 1) : null);
			});
			const title = state.mode === "upload" ? "选择上传目录" : state.mode === "move" ? "移动到…" : "复制到…";
			const dialog = el("div", { className: "dsh-sb-overlay", role: "presentation", onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
				el("div", { className: "dsh-sb-dialog", role: "dialog", "aria-modal": true, "aria-label": title },
					el("div", { className: "dsh-sb-dialog-header" },
						el("div", { className: "dsh-sb-dialog-title" }, title),
						ToolbarButton({ kind: "close", label: "关闭", onClick: onClose })),
					el("div", { className: "dsh-sb-dialog-body", role: "tree", "aria-label": "目录" },
						el("button", {
							type: "button",
							className: "dsh-sb-row",
							"data-active": selected === "." ? "true" : void 0,
							style: { paddingLeft: 10 },
							onClick: () => setSelected(".")
						},
							el("span", { className: "dsh-sb-row-icon" }, el(FolderGlyph, { open: true, size: 16 })),
							el("span", { className: "dsh-sb-row-name" }, "（项目根目录）")),
						renderDirs(files, 0)),
					el("div", { className: "dsh-sb-dialog-footer" },
						el("button", { type: "button", className: "dsh-sb-action-btn", onClick: onClose }, "取消"),
						el("button", { type: "button", className: "dsh-sb-action-btn", "data-kind": "primary", onClick: () => onSelect(selected) }, "选择此目录"))));
			return reactDom.createPortal(dialog, document.body);
		}

		// ── 文件树（pidance FileExplorer 语义：行内新建/重命名、菜单、拖拽移动）──
		function FileTree({ files, changeMap, expandedPaths, onToggleDir, openFile, edit, selectedPath, cwd, onOpenMenu, onCreate, onRename, onMoveDrop, resetKey, draftRequest, dirtyPaths }) {
			const [draft, setDraft] = react.useState(null);
			const changedDirs = react.useMemo(() => changedDirectoryPaths(changeMap, cwd), [changeMap, cwd]);
			react.useEffect(() => { setDraft(null); }, [resetKey]);
			react.useEffect(() => {
				if (draftRequest !== null) setDraft({ kind: draftRequest.kind, path: draftRequest.path });
			}, [draftRequest]);
			const finishDraft = () => setDraft(null);
			const renderTree = (nodes, depth) => {
				if (!nodes || nodes.length === 0) return el("div", { className: "dsh-sb-empty", style: { minHeight: 60 } }, "（空目录）");
				return nodes.map((node) => {
					const indent = { paddingLeft: 8 + depth * 14 };
					if (node.type === "dir") {
						const open = expandedPaths.has(node.path);
						const renameHere = draft !== null && draft.kind === "rename" && draft.path === node.path;
						const createHere = draft !== null && draft.path === node.path && (draft.kind === "create-file" || draft.kind === "create-dir");
						return el("div", { key: node.path, role: "none" },
							renameHere
								? el(NameDraftRow, {
									defaultValue: node.name,
									placeholder: "名称",
									paddingLeft: 8 + depth * 14 + 2,
									onSubmit: async (name) => { await onRename(node.path, name); finishDraft(); },
									onCancel: finishDraft
								})
								: el("div", {
									className: "dsh-sb-row dsh-sb-file-row",
									role: "treeitem",
									tabIndex: 0,
									"aria-expanded": open,
									draggable: true,
									style: indent,
									title: node.path,
									onClick: () => onToggleDir(node.path),
									onKeyDown: (event) => {
										if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
											event.preventDefault();
											onToggleDir(node.path);
										}
									},
									onDragStart: (event) => {
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData("text/plain", node.path);
									},
									onDragOver: (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; },
									onDrop: (event) => {
										event.preventDefault();
										const source = event.dataTransfer.getData("text/plain");
										if (source && source !== node.path) onMoveDrop(source, node.path);
									}
								},
									el("span", { className: "dsh-sb-chevron", style: { transform: open ? "none" : "rotate(-90deg)" }, "aria-hidden": true }, el(Icon, { kind: "chevronRight", size: 11 })),
									el("span", { className: "dsh-sb-row-icon" }, el(FolderGlyph, { open, size: 16 })),
									el("span", { className: "dsh-sb-row-name" }, node.name),
									changedDirs.has(node.path) ? el("span", { className: "dsh-sb-dot", title: "目录内有 Git 变更", "aria-label": "目录内有 Git 变更", style: { color: T.warning } }) : null,
									el("span", { className: "dsh-sb-row-actions", onClick: (event) => event.stopPropagation() },
										el("button", {
											type: "button",
											className: "dsh-sb-row-action",
											"aria-label": `操作 ${node.name}`,
											title: "更多操作",
											onClick: (event) => onOpenMenu(node, event)
										}, el(Icon, { kind: "more", size: 15 })))),
							createHere ? el(NameDraftRow, {
								defaultValue: "",
								placeholder: draft.kind === "create-file" ? "新文件名" : "新文件夹名",
								paddingLeft: 8 + (depth + 1) * 14 + 2,
								onSubmit: async (name) => { await onCreate(node.path, name, draft.kind); finishDraft(); },
								onCancel: finishDraft
							}) : null,
							open ? renderTree(node.children, depth + 1) : null);
					}
					const change = changeMap.get(node.path);
					const active = selectedPath === node.path || (edit !== null && edit.path === node.path);
					const renameHere = draft !== null && draft.kind === "rename" && draft.path === node.path;
					return el("div", { key: node.path, role: "none" },
						renameHere
							? el(NameDraftRow, {
								defaultValue: node.name,
								placeholder: "名称",
								paddingLeft: 8 + depth * 14 + 18,
								onSubmit: async (name) => { await onRename(node.path, name); finishDraft(); },
								onCancel: finishDraft
							})
							: el("div", {
								className: "dsh-sb-row dsh-sb-file-row",
								role: "treeitem",
								tabIndex: 0,
								"data-active": active ? "true" : void 0,
								"aria-current": active ? "true" : void 0,
								draggable: true,
								style: { ...indent, paddingLeft: 8 + depth * 14 + 16, paddingRight: 4 },
								title: node.path,
								onClick: () => void openFile(node.path, "content"),
								onKeyDown: (event) => {
									if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
										event.preventDefault();
										void openFile(node.path, "content");
									}
								},
								onDragStart: (event) => {
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData("text/plain", node.path);
								}
							},
								el("span", { className: "dsh-sb-row-icon" }, el(FileGlyph, { name: node.name, size: 16 })),
								el("span", { className: "dsh-sb-row-name" }, node.name),
								dirtyPaths && dirtyPaths.has(node.path) ? el("span", { className: "dsh-sb-dot", title: "刚刚上传", "aria-label": "刚刚上传", style: { color: T.unread } }) : null,
								change ? el(GitCodeBadge, { change }) : null,
								el("span", { className: "dsh-sb-row-actions", onClick: (event) => event.stopPropagation() },
									el("button", {
										type: "button",
										className: "dsh-sb-row-action",
										"aria-label": `操作 ${node.name}`,
										title: "更多操作",
										onClick: (event) => onOpenMenu(node, event)
									}, el(Icon, { kind: "more", size: 15 })))));
				});
			};
			return el("div", {
				className: "dsh-sb-scroll",
				role: "tree",
				"aria-label": "工作区文件"
			},
				files && files.length > 0
					? renderTree(files, 0)
					: EmptyState({ text: "工作区为空" }));
		}

		// ── Git 更改 ────────────────────────────────────────────────────────
		function GitPanel({ git, rootName, cwd, openFile, selectedPath }) {
			if (!git || !git.isGit) return EmptyState({ text: "当前工作区不是 git 仓库" });
			const changes = sortedChanges(git.changes);
			if (changes.length === 0) {
				return el("div", { className: "dsh-sb-scroll" },
					el("div", { className: "dsh-sb-summary" }, `${git.branch || "无分支"} · ${rootName || cwd || ""}`),
					el("div", { className: "dsh-sb-empty" },
						el("span", { style: { display: "inline-flex", alignItems: "center", gap: 7 } },
							el(Icon, { kind: "check", size: 15 }), "工作区干净")));
			}
			return el("div", { className: "dsh-sb-scroll" },
				el("div", { className: "dsh-sb-summary" },
					`${changes.length} 项更改 · ${git.branch || "无分支"} · ${rootName || cwd || ""}`),
				changes.map((change) => {
					const kind = gitChangeKind(change);
					const active = selectedPath === change.path;
					const displayPath = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
					return el("button", {
						key: change.path,
						type: "button",
						className: "dsh-sb-row",
						"data-active": active ? "true" : void 0,
						"aria-label": `${displayPath} — ${GIT_LABELS[kind]}`,
						title: `${displayPath} — ${GIT_LABELS[kind]}`,
						onClick: () => void openFile(change.path, "diff")
					},
						el(GitCodeBadge, { change }),
						el("span", { className: "dsh-sb-row-icon" }, el(FileGlyph, { name: change.path, size: 16 })),
						el("span", { className: "dsh-sb-row-name" }, displayPath),
						el("span", { className: "dsh-sb-row-meta" }, GIT_LABELS[kind]));
				}));
		}

		// ── 会话信息 ────────────────────────────────────────────────────────
		function InfoPanel({ data, sessionStats, tokenUsage, contextPressure, contextBreakdown }) {
			const context = contextOccupancy(contextPressure);
			const fmtTime = (ms) => {
				if (!ms) return "—";
				try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
			};
			const statsGroups = [];
			if (sessionStats !== void 0 && sessionStats.steps > 0) {
				statsGroups.push(`${String(sessionStats.turns)} 轮 · ${String(sessionStats.steps)} 步`);
				const durations = [];
				if (sessionStats.llmMs > 0) durations.push(`LLM ${formatDuration(sessionStats.llmMs)}`);
				if (sessionStats.toolMs > 0) durations.push(`工具调用 ${formatDuration(sessionStats.toolMs)}`);
				const speeds = [];
				if (sessionStats.ttftSteps > 0) speeds.push(`首 token 平均 ${formatDuration(sessionStats.ttftMs / sessionStats.ttftSteps)}`);
				if (sessionStats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(sessionStats.decodeTokens / (sessionStats.decodeMs / 1e3))} tok/s`);
				if (durations.length > 0) statsGroups.push(durations.join(" · "));
				if (speeds.length > 0) statsGroups.push(speeds.join(" · "));
			}
			if (tokenUsage !== void 0 && (billedInputTokens(tokenUsage) > 0 || tokenUsage.outputTokens > 0)) {
				const hit = cacheHitPercent(tokenUsage);
				if (hit !== null) statsGroups.push(`缓存命中 ${String(hit)}%`);
				statsGroups.push(`输入 ${formatTokens(billedInputTokens(tokenUsage))} tok · 输出 ${formatTokens(tokenUsage.outputTokens)} tok`);
			}

			const infoRows = [
				["工作区", data.rootName || "—"],
				["路径", data.cwd || "—"],
				["会话 ID", data.sessionId || "—"],
				["Agent 预设", data.session && data.session.agentPreset ? data.session.agentPreset : "—"],
				["创建时间", fmtTime(data.session ? data.session.createdAt : null)],
				["Git", data.git && data.git.isGit ? (data.git.branch || "无分支") : "非 git 仓库"]
			];
			const meterLevel = context === null ? null : context.percent >= 90 ? "danger" : context.percent >= 75 ? "warn" : "normal";
			const meterLabel = context === null
				? "暂未取得上下文用量"
				: `上下文已用 ${String(context.percent)}% ~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`;

			return el("div", { className: "dsh-sb-scroll", style: { padding: "10px 0 16px" } },
				context !== null && el("section", { className: "dsh-sb-card" },
					el("div", { className: "dsh-sb-card-title" }, "上下文用量"),
					el("div", { className: "dsh-sb-card-body" },
						el("div", { className: "dsh-sb-context-line" },
							el("strong", {}, `${String(context.percent)}%`),
							el("span", {}, `~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`)),
						el("div", {
							className: "dsh-sb-meter",
							"data-level": meterLevel,
							role: "progressbar",
							"aria-label": meterLabel,
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": context.percent
						}, el("div", { style: { width: `${String(context.percent)}%` } })),
						contextBreakdown !== void 0 ? el("div", { className: "dsh-sb-breakdown" },
							`系统提示词 ~${formatTokens(contextBreakdown.systemTokens)} · 工具 ~${formatTokens(contextBreakdown.toolsTokens)} · 对话消息 ~${formatTokens(contextBreakdown.messageTokens)}`) : null)),
				statsGroups.length > 0 && el("section", { className: "dsh-sb-card" },
					el("div", { className: "dsh-sb-card-title" }, "本次会话"),
					el("div", { className: "dsh-sb-card-body" },
						statsGroups.map((group, index) => el("div", { key: index, style: { marginBottom: index === statsGroups.length - 1 ? 0 : 4 } }, group)))),
				el("section", { className: "dsh-sb-card" },
					el("div", { className: "dsh-sb-card-title" }, "会话信息"),
					el("dl", { className: "dsh-sb-card-body dsh-sb-info-grid" },
						infoRows.map(([label, value]) => [
							el("dt", { key: `t-${label}` }, label),
							el("dd", { key: `v-${label}`, title: String(value) }, String(value))
						]))));
		}

		// ── 二级编辑器 / diff 视图 ─────────────────────────────────────────
		function EditorPanel({ edit, draft, diffText, diffMeta, truncated, saving, editError, onChange, onSave, onBack }) {
			const isDiff = edit.mode === "diff";
			const onKeyDown = (event) => {
				if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
					event.preventDefault();
					if (!isDiff && !saving) onSave();
				}
			};
			return el("div", { style: { minHeight: 0, flex: 1, display: "flex", flexDirection: "column" } },
				PanelHeader({
					title: edit.path,
					back: onBack,
					actions: isDiff ? null : ToolbarButton({ kind: "save", label: "保存 (Ctrl+S)", onClick: onSave, disabled: saving })
				}),
				ErrorBanner({ text: editError }),
				isDiff
					? el("div", { className: "dsh-sb-diff", role: "region", "aria-label": "Git diff" },
						diffMeta && diffMeta.untracked
							? el("div", { className: "dsh-sb-diff-line", style: { color: T.warning } }, "未跟踪文件（无 git diff，显示内容预览）")
							: null,
						diffText === "" && !diffMeta ? el("div", { className: "dsh-sb-diff-line", style: { color: T.dim } }, "加载中…")
							: String(diffText || "").split("\n").map((line, index) => {
								const cls = line.startsWith("+") ? "dsh-sb-diff-add" : line.startsWith("-") ? "dsh-sb-diff-del" : line.startsWith("@@") ? "dsh-sb-diff-hunk" : "";
								return el("div", { key: index, className: `dsh-sb-diff-line${cls ? ` ${cls}` : ""}` }, line.length === 0 ? "\u00a0" : line);
							}))
					: el(Fragment, null,
						el("div", { className: "dsh-sb-editor" },
							truncated ? el("div", { className: "dsh-sb-error-banner", style: { color: T.warning } }, "文件较大，仅载入前 512 KB") : null,
							el("textarea", {
								value: draft,
								onChange: (event) => onChange(event.target.value),
								onKeyDown,
								spellCheck: false,
								"aria-label": `编辑 ${edit.path}`
							})),
						el("div", { className: "dsh-sb-editor-footer" },
							el("button", { type: "button", className: "dsh-sb-action-btn", onClick: onBack }, "取消"),
							el("button", {
								type: "button",
								className: "dsh-sb-action-btn",
								"data-kind": "primary",
								disabled: saving,
								onClick: onSave
							}, saving ? "保存中…" : "保存"))));
		}

		// ── 工作区面板主体 ──────────────────────────────────────────────────
		function FileConfigPanel({ draft, onChange, onSave, onCancel }) {
			return el("div", { className: "dsh-sb-config" },
				el("div", { className: "dsh-sb-config-grid" },
					el("label", {},
						el("input", { type: "checkbox", checked: draft.showHidden, onChange: (event) => onChange({ ...draft, showHidden: event.target.checked }) }),
						"显示隐藏文件"),
					el("label", {},
						"最大深度",
						el("input", {
							type: "number",
							min: 1,
							max: 10,
							value: draft.maxDepth,
							onChange: (event) => {
								const value = Math.min(10, Math.max(1, Math.round(Number(event.target.value) || 1)));
								onChange({ ...draft, maxDepth: value });
							}
						})),
					el("label", {},
						"最大条目数",
						el("input", {
							type: "number",
							min: 10,
							max: 5000,
							value: draft.maxEntries,
							onChange: (event) => {
								const value = Math.min(5000, Math.max(10, Math.round(Number(event.target.value) || 10)));
								onChange({ ...draft, maxEntries: value });
							}
						})),
					el("label", { style: { gridColumn: "1 / -1", flexDirection: "column", alignItems: "flex-start", gap: 4 } },
						"忽略目录（逗号分隔）",
						el("input", {
							type: "text",
							style: { width: "100%" },
							value: draft.skipDirsText || "",
							onChange: (event) => onChange({ ...draft, skipDirsText: event.target.value })
						}))),
				el("div", { className: "dsh-sb-config-actions" },
					el("button", { type: "button", className: "dsh-sb-action-btn", "data-kind": "primary", onClick: onSave }, "保存"),
					el("button", { type: "button", className: "dsh-sb-action-btn", onClick: onCancel }, "取消"),
					el("span", { className: "dsh-sb-config-hint" }, "配置只影响文件树扫描，保存后立即刷新")));
		}
		function UploadFeedback({ busy, error, summary, conflict, onReplace, onSkip, onCancel, onDismiss, onDismissSummary }) {
			if (!busy && !error && !summary && !conflict) return null;
			return el(Fragment, null,
				busy ? el("div", { className: "dsh-sb-upload", role: "status", "aria-live": "polite" },
					el("div", { className: "dsh-sb-upload-row" },
						el(Icon, { kind: "upload", size: 13 }),
						el("span", {}, "正在读取并上传文件…"))) : null,
				conflict ? el("div", { className: "dsh-sb-upload-conflict", role: "alert" },
					el("div", { style: { minWidth: 0, flex: 1 } },
						el("div", {}, `${String(conflict.conflicts.length + conflict.nonReplaceable.length)} 个文件已存在：${conflict.conflicts.concat(conflict.nonReplaceable).join("、")}`),
						conflict.nonReplaceable.length > 0 ? el("div", { style: { marginTop: 3, opacity: 0.8 } }, `目录不可替换：${conflict.nonReplaceable.join("、")}`) : null),
					el("button", { type: "button", "data-primary": "true", onClick: onReplace }, "覆盖"),
					el("button", { type: "button", onClick: onSkip }, "跳过"),
					el("button", { type: "button", onClick: onCancel }, "取消")) : null,
				error ? el("div", { className: "dsh-sb-error-banner", role: "alert", style: { display: "flex", alignItems: "center", gap: 6 } },
					el("span", { style: { flex: 1 } }, error),
					el("button", { type: "button", className: "dsh-sb-row-action", onClick: onDismiss, "aria-label": "关闭错误" }, el(Icon, { kind: "close", size: 13 }))) : null,
				summary ? el("div", { className: "dsh-sb-upload", "aria-live": "polite" },
					el("div", { className: "dsh-sb-upload-row" },
						el("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, color: T.success } }, el(Icon, { kind: "check", size: 13 }), `已上传 ${String(summary.uploaded.length)}`),
						summary.skipped.length > 0 ? el("span", { style: { color: T.dim } }, `跳过 ${String(summary.skipped.length)}`) : null,
						summary.errors.length > 0 ? el("span", { style: { color: T.danger } }, `失败 ${String(summary.errors.length)}`) : null,
						el("button", { type: "button", className: "dsh-sb-row-action", onClick: onDismissSummary, "aria-label": "关闭上传结果" }, el(Icon, { kind: "close", size: 13 }))),
					summary.errors.map((item) => el("div", { key: item.name, style: { marginTop: 3, color: T.danger, fontSize: 10, overflowWrap: "anywhere" } }, `${item.name}: ${item.error}`))) : null);
		}

		function WorkspacePanel(props) {
			const { sessionId } = props;

			const [tab, setTab] = react.useState("files");
			const [collapsed, setCollapsed] = react.useState(() => {
				const frame = document.querySelector("[class$=\"frame\"]");
				return !frame || frame.hasAttribute("data-details-collapsed");
			});

			// 列宽为 0 时组件仍挂着：跟 frame 的 collapsed 标记走，避免隐形面板扫盘。
			react.useEffect(() => {
				const frame = document.querySelector("[class$=\"frame\"]");
				if (!frame) return;
				const sync = () => {
					setCollapsed(frame.hasAttribute("data-details-collapsed"));
				};
				sync();
				const watch = new MutationObserver(sync);
				watch.observe(frame, { attributes: true, attributeFilter: ["data-details-collapsed"] });
				return () => watch.disconnect();
			}, []);

			// 官方 details 默认 0。挂载和换会话时打开内容面板。
			// 空白会话官方仍把列宽锁成 0。只依赖 sessionId：手动收起后不在同一会话里再撑开。
			react.useEffect(() => {
				setCollapsed(false);
				if (props.layout !== void 0 && typeof props.layout.openDetails === "function") {
					try { props.layout.openDetails(); } catch { /* layout 未接线 */ }
				}
			}, [sessionId]);
			const [data, setData] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [openDirs, setOpenDirs] = react.useState(() => new Set());
			const [edit, setEdit] = react.useState(null);
			const [selectedPath, setSelectedPath] = react.useState(null);
			const [draft, setDraft] = react.useState("");
			const [diffText, setDiffText] = react.useState("");
			const [diffMeta, setDiffMeta] = react.useState(null);
			const [truncated, setTruncated] = react.useState(false);
			const [editError, setEditError] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [fileConfig, setFileConfig] = react.useState(loadFileConfig);
			const [configOpen, setConfigOpen] = react.useState(false);
			const [draftConfig, setDraftConfig] = react.useState(null);
			const [rootDraft, setRootDraft] = react.useState(null);
			const [draftRequest, setDraftRequest] = react.useState(null);
			const [menuState, setMenuState] = react.useState(null);
			const [picker, setPicker] = react.useState(null);
			const [uploadBusy, setUploadBusy] = react.useState(false);
			const [uploadError, setUploadError] = react.useState(null);
			const [uploadSummary, setUploadSummary] = react.useState(null);
			const [pendingConflict, setPendingConflict] = react.useState(null);
			const uploadInputRef = react.useRef(null);
			const uploadTargetRef = react.useRef(".");

			// 会话实时投影（与会话区 StatsLine/ContextMeter 同源）。
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
						body: JSON.stringify({ sessionId, options: fileConfig })
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok || !json.ok) {
						setError(json.error || "加载失败");
						setData(null);
						return;
					}
					setData({ ...json, sessionId });
				} catch {
					setError("无法连接服务器");
					setData(null);
				} finally {
					setLoading(false);
				}
			}, [sessionId, fileConfig]);

			react.useEffect(() => {
				if (collapsed) return;
				void load();
			}, [load, collapsed]);

			// 切换会话后重置瞬时浏览态。
			react.useEffect(() => {
				setOpenDirs(new Set());
				setEdit(null);
				setSelectedPath(null);
				setEditError(null);
				setRootDraft(null);
				setDraftRequest(null);
				setMenuState(null);
				setPicker(null);
				setPendingConflict(null);
				setUploadError(null);
				setUploadSummary(null);
				setUploadBusy(false);
			}, [sessionId]);

			const changeMap = react.useMemo(() => {
				const map = new Map();
				if (data && data.git && Array.isArray(data.git.changes)) {
					for (const change of data.git.changes) map.set(change.path, change);
				}
				return map;
			}, [data]);

			const openFile = react.useCallback(async (path, mode) => {
				setEdit({ path, mode });
				setSelectedPath(path);
				setDraft("");
				setDiffText("");
				setDiffMeta(null);
				setTruncated(false);
				setEditError(null);
				try {
					const res = await fetch(`/api/dsh-sidebar/${mode === "diff" ? "diff" : "read"}`, {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, path })
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok || !json.ok) {
						setEditError(json.error || "读取失败");
						return;
					}
					if (mode === "diff") {
						setDiffMeta({ untracked: !!json.untracked });
						setDiffText(json.untracked ? json.preview || "" : json.diff || "");
					} else {
						setDraft(json.content || "");
						setTruncated(json.truncated === true);
					}
				} catch {
					setEditError("无法连接服务器");
				}
			}, [sessionId]);

			const closeEdit = react.useCallback(() => {
				setEdit(null);
				setSelectedPath(null);
				setEditError(null);
				setSaving(false);
			}, []);

			const save = react.useCallback(async () => {
				if (!edit || edit.mode !== "content") return;
				setSaving(true);
				setEditError(null);
				try {
					const res = await fetch("/api/dsh-sidebar/write", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, path: edit.path, content: draft })
					});
					const json = await res.json().catch(() => ({}));
					if (!res.ok || !json.ok) {
						setEditError(json.error || "保存失败");
						setSaving(false);
						return;
					}
					closeEdit();
					void load();
				} catch {
					setEditError("保存失败：无法连接服务器");
					setSaving(false);
				}
			}, [edit, draft, sessionId, load, closeEdit]);

			const toggleDir = (path) => {
				setOpenDirs((prev) => {
					const next = new Set(prev);
					if (next.has(path)) next.delete(path);
					else next.add(path);
					return next;
				});
			};

			const createEntry = react.useCallback(async (dirPath, name, kind) => {
				const type = kind === "create-dir" ? "dir" : "file";
				const target = dirPath === "." || dirPath === "" ? name : `${dirPath}/${name}`;
				await fileRpc("create", { sessionId, path: target, type });
				await load();
				if (type === "dir") setOpenDirs((prev) => new Set(prev).add(target));
			}, [sessionId, load]);

			const renameEntry = react.useCallback(async (entryPath, newName) => {
				await fileRpc("rename", { sessionId, path: entryPath, newName });
				await load();
			}, [sessionId, load]);

			const moveEntry = react.useCallback(async (entryPath, targetDirectory) => {
				await fileRpc("move", { sessionId, path: entryPath, targetDirectory });
				await load();
			}, [sessionId, load]);

			const copyEntry = react.useCallback(async (entryPath, targetDirectory) => {
				await fileRpc("copy", { sessionId, path: entryPath, targetDirectory });
				await load();
			}, [sessionId, load]);

			const deleteEntry = react.useCallback(async (entryPath, name) => {
				if (!window.confirm(`删除 ${name}？此操作不可撤销。`)) return false;
				try {
					await fileRpc("delete", { sessionId, path: entryPath });
					await load();
					return true;
				} catch (deleteError) {
					setNotice(deleteError instanceof Error ? deleteError.message : String(deleteError));
					return false;
				}
			}, [sessionId, load]);

			const openMenu = react.useCallback((node, event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				setMenuState({ node, x: rect.right - 176, y: rect.bottom });
			}, []);

			const handleMenuAction = react.useCallback(async (action) => {
				const active = menuState;
				setMenuState(null);
				if (active === null) return;
				const node = active.node;
				if (action === "new-file" || action === "new-folder") {
					setDraftRequest({ seq: Date.now(), path: node.path, kind: action === "new-file" ? "create-file" : "create-dir" });
					return;
				}
				if (action === "rename") {
					setDraftRequest({ seq: Date.now(), path: node.path, kind: "rename" });
					return;
				}
				if (action === "copy-path") {
					const ok = await copyText(node.path);
					setNotice(ok ? "路径已复制" : "复制失败");
					return;
				}
				if (action === "move" || action === "copy") {
					const parent = node.type === "dir" ? node.path : (node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ".");
					setPicker({ mode: action, sourcePath: node.path, initialPath: parent });
					return;
				}
				if (action === "delete") await deleteEntry(node.path, node.name);
			}, [menuState, deleteEntry]);

			const confirmPicker = react.useCallback(async (directory) => {
				const active = picker;
				setPicker(null);
				if (active === null) return;
				if (active.mode === "upload") {
					uploadTargetRef.current = directory;
					if (uploadInputRef.current) uploadInputRef.current.click();
					return;
				}
				try {
					if (active.mode === "move") await moveEntry(active.sourcePath, directory);
					else await copyEntry(active.sourcePath, directory);
				} catch (pickerError) {
					setNotice(pickerError instanceof Error ? pickerError.message : String(pickerError));
				}
			}, [picker, moveEntry, copyEntry]);

			const performUpload = react.useCallback(async (files, strategy) => {
				setUploadBusy(true);
				setUploadError(null);
				setPendingConflict(null);
				try {
					const encoded = [];
					for (let index = 0; index < files.length; index += 1) {
						encoded.push({ name: files[index].name, content: await fileToBase64(files[index]) });
					}
					const result = await fileRpc("upload", { sessionId, directory: uploadTargetRef.current, files: encoded, strategy });
					setUploadSummary({ uploaded: result.uploaded || [], skipped: result.skipped || [], errors: result.errors || [] });
					await load();
				} catch (uploadFailure) {
					if (uploadFailure !== null && typeof uploadFailure === "object" && uploadFailure.status === 409 && uploadFailure.data !== void 0) {
						setPendingConflict({ files, conflicts: uploadFailure.data.conflicts || [], nonReplaceable: uploadFailure.data.nonReplaceable || [] });
					} else {
						setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
					}
				} finally {
					setUploadBusy(false);
				}
			}, [sessionId, load]);

			const handleUploadInput = react.useCallback(async (event) => {
				const files = Array.from(event.target.files || []);
				event.target.value = "";
				if (files.length === 0) return;
				if (files.length > 60) { setUploadError("一次最多上传 60 个文件"); return; }
				setUploadSummary(null);
				try {
					const check = await fileRpc("upload-check", { sessionId, directory: uploadTargetRef.current, fileNames: files.map((file) => file.name) });
					if (check.conflicts.length > 0 || check.nonReplaceable.length > 0) {
						setPendingConflict({ files, conflicts: check.conflicts, nonReplaceable: check.nonReplaceable });
						return;
					}
					await performUpload(files, "error");
				} catch (checkError) {
					setUploadError(checkError instanceof Error ? checkError.message : String(checkError));
				}
			}, [sessionId, performUpload]);

			const openUploadPicker = react.useCallback(() => {
				if (uploadBusy || !data) return;
				setPicker({ mode: "upload", sourcePath: null, initialPath: data.cwd || "." });
			}, [uploadBusy, data]);

			const toggleConfig = react.useCallback(() => {
				if (configOpen) {
					setConfigOpen(false);
					setDraftConfig(null);
				} else {
					setDraftConfig({ ...fileConfig, skipDirsText: fileConfig.skipDirs.join(", ") });
					setConfigOpen(true);
				}
			}, [configOpen, fileConfig]);

			const saveConfig = react.useCallback(() => {
				if (draftConfig === null) return;
				const next = {
					showHidden: draftConfig.showHidden === true,
					maxDepth: Math.min(10, Math.max(1, Math.round(Number(draftConfig.maxDepth) || 5))),
					maxEntries: Math.min(5000, Math.max(10, Math.round(Number(draftConfig.maxEntries) || 1200))),
					skipDirs: String(draftConfig.skipDirsText || "").split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 60)
				};
				setFileConfig(next);
				saveFileConfig(next);
				setConfigOpen(false);
				setDraftConfig(null);
			}, [draftConfig]);

			// pidance 式轨道：点其他 tab 切换；再点当前 tab 收起内容面板。
			const selectTab = (nextTab) => {
				if (nextTab === tab && !collapsed) {
					setCollapsed(true);
					if (props.layout !== void 0 && typeof props.layout.closeDetails === "function") {
						try { props.layout.closeDetails(); } catch { /* layout 未接线 */ }
					}
				} else {
					setCollapsed(false);
					setTab(nextTab);
					if (props.layout !== void 0 && typeof props.layout.openDetails === "function") {
						try { props.layout.openDetails(); } catch { /* layout 未接线 */ }
					}
				}
			};

			const gitCount = data && data.git && data.git.isGit && Array.isArray(data.git.changes) ? data.git.changes.length : 0;
			const railItems = [
				{ id: "files", kind: "files", label: "文件" },
				{ id: "git", kind: "git", label: gitCount > 0 ? `Git 更改 ${gitCount > 99 ? "99+" : gitCount}` : "Git 更改" },
				{ id: "info", kind: "info", label: "会话信息" },
				{ id: "terminal", kind: "terminal", label: "终端" }
			];
			const rail = el("nav", {
				className: "dsh-sb-rail",
				"aria-label": "dsh-sidebar 导航"
			},
				railItems.map((item) => el("button", {
					key: item.id,
					type: "button",
					className: "dsh-sb-rail-btn",
					"aria-label": item.label,
					title: item.label,
					"aria-pressed": tab === item.id && !collapsed,
					"data-active": tab === item.id && !collapsed ? "true" : void 0,
					onClick: () => selectTab(item.id)
				},
					el(Icon, { kind: item.kind, size: 17 }),
					item.id === "git" && gitCount > 0 ? el("span", { className: "dsh-sb-rail-badge", "aria-hidden": true }) : null)));

			const toolbarAction = (key, props) => el(Fragment, { key }, ToolbarButton(props));
			const filesActions = [
				toolbarAction("upload", { kind: "upload", label: "上传文件", onClick: openUploadPicker, disabled: !data || uploadBusy }),
				toolbarAction("new-file", { kind: "newFile", label: "新建文件", onClick: () => setRootDraft({ kind: "create-file" }), disabled: !data }),
				toolbarAction("new-folder", { kind: "newFolder", label: "新建文件夹", onClick: () => setRootDraft({ kind: "create-dir" }), disabled: !data }),
				toolbarAction("refresh", { kind: "refresh", label: "刷新文件", onClick: () => void load(), disabled: !data }),
				toolbarAction("config", { kind: "config", label: "文件设置", onClick: toggleConfig, active: configOpen, disabled: !data })
			];

			const content = () => {
				if (collapsed) return null;
				if (edit) {
					return el(EditorPanel, {
						edit,
						draft,
						diffText,
						diffMeta,
						truncated,
						saving,
						editError,
						onChange: setDraft,
						onSave: () => void save(),
						onBack: closeEdit
					});
				}
				if (tab === "terminal") {
					return el(SidebarTerminal, { sessionId, cwd: data && data.cwd });
				}
				if (loading && !data) return EmptyState({ text: "加载中…" });
				if (error && !data) return el("div", { className: "dsh-sb-scroll" }, ErrorBanner({ text: error }));
				if (!data) return EmptyState({ text: "当前会话没有可显示的工作区" });

				if (tab === "files") {
					return el(Fragment, null,
						PanelHeader({
							title: data.rootName || "工作区",
							meta: data.cwd || null,
							actions: filesActions
						}),
						notice ? ErrorBanner({ text: notice }) : null,
						configOpen && draftConfig ? el(FileConfigPanel, {
							draft: draftConfig,
							onChange: setDraftConfig,
							onSave: saveConfig,
							onCancel: () => { setConfigOpen(false); setDraftConfig(null); }
						}) : null,
						el(UploadFeedback, {
							busy: uploadBusy,
							error: uploadError,
							summary: uploadSummary,
							conflict: pendingConflict,
							onReplace: () => void performUpload(pendingConflict.files, "overwrite"),
							onSkip: () => void performUpload(pendingConflict.files, "skip"),
							onCancel: () => setPendingConflict(null),
							onDismiss: () => setUploadError(null),
							onDismissSummary: () => setUploadSummary(null)
						}),
						rootDraft ? el(NameDraftRow, {
							defaultValue: "",
							placeholder: rootDraft.kind === "create-file" ? "新文件名" : "新文件夹名",
							paddingLeft: 12,
							onSubmit: async (name) => { await createEntry(".", name, rootDraft.kind); setRootDraft(null); },
							onCancel: () => setRootDraft(null)
						}) : null,
						el(FileTree, {
							files: data.files,
							changeMap,
							expandedPaths: openDirs,
							onToggleDir: toggleDir,
							openFile,
							edit,
							selectedPath,
							cwd: data.cwd,
							onOpenMenu: openMenu,
							onCreate: createEntry,
							onRename: renameEntry,
							onMoveDrop: (source, target) => { moveEntry(source, target).catch((moveError) => setNotice(moveError instanceof Error ? moveError.message : String(moveError))); },
							resetKey: sessionId,
							draftRequest,
							dirtyPaths: new Set()
						}));
				}
				if (tab === "git") {
					return el(Fragment, null,
						PanelHeader({
							title: data.git && data.git.isGit ? (data.git.branch || "Git 更改") : "Git 更改",
							meta: data.git && data.git.isGit && gitCount > 0 ? `${String(gitCount)} 项` : null,
							actions: ToolbarButton({ kind: "refresh", label: "刷新 Git 状态", onClick: () => void load() })
						}),
						el(GitPanel, { git: data.git, rootName: data.rootName, cwd: data.cwd, openFile, selectedPath }));
				}
				return el(Fragment, null,
					PanelHeader({ title: "会话信息", meta: data.rootName || null }),
					el(InfoPanel, { data, sessionStats, tokenUsage, contextPressure, contextBreakdown }));
			};

			return el("div", {
				"data-dsh-sidebar-root": "",
				role: "complementary",
				"aria-label": "工作区侧边栏"
			},
				el("input", {
					ref: uploadInputRef,
					type: "file",
					multiple: true,
					hidden: true,
					onChange: handleUploadInput
				}),
				el("div", { className: "dsh-sb-body" }, content()),
				el(RowMenu, { state: menuState, onClose: () => setMenuState(null), onAction: handleMenuAction }),
				picker ? el(DirectoryPicker, {
					state: picker,
					files: data ? data.files : [],
					cwd: picker.initialPath,
					onClose: () => setPicker(null),
					onSelect: (directory) => void confirmPicker(directory)
				}) : null,
				rail);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			const layout = ctx.get("layout");
			if (slots === void 0) return;

			const themeStyle = document.createElement("style");
			themeStyle.textContent = SIDEBAR_CSS;
			document.head.appendChild(themeStyle);

			// 面板收起时固定轨道会覆盖中间列右缘：让中间列预留 44px。
			const reserveStyle = document.createElement("style");
			reserveStyle.textContent = '[class$="frame"][data-details-collapsed] [class$="centerCol"] { padding-right: 44px; }';
			document.head.appendChild(reserveStyle);

			ctx.effect(() => () => {
				themeStyle.remove();
				reserveStyle.remove();
			}, "dsh-sidebar: css");

			// `inject` 回调在槽位渲染时执行，此时 layout 服务已完成接线。
			slots.inject("details", () => slots.register(
				{
					name: "details",
					id: "dsh-sidebar",
					priority: -1,
					inject: () => ({ layout })
				},
				(props) => el(WorkspacePanel, props)
			));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
