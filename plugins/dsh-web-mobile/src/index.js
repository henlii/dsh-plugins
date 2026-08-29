// dsh-web-mobile host half — viewport-fit + first-paint CSS.
//
// The official index.html viewport is `width=device-width, initial-scale=1`
// without `viewport-fit=cover`, so iPhone safe-area env() is zero until we
// rewrite it. Critical CSS runs before the client half so a 390px first paint
// does not flash the 56px rail + 44px sidebar rail.

import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

const name = "dsh-web-mobile";
const inject = ["webServer"];
const SETTINGS_NS = settingsNamespace("dsh-web-mobile");
const SettingsSchema = z.object({});

const CRITICAL_CSS = `<style data-dsh-mobile-critical>@media (max-width:639.98px){[class$="frame"]{grid-template-columns:0 minmax(0,1fr) 0 !important}[class$="handle"]{display:none !important}[class$="centerCol"]{padding-right:0 !important}nav[aria-label="dsh-sidebar 导航"]{display:none !important}[class$="sidebarCol"],[class$="detailsCol"]{content-visibility:hidden}}</style>`;

const META = `<meta data-dsh-mobile-meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><meta name="mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-status-bar-style" content="default" />`;

function injectMobileHead(html) {
  let out = html;
  if (!out.includes("data-dsh-mobile-meta")) {
    out = out.replace(/<meta[^>]+name=["']viewport["'][^>]*>/i, "");
    if (out.includes("<head>")) out = out.replace("<head>", `<head>${META}`);
    else {
      const tagged = out.replace(/<head(\s[^>]*)>/i, `<head$1>${META}`);
      out = tagged === out ? META + out : tagged;
    }
  }
  if (!out.includes("data-dsh-mobile-critical")) {
    if (out.includes("<head>")) out = out.replace("<head>", `<head>${CRITICAL_CSS}`);
    else {
      const tagged = out.replace(/<head(\s[^>]*)>/i, `<head$1>${CRITICAL_CSS}`);
      out = tagged === out ? CRITICAL_CSS + out : tagged;
    }
  }
  return out;
}

function apply(ctx) {
  installSettingsSection(ctx, SETTINGS_NS, SettingsSchema, {}, {
    setSource() {},
    onChange() {}
  });
  const webServer = ctx.get("webServer");
  ctx.effect(() => webServer.tapIndex(injectMobileHead), "dsh-web-mobile: viewport-fit + critical css");
}

export { name, inject, apply };
