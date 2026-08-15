// dsh-web-terminal client half — now a no-op.
//
// 终端 UI 已移入右侧栏（dsh-sidebar 的「终端」tab），本插件只保留宿主职责：
// ctx.shell 替换、全局终端管理、模型工具、/api/dsh-web-terminal/* RPC。
window.__ModuleLoader__.load({
	id: "dsh-web-terminal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		function apply() {
			// 客户端无需注册任何槽位：终端面板由 dsh-sidebar 的「终端」tab 渲染。
		}

		exports.apply = apply;
		return module.exports;
	}
});
