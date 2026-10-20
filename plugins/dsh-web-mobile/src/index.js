// dsh-web-mobile host half — 移动端布局 + 手机入口代理。
//
// 客户端半边负责窄屏布局（抽屉侧栏、两级设置、手机间距）。宿主半边做两件事：
// 1. 首次绘制：index.html 不带 `viewport-fit=cover`（iPhone 上 env(safe-area-inset-*)
//    会一直是 0）也没有手机宽度兜底，390px 视口会先画 52px 侧栏轨道再回流。这里把
//    critical CSS 与 viewport meta 注入被服务的 index。
// 2. 可选的手机入口代理：监听一个局域网/tailnet 地址，把 Host/Origin 改写成上游
//    认的回环 authority 后转发（HTTP + WebSocket），让手机页面拿到 host 作用域的
//    设置与面板，而不是被当成远程查看器。实现见 proxy.js。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMobileProxy } from "./proxy.js";

const name = "dsh-web-mobile";

// Injected into <head> ahead of every bundle style: nothing here depends on the
// client half having run.
const HEAD = [
  '<meta data-dshm-head name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  "<style data-dshm-critical>",
  // Same threshold as the client half: the shell's own SIDEBAR_AUTO_COLLAPSE
  // (1024) — below it the sidebar is a rail and expanding it pushes the chat.
  "@media (max-width:1023.98px){",
  // Zero the rail track only: the frame is a three-track grid, and one column
  // would move the rightbar cell into a second row (its absolutely positioned
  // panel then sits below the fold).
  '[class$="frame"]{grid-template-columns:0px minmax(0px,1fr) minmax(0px,0px)!important}',
  "}",
  "</style>",
].join("");

function injectHead(html) {
  if (html.includes("data-dshm-head")) return html;
  let out = html.replace(/<meta[^>]+name=["']viewport["'][^>]*>/i, "");
  out = out.includes("<head>") ? out.replace("<head>", `<head>${HEAD}`) : `${HEAD}${out}`;
  return out;
}

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function readConfiguredPassword(config) {
  if (typeof config.password === "string" && config.password !== "") return config.password;
  const fromEnv = process.env.DSH_MOBILE_PASSWORD;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  const file = typeof config.passwordFile === "string" && config.passwordFile !== "" ? config.passwordFile : "";
  if (file === "") return null;
  try {
    const value = readFileSync(file, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function readPort(config) {
  const value = Number(config.port ?? 3081);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 3081;
}

function startProxy(webCtx, config) {
  const password = readConfiguredPassword(config);
  if (password === null) {
    console.warn(
      "dsh-web-mobile: 手机代理未启动 —— 未配置 password / passwordFile / DSH_MOBILE_PASSWORD。"
    );
    return;
  }
  const listenHost = typeof config.host === "string" && config.host !== "" ? config.host : "0.0.0.0";
  const port = readPort(config);
  const launchToken = () => {
    try {
      const connection = webCtx.get("connection");
      if (connection === undefined || typeof connection.authenticatedUrl !== "function") return "";
      const url = new URL(connection.authenticatedUrl(`http://127.0.0.1:${String(webCtx.webServer.port)}`));
      return url.searchParams.get("token") ?? "";
    } catch {
      return "";
    }
  };
  const proxy = createMobileProxy({
    listenHost,
    port,
    // 上游用 web server 的真实绑定地址（可能不是回环）；端口在 listen 之后才确定。
    upstream: {
      get host() {
        return webCtx.webServer.host;
      },
      get port() {
        return webCtx.webServer.port;
      }
    },
    password,
    secretFile: join(dshHome(), ".dsh-mobile-secret"),
    launchToken,
    inject: injectHead
  });
  proxy.listen().catch((error) => {
    console.error(
      `dsh-web-mobile: 手机代理无法监听 ${listenHost}:${String(port)} —— ${error instanceof Error ? error.message : String(error)}`
    );
  });
  webCtx.effect(() => () => {
    void proxy.close();
  }, "dsh-web-mobile: mobile proxy");
}

function apply(ctx, config = {}) {
  // A profile without a webserver (non-web app) has nothing to patch or proxy;
  // the client half still arrives through the client bundle.
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.tapIndex(injectHead), "dsh-web-mobile: index head");
    if (config.enabled === false) return;
    startProxy(webCtx, config);
  });
}

export { name, apply };
