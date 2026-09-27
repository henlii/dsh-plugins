// dsh-web-mobile host half — this plugin is browser-side: the whole surface is a
// layer over the shipped web shell (drawer sidebars, two-level Settings, phone
// spacing). The row exists so the client module rides in the boot manifest.
//
// The one host-side job is the first paint: index.html ships without
// `viewport-fit=cover` (so `env(safe-area-inset-*)` stays 0 on an iPhone) and
// without a phone-width fallback, which means a 390px viewport paints the 52px
// sidebar rail first and only reflows when the client half runs. Critical CSS +
// the viewport meta are injected into the served index instead.
const name = "dsh-web-mobile";

// Injected into <head> ahead of every bundle style: nothing here depends on the
// client half having run.
const HEAD = [
  '<meta data-dshm-head name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
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

function apply(ctx) {
  // A profile without a webserver (non-web app) has nothing to patch; the client
  // half still arrives through the client bundle.
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.tapIndex(injectHead), "dsh-web-mobile: index head");
  });
}

export { name, apply };
