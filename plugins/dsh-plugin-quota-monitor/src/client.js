// dsh-plugin-quota-monitor — browser half.
//
// Two surfaces:
//  1. A sidebar footer card (above Settings) showing status rows for the
//     active provider plus the always-on DeepSeek Rage row:
//       opencode → 血 HP (monthly, red) / 魔法 MP (weekly, blue) /
//                  耐力 SP (5h, yellow)
//       scnet    → Credits remaining (green)
//       deepseek → 怒气 Rage (gold) ¥ remaining — always shown
//  2. A Settings section (设置 → 插件管理 → 余额监控) to pick the active
//     provider, toggle which meters show, and configure the scnet quota +
//     per-model Credits rates.
//
// Data rides the /balance channel endpoints provided by the host half. The
// card polls every 60s and re-polls when the tab becomes visible again.
//
// Hand-written classic-script bundle: the module table answers require() for
// the platform entries (react, react/jsx-runtime); everything else is inlined.
// No build step, no CSS files — inline styles only, design-system variables.

window.__ModuleLoader__.load({
  id: 'dsh-plugin-quota-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const { jsx, jsxs } = require('react/jsx-runtime');
    const { useCallback, useEffect, useState } = require('react');

    const NS = 'balance';
    const zh = {
      'nav': '余额监控',
      'card.title': '状态',
      'card.rage': '怒气',
      'card.rage.money': 'DeepSeek 余额',
      'card.hp': 'HP 血',
      'card.hp.month': '月额度',
      'card.mp': 'MP 魔法',
      'card.mp.week': '周额度',
      'card.sp': 'SP 耐力',
      'card.sp.5h': '5h 额度',
      'card.credits': 'Credits',
      'card.unavailable': '数据不可用',
      'card.stale': '数据过期',
      'card.noProvider': '未检测到服务商',
      'settings.mode': '数据源',
      'settings.mode.auto': '自动（跟随默认模型）',
      'settings.mode.opencode': 'OpenCode Go',
      'settings.mode.scnet': '国家超算中心',
      'settings.current': '当前检测：',
      'settings.opencode.meters': 'OpenCode 显示的条',
      'settings.opencode.monthly': '月额度（HP 血）',
      'settings.opencode.weekly': '周额度（MP 魔法）',
      'settings.opencode.rolling': '5小时额度（SP 耐力）',
      'settings.scnet': '国家超算 Credits',
      'settings.scnet.quota': '月度额度（Credits）',
      'settings.scnet.resetDay': '每月重置日',
      'settings.scnet.resetDay.hint': 'Token Plan 按你的计费周期重置（不一定每月 1 号）。填控制台显示的额度重置日（1-28），插件按“上次重置日→今天”统计。',
      'settings.scnet.rates': '模型费率（每百万 token 的 Credits，JSON）',
      'settings.showDeepseek': '始终显示 DeepSeek 怒气条',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.error': '保存失败',
    };
    const en = {
      'nav': 'Balance Monitor',
      'card.title': 'Status',
      'card.rage': 'Rage',
      'card.rage.money': 'DeepSeek balance',
      'card.hp': 'HP',
      'card.hp.month': 'Monthly',
      'card.mp': 'MP',
      'card.mp.week': 'Weekly',
      'card.sp': 'SP',
      'card.sp.5h': '5h quota',
      'card.credits': 'Credits',
      'card.unavailable': 'No data',
      'card.stale': 'Stale data',
      'card.noProvider': 'No provider detected',
      'settings.mode': 'Data source',
      'settings.mode.auto': 'Auto (follow default model)',
      'settings.mode.opencode': 'OpenCode Go',
      'settings.mode.scnet': 'SCNet Center',
      'settings.current': 'Detected:',
      'settings.opencode.meters': 'OpenCode meters shown',
      'settings.opencode.monthly': 'Monthly (HP)',
      'settings.opencode.weekly': 'Weekly (MP)',
      'settings.opencode.rolling': '5h quota (SP)',
      'settings.scnet': 'SCNet Credits',
      'settings.scnet.quota': 'Monthly quota (Credits)',
      'settings.scnet.resetDay': 'Monthly reset day',
      'settings.scnet.resetDay.hint': 'Token Plan resets on your billing cycle (not necessarily the 1st). Enter the reset day (1-28) shown in the console; the plugin counts from the last reset day to today.',
      'settings.scnet.rates': 'Model rates (Credits per M tokens, JSON)',
      'settings.showDeepseek': 'Always show DeepSeek Rage row',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.error': 'Save failed',
    };

    const POLL_MS = 60000;

    // ── colors ───────────────────────────────────────────────────────────────
    const C_HP = 'var(--dsw-static-red-500)';
    const C_MP = 'var(--dsw-static-blue-500)';
    const C_SP = 'var(--dsw-static-amber-500)';
    const C_CREDITS = 'var(--dsw-static-green-500)';
    const RAGE_FILL = 'linear-gradient(90deg, #e6c34a 0%, #f5d76e 55%, #e6c34a 100%)';

    // ── helpers ──────────────────────────────────────────────────────────────
    const clamp = (n) => Math.max(0, Math.min(100, n));
    const fmtMoney = (n) => `¥${Number(n).toFixed(2)}`;
    const fmtNumber = (n) => Number(n || 0).toLocaleString('en-US');
    const fmtUsd = (n) => `$${Number(n).toFixed(1)}`;

    const trackStyle = {
      width: '100%',
      height: 4,
      borderRadius: 999,
      background: 'var(--dsw-alias-border-l2)',
      overflow: 'hidden',
      opacity: 0.9,
    };
    const fillStyle = (ratio, color) => ({
      height: '100%',
      borderRadius: 999,
      background: color,
      width: `${(clamp(ratio) * 100).toFixed(1)}%`,
      transition: 'width 300ms ease',
    });

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      width: '100%',
      minWidth: 0,
      padding: '8px 10px',
      borderRadius: 12,
      boxSizing: 'border-box',
    };
    const titleRowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      minWidth: 0,
    };
    const titleStyle = {
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary)',
      fontWeight: 600,
      letterSpacing: 1,
      whiteSpace: 'nowrap',
    };
    const badgeStyle = (stale) => ({
      fontSize: 10,
      lineHeight: '14px',
      color: 'var(--dsw-alias-label-tertiary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      opacity: stale ? 0.55 : 1,
    });
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minWidth: 0,
    };
    const labelStyle = (color) => ({
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 11,
      lineHeight: '14px',
      fontWeight: 700,
      color,
      whiteSpace: 'nowrap',
      minWidth: 44,
    });
    const barWrapStyle = { flex: 1, minWidth: 0 };
    const valueStyle = {
      flex: 'none',
      fontSize: 11,
      lineHeight: '14px',
      color: 'var(--dsw-alias-label-secondary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      textAlign: 'right',
    };
    const railStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 36,
      height: 36,
      borderRadius: 999,
      fontSize: 10,
      fontWeight: 700,
      color: 'var(--dsw-alias-label-secondary)',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      userSelect: 'none',
    };

    // ── RPC api shared by card + settings ─────────────────────────────────────
    function makeApi(connection) {
      return {
        configGet: () => connection.rpc.call('/balance', 'configGet', {}),
        configSet: (config) => connection.rpc.call('/balance', 'configSet', { config }),
        snapshot: () => connection.rpc.call('/balance', 'snapshot', {}),
        opencode: () => connection.rpc.call('/balance', 'opencode', {}),
        scnet: () => connection.rpc.call('/balance', 'scnet', {}),
      };
    }

    // ── Sidebar card ──────────────────────────────────────────────────────────
    function StatusCard({ wide, t, api }) {
      const [cfg, setCfg] = useState(null); // { config, activeProvider }
      const [bal, setBal] = useState(null);
      const [oc, setOc] = useState(null);
      const [sc, setSc] = useState(null);

      const tick = useCallback(async () => {
        try {
          const [c, b, o, s] = await Promise.all([
            api.configGet(),
            api.snapshot(),
            api.opencode(),
            api.scnet(),
          ]);
          if (c && c.ok && c.value) setCfg(c.value);
          if (b && b.ok && b.value) setBal(b.value);
          if (o && o.ok && o.value) setOc(o.value);
          if (s && s.ok && s.value) setSc(s.value);
        } catch {
          // keep the last known numbers
        }
      }, [api]);

      useEffect(() => {
        tick();
        const timer = window.setInterval(tick, POLL_MS);
        const onVisible = () => {
          if (document.visibilityState === 'visible') tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [tick]);

      const config = (cfg && cfg.config) || {};
      const active = (cfg && cfg.activeProvider) || null;
      const showDeepseek = config.showDeepseek !== false;

      const stale = !!(
        (bal && bal.stale) ||
        (oc && oc.stale) ||
        (sc && sc.stale)
      );

      const rageValue = bal ? fmtMoney(bal.total) : null;
      const rageTitle = bal ? `${t('card.rage.money')}: ${fmtMoney(bal.total)}` : null;

      // Collapsed rail: show the DeepSeek money compactly (always present).
      if (!wide) {
        const text = rageValue || (active === 'scnet' && sc ? fmtNumber(sc.remaining) : null) || '—';
        const title =
          (rageTitle ? rageTitle + ' · ' : '') +
          (active === 'scnet' && sc ? `${t('card.credits')} 剩 ${fmtNumber(sc.remaining)}` : '') +
          (active === 'opencode' && oc
            ? `HP ${fmtUsd(remainingUsd(oc.monthly))} · MP ${fmtUsd(remainingUsd(oc.weekly))} · SP ${fmtUsd(remainingUsd(oc.rolling))}`
            : '');
        return jsx('div', {
          style: railStyle,
          title: title || t('card.unavailable'),
          children: text.length > 6 ? text.slice(0, 6) : text,
        });
      }

      function remainingUsd(w) {
        if (!w) return 0;
        return w.limitUsd * (w.remainingPct / 100);
      }

      const rows = [];

      // DeepSeek Rage row (always).
      if (showDeepseek) {
        rows.push({
          key: 'rage',
          label: t('card.rage'),
          sub: t('card.rage.money'),
          color: RAGE_FILL,
          value: rageValue || '—',
          ratio: null,
        });
      }

      // Active provider rows.
      if (active === 'opencode' && oc) {
        const meters = config.opencodeMeters || {};
        if (meters.monthly !== false && oc.monthly) {
          rows.push({
            key: 'hp',
            label: t('card.hp'),
            sub: t('card.hp.month'),
            color: C_HP,
            value: `剩 ${fmtUsd(remainingUsd(oc.monthly))} / ${fmtUsd(oc.monthly.limitUsd)}`,
            ratio: oc.monthly.remainingPct / 100,
          });
        }
        if (meters.weekly !== false && oc.weekly) {
          rows.push({
            key: 'mp',
            label: t('card.mp'),
            sub: t('card.mp.week'),
            color: C_MP,
            value: `剩 ${fmtUsd(remainingUsd(oc.weekly))} / ${fmtUsd(oc.weekly.limitUsd)}`,
            ratio: oc.weekly.remainingPct / 100,
          });
        }
        if (meters.rolling !== false && oc.rolling) {
          rows.push({
            key: 'sp',
            label: t('card.sp'),
            sub: t('card.sp.5h'),
            color: C_SP,
            value: `剩 ${fmtUsd(remainingUsd(oc.rolling))} / ${fmtUsd(oc.rolling.limitUsd)}`,
            ratio: oc.rolling.remainingPct / 100,
          });
        }
      } else if (active === 'scnet' && sc) {
        rows.push({
          key: 'credits',
          label: t('card.credits'),
          sub: sc.month,
          color: C_CREDITS,
          value: `剩 ${fmtNumber(sc.remaining)}`,
          ratio: sc.remainingPct / 100,
        });
      } else if (active === null) {
        rows.push({
          key: 'noprovider',
          label: '—',
          sub: '',
          color: 'var(--dsw-alias-label-tertiary)',
          value: t('card.noProvider'),
          ratio: null,
        });
      }

      const hasAny = rows.length > 0 && !(rows.length === 1 && rows[0].key === 'noprovider' && !bal);

      return jsxs('div', {
        style: { ...cardStyle, opacity: stale ? 0.55 : 1 },
        children: [
          jsxs('div', {
            style: titleRowStyle,
            children: [
              jsx('span', { style: titleStyle, children: t('card.title') }),
              jsx('span', {
                style: badgeStyle(stale),
                children: hasAny ? (stale ? t('card.stale') : '') : t('card.unavailable'),
              }),
            ],
          }),
          ...rows.map((r) =>
            jsxs('div', {
              style: rowStyle,
              key: r.key,
              children: [
                jsx('span', {
                  style: labelStyle(r.color),
                  title: r.sub,
                  children: r.label,
                }),
                r.ratio !== null
                  ? jsx('div', {
                      style: barWrapStyle,
                      title: r.sub,
                      children: jsx('div', {
                        style: trackStyle,
                        children: jsx('div', { style: fillStyle(r.ratio, r.color) }),
                      }),
                    })
                  : jsx('div', { style: barWrapStyle, children: null }),
                jsx('span', { style: valueStyle, children: r.value }),
              ],
            }),
          ),
        ],
      });
    }

    // ── Settings section (设置 → 插件管理 → 余额监控) ─────────────────────────
    function SettingsSection({ t, close, api }) {
      const [mode, setMode] = useState('auto');
      const [opencodeMeters, setOpencodeMeters] = useState({ rolling: true, weekly: true, monthly: true });
      const [quota, setQuota] = useState(60000);
      const [resetDay, setResetDay] = useState(1);
      const [ratesText, setRatesText] = useState('');
      const [showDeepseek, setShowDeepseek] = useState(true);
      const [detected, setDetected] = useState(null);
      const [status, setStatus] = useState('');
      const [loaded, setLoaded] = useState(false);

      useEffect(() => {
        let alive = true;
        api
          .configGet()
          .then((res) => {
            if (!alive || !res || !res.ok || !res.value) return;
            const { config, activeProvider } = res.value;
            setMode(config.mode || 'auto');
            setOpencodeMeters(config.opencodeMeters || {});
            setQuota(config.scnet?.planQuota ?? 60000);
            setResetDay(config.scnet?.resetDay ?? 1);
            setRatesText(JSON.stringify(config.scnet?.rates || {}, null, 2));
            setShowDeepseek(config.showDeepseek !== false);
            setDetected(activeProvider);
            setLoaded(true);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [api]);

      const save = async () => {
        let rates = null;
        try {
          rates = JSON.parse(ratesText);
        } catch {
          setStatus(t('settings.error'));
          return;
        }
        const config = {
          mode,
          opencodeMeters,
          scnet: {
            planQuota: Number(quota) || 60000,
            resetDay: Math.min(28, Math.max(1, Number(resetDay) || 1)),
            rates,
          },
          showDeepseek,
        };
        try {
          const res = await api.configSet(config);
          if (res && res.ok) {
            if (res.value && res.value.activeProvider) setDetected(res.value.activeProvider);
            setStatus(t('settings.saved'));
          } else {
            setStatus(t('settings.error'));
          }
        } catch {
          setStatus(t('settings.error'));
        }
      };

      const modeOptions = [
        ['auto', t('settings.mode.auto')],
        ['opencode', t('settings.mode.opencode')],
        ['scnet', t('settings.mode.scnet')],
      ];
      const meterItems = [
        ['monthly', t('settings.opencode.monthly')],
        ['weekly', t('settings.opencode.weekly')],
        ['rolling', t('settings.opencode.rolling')],
      ];

      const secStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '16px 0',
        width: '100%',
        maxWidth: 520,
      };
      const groupStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      };
      const groupTitleStyle = {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
      };
      const rowStyle2 = {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
      };
      const inputStyle = {
        background: 'var(--dsw-alias-input-bg, rgba(0,0,0,0.2))',
        border: '1px solid var(--dsw-alias-line-border, rgba(127,127,127,0.25))',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      };
      const textareaStyle = {
        ...inputStyle,
        minHeight: 140,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.5,
        resize: 'vertical',
      };
      const btnStyle = {
        alignSelf: 'flex-start',
        background: 'var(--dsw-static-deepseek-500)',
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        padding: '8px 18px',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      };
      const hintStyle = {
        fontSize: 12,
        color: 'var(--dsw-alias-label-tertiary)',
        lineHeight: 1.6,
      };

      if (!loaded) {
        return jsx('div', { style: secStyle, children: jsx('div', { style: hintStyle, children: '…' }) });
      }

      return jsxs('div', {
        style: secStyle,
        children: [
          jsxs('div', {
            style: groupStyle,
            children: [
              jsx('div', { style: groupTitleStyle, children: t('settings.mode') }),
              ...modeOptions.map(([val, label]) =>
                jsxs('label', {
                  key: val,
                  style: rowStyle2,
                  children: [
                    jsx('input', {
                      type: 'radio',
                      name: 'bm-mode',
                      checked: mode === val,
                      onChange: () => setMode(val),
                    }),
                    jsx('span', { children: label }),
                  ],
                }),
              ),
              jsx('div', {
                style: hintStyle,
                children:
                  detected === 'scnet'
                    ? `${t('settings.current')} 国家超算中心 (scnet)`
                    : detected === 'opencode'
                      ? `${t('settings.current')} OpenCode Go`
                      : t('card.noProvider'),
              }),
            ],
          }),

          jsxs('div', {
            style: groupStyle,
            children: [
              jsx('div', { style: groupTitleStyle, children: t('settings.opencode.meters') }),
              ...meterItems.map(([key, label]) =>
                jsxs('label', {
                  key,
                  style: rowStyle2,
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      checked: opencodeMeters[key] !== false,
                      onChange: (e) =>
                        setOpencodeMeters({ ...opencodeMeters, [key]: e.target.checked }),
                    }),
                    jsx('span', { children: label }),
                  ],
                }),
              ),
            ],
          }),

          jsxs('div', {
            style: groupStyle,
            children: [
              jsx('div', { style: groupTitleStyle, children: t('settings.scnet') }),
              jsx('div', {
                style: rowStyle2,
                children: [
                  jsx('span', { style: { flex: 'none', minWidth: 120 }, children: t('settings.scnet.quota') }),
                  jsx('input', {
                    type: 'number',
                    value: quota,
                    onChange: (e) => setQuota(e.target.value),
                    style: { ...inputStyle, width: 160 },
                  }),
                ],
              }),
              jsx('div', {
                style: rowStyle2,
                children: [
                  jsx('span', { style: { flex: 'none', minWidth: 120 }, children: t('settings.scnet.resetDay') }),
                  jsx('input', {
                    type: 'number',
                    min: 1,
                    max: 28,
                    value: resetDay,
                    onChange: (e) => setResetDay(e.target.value),
                    style: { ...inputStyle, width: 100 },
                  }),
                ],
              }),
              jsx('div', { style: hintStyle, children: t('settings.scnet.resetDay.hint') }),
              jsx('div', { style: hintStyle, children: t('settings.scnet.rates') }),
              jsx('textarea', {
                value: ratesText,
                onChange: (e) => setRatesText(e.target.value),
                style: textareaStyle,
                spellCheck: false,
              }),
            ],
          }),

          jsxs('label', {
            style: rowStyle2,
            children: [
              jsx('input', {
                type: 'checkbox',
                checked: showDeepseek,
                onChange: (e) => setShowDeepseek(e.target.checked),
              }),
              jsx('span', { children: t('settings.showDeepseek') }),
            ],
          }),

          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: 12 },
            children: [
              jsx('button', { style: btnStyle, onClick: save, children: t('settings.save') }),
              status
                ? jsx('span', {
                    style: {
                      fontSize: 12,
                      color:
                        status === t('settings.saved')
                          ? 'var(--dsw-static-green-500)'
                          : 'var(--dsw-static-red-500)',
                    },
                    children: status,
                  })
                : null,
            ],
          }),
        ],
      });
    }

    // ── registration ──────────────────────────────────────────────────────────
    const inject = ['connection', 'slots', 'locale'];

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'quota-monitor: dictionaries',
      );

      const connection = ctx.get('connection');
      const api = makeApi(connection);

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'quota-monitor',
            locale: NS,
            inject: () => ({ api }),
          },
          StatusCard,
        ),
      );

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'quota-monitor-settings',
            order: 60,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ api }),
          },
          SettingsSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
