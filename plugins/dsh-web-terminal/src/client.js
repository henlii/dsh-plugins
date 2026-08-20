// dsh-web-terminal client half — no-op.
//
// 终端 UI 在右侧栏（dsh-sidebar 的「终端」tab）。本插件只保留宿主：
// 用户 PTY 管理 + /api/dsh-web-terminal/* RPC。不替换 ctx.shell。
window.__ModuleLoader__.load({
	id: "dsh-web-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		function apply() {}

		exports.apply = apply;
		return module.exports;
	}
});
