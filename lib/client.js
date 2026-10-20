/**
 * Client (page) half: renders the one-click Restart button at the sidebar foot.
 *
 * Shape notes:
 *  - Loaded as a plain ModuleLoader bundle, the same way the shipped plugins load
 *    theirs (REFERENCES.md R6). No build step, no JSX, no TypeScript.
 *  - Only `react` is required from the module table; the module table does not expose
 *    Node built-ins here, and harness Client packages must not be imported (R10).
 *  - Registered into `sidebar.footer.action`, a LIST slot: using our own `id` adds a
 *    new cell beside the shipped entries instead of replacing one (R5). The seat sits
 *    directly above the account avatar, which is where the user wants the button.
 *  - Chinese source text is written as \u escapes so this file stays pure ASCII:
 *    the shipped plugins ship plain UTF-8 without BOM and we will not gamble on how
 *    the loader decodes non-ASCII bytes.
 */
window.__ModuleLoader__.load({
  id: "dsh-desktop-restart-button",
  factory(require) {
    const React = require("react");

    /** Route served by this plugin's Host half (see lib/index.js). */
    const ROUTE = "/dsh-desktop-restart/restart";
    /** Locale namespace; the dictionaries below are registered under it. */
    const NS = "restart-button";
    /** Custom header the Host half requires, so cross-site simple requests are refused. */
    const HEADER = "x-dsh-desktop-restart";
    /**
     * Watchdog: how long the button may stay in "restarting" before it admits that the
     * restart did not happen. The helper needs ~45s at worst to stop the app, and the app
     * normally disappears within a few seconds, so a minute is a safe admission window.
     */
    const WATCHDOG_MS = 60000;

    /** Chinese dictionary (escaped so the file needs no non-ASCII bytes). */
    const zh = {
      restart: "\u91cd\u542f",
      restarting: "\u91cd\u542f\u4e2d\u2026",
      failed: "\u91cd\u542f\u5931\u8d25",
      "failed.tooltip": "\u91cd\u542f\u6ca1\u80fd\u53d1\u8d77\uff08{reason}\uff09\u3002\u70b9\u300c\u91cd\u542f\u300d\u91cd\u8bd5\u3002",
      timeout: "\u8d85\u65f6\uff1a\u8bf7\u67e5\u770b %TEMP%\\dsh-desktop-restart\\ \u4e0b\u7684\u6700\u65b0\u65e5\u5fd7",
      "failed.pending": "\u91cd\u542f\u5931\u8d25\uff08\u8bf7\u67e5\u770b\u65e5\u5fd7\uff09",
      "restart.tooltip": "\u91cd\u542f DeepSeek Harness\uff1a\u5173\u95ed\u7a97\u53e3\u3001\u9000\u51fa\u5168\u90e8\u8fdb\u7a0b\uff0c\u7136\u540e\u81ea\u52a8\u91cd\u65b0\u6253\u5f00",
    };
    /** English dictionary, also the fallback when a key is missing. */
    const en = {
      restart: "Restart",
      restarting: "Restarting\u2026",
      failed: "Restart failed",
      "failed.tooltip": "The restart could not be started ({reason}). Click Restart to try again.",
      timeout: "timed out: see the newest log under %TEMP%\\dsh-desktop-restart\\",
      "failed.pending": "Restart failed (see the log)",
      "restart.tooltip": "Restart DeepSeek Harness: close the window, exit every process, then reopen automatically",
    };

    /** Inline styles. Only --dsw-alias-* theme tokens are referenced (R6/verification). */
    const css = {
      button: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: "8px",
        width: "100%",
        minHeight: "32px",
        padding: "6px 8px",
        margin: "0",
        border: "none",
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        fontFamily: "inherit",
        fontSize: "13px",
        lineHeight: "20px",
        textAlign: "left",
        cursor: "pointer",
        borderRadius: "6px",
      },
      buttonNarrow: {
        justifyContent: "center",
        padding: "6px 0",
      },
      buttonDisabled: {
        cursor: "default",
        color: "var(--dsw-alias-label-tertiary)",
      },
      icon: {
        flex: "0 0 auto",
        width: "16px",
        height: "16px",
        display: "block",
      },
      label: {
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
    };

    /** The restart glyph: a circular arrow, drawn with currentColor. */
    function RestartGlyph() {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: 16,
          height: 16,
          "aria-hidden": "true",
          style: css.icon,
        },
        React.createElement("path", {
          d: "M20 12a8 8 0 1 1-2.6-5.9",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
        }),
        React.createElement("path", {
          d: "M20 4v5h-5",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    /**
     * The button component.
     * @param props - slot props: `wide` (column state) and `t` (namespace translator).
     */
    function RestartButton(props) {
      const wide = props.wide === true;
      const t = typeof props.t === "function" ? props.t : (key) => (en[key] ?? key);
      const [phase, setPhase] = React.useState("idle");
      const [reason, setReason] = React.useState("");
      const watchdog = React.useRef(null);

      /** Stop the watchdog, if one is armed. */
      const clearWatchdog = () => {
        if (watchdog.current !== null) {
          clearTimeout(watchdog.current);
          watchdog.current = null;
        }
      };

      const requestRestart = () => {
        if (phase === "busy") return;
        setPhase("busy");
        setReason("");
        const headers = { "content-type": "application/json" };
        headers[HEADER] = "1";
        fetch(ROUTE, {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: "{}",
        })
          .then((response) =>
            response
              .json()
              .catch(() => null)
              .then((payload) => ({ status: response.status, payload })),
          )
          .then(({ status, payload }) => {
            if (status === 200 && payload !== null && payload.ok === true) {
              // Accepted: the helper is on its way and the app should exit shortly, taking
              // this page with it. But a helper can also fail after a 200 (it refuses to
              // relaunch, or the relaunch never lands), and then the app is still here and
              // the button would stay disabled forever. So arm a watchdog: if we are still
              // alive after it, tell the user the restart did not happen and let them retry.
              clearWatchdog();
              watchdog.current = setTimeout(() => {
                watchdog.current = null;
                setReason(t("timeout"));
                setPhase("failed");
              }, WATCHDOG_MS);
              return;
            }
            let detail = "HTTP " + String(status);
            if (payload !== null && payload !== undefined) {
              detail = String(payload.error ?? payload.detail ?? detail);
            }
            setReason(detail);
            setPhase("failed");
          })
          .catch((error) => {
            setReason(String((error && error.message) || error));
            setPhase("failed");
          });
      };

      const busy = phase === "busy";
      const failed = phase === "failed";
      const label = busy ? t("restarting") : failed ? t("failed") : t("restart");
      // A failure without a specific reason still has to say something useful.
      const shown = reason === "" ? t("failed.pending") : reason;
      const title = busy
        ? t("restarting")
        : failed
          ? t("failed.tooltip").replace("{reason}", shown)
          : t("restart.tooltip");

      // Disarm the watchdog when this entry unmounts, so a collapsed sidebar cannot leave
      // a timer behind that fires into a gone component.
      React.useEffect(() => clearWatchdog, []);

      return React.createElement(
        "button",
        {
          type: "button",
          title,
          "aria-label": t("restart"),
          "aria-busy": busy,
          "aria-live": "polite",
          disabled: busy,
          "data-phase": phase,
          style: Object.assign({}, css.button, wide ? null : css.buttonNarrow, busy ? css.buttonDisabled : null),
          onClick: requestRestart,
        },
        React.createElement(RestartGlyph, null),
        wide ? React.createElement("span", { style: css.label }, label) : null,
      );
    }

    /** Required services: the slot registry and the locale registry. */
    const inject = ["slots", "locale"];

    /**
     * Client plugin body: seed the dictionaries, then claim the sidebar foot seat.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "dsh-desktop-restart-button: dictionaries",
      );
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "dsh-desktop-restart",
            order: 15,
            locale: NS,
          },
          RestartButton,
        ),
      );
    }

    return { name: "dsh-desktop-restart-button", inject, apply };
  },
});
