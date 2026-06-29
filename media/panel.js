// @ts-nocheck
// Webview 側スクリプト。拡張から postMessage された UsageView を描画する。
// 外部依存なし。データはすべて textContent / createElement で安全に挿入する。
(function () {
  const vscode = acquireVsCodeApi();
  const SVG_NS = "http://www.w3.org/2000/svg";

  function usd(n) {
    return "$" + (Number(n) || 0).toFixed(2);
  }

  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }

  function sumTokens(t) {
    return (
      t.inputTokens +
      t.outputTokens +
      t.cacheReadTokens +
      t.cacheWrite5mTokens +
      t.cacheWrite1hTokens
    );
  }

  // 外部サービス名を UI に直接出さない方針: Claude 以外のモデル名は汎用表記にする。
  function displayModel(model, showRaw) {
    if (showRaw) return model;
    if (typeof model === "string" && model.indexOf("claude-") === 0) return model;
    if (model === "<synthetic>") return "システム";
    if (model === "unknown") return "不明なモデル";
    return "ローカル/その他モデル";
  }

  function levelLabel(level) {
    switch (level) {
      case "over":
        return "上限到達";
      case "approaching":
        return "上限に接近";
      case "ok":
        return "余裕あり";
      default:
        return "取得不可";
    }
  }

  function worstLevel(x, y) {
    const rank = { unavailable: 0, ok: 1, approaching: 2, over: 3 };
    return rank[x] >= rank[y] ? x : y;
  }

  function el(tag, opts) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.class) node.className = opts.class;
      if (opts.text != null) node.textContent = String(opts.text);
    }
    return node;
  }

  function card(label, value, sub, highlight) {
    const c = el("div", { class: "card" + (highlight ? " highlight" : "") });
    c.appendChild(el("div", { class: "label", text: label }));
    c.appendChild(el("div", { class: "value", text: value }));
    if (sub) c.appendChild(el("div", { class: "sub", text: sub }));
    return c;
  }

  function section(title) {
    const s = el("div", { class: "section" });
    if (title) s.appendChild(el("div", { class: "section-title", text: title }));
    return s;
  }

  function billingText(eu) {
    if (eu.billingEnabled == null) return "不明";
    return eu.billingEnabled
      ? "有効（超過分は課金され得る）"
      : "無効" + (eu.disabledReason ? "（" + eu.disabledReason + "）" : "");
  }

  // 使用率バー（SVG。CSP のためインライン style を使わない）
  function barRow(label, w) {
    const row = el("div", { class: "bar-row" });
    const head = el("div", { class: "bar-head" });
    head.appendChild(el("span", { text: label }));
    head.appendChild(
      el("span", { text: w.percent != null ? w.percent + "%" : "取得不可" })
    );
    row.appendChild(head);

    if (w.percent != null) {
      const pct = Math.min(100, Math.max(0, w.percent));
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "bar-svg");
      svg.setAttribute("viewBox", "0 0 100 8");
      svg.setAttribute("preserveAspectRatio", "none");
      const bg = document.createElementNS(SVG_NS, "rect");
      bg.setAttribute("class", "bar-bg");
      bg.setAttribute("x", "0");
      bg.setAttribute("y", "0");
      bg.setAttribute("width", "100");
      bg.setAttribute("height", "8");
      bg.setAttribute("rx", "4");
      svg.appendChild(bg);
      const fg = document.createElementNS(SVG_NS, "rect");
      fg.setAttribute("class", "bar-fg " + w.level);
      fg.setAttribute("x", "0");
      fg.setAttribute("y", "0");
      fg.setAttribute("width", String(pct));
      fg.setAttribute("height", "8");
      fg.setAttribute("rx", "4");
      svg.appendChild(fg);
      row.appendChild(svg);

      const detail = el("div", { class: "bar-head muted" });
      detail.appendChild(el("span", { text: levelLabel(w.level) }));
      if (w.resetText) detail.appendChild(el("span", { text: "リセット " + w.resetText }));
      row.appendChild(detail);
    }
    return row;
  }

  // 日次グラフ（自前 SVG 棒グラフ）
  function dailyChart(daily) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "chart");
    const W = 600;
    const H = 140;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "none");
    const max = daily.reduce((m, d) => Math.max(m, d.costUSD), 0) || 1;
    const n = daily.length;
    const bw = W / n;
    daily.forEach((d, i) => {
      const h = (d.costUSD / max) * (H - 20);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("class", "bar");
      rect.setAttribute("x", String(i * bw + 1));
      rect.setAttribute("y", String(H - h));
      rect.setAttribute("width", String(Math.max(1, bw - 2)));
      rect.setAttribute("height", String(h));
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = d.date + ": " + usd(d.costUSD);
      rect.appendChild(title);
      svg.appendChild(rect);
    });
    return svg;
  }

  function render(view, options) {
    const app = document.getElementById("app");
    app.textContent = "";

    const a = view.aggregate;
    const o = view.overage;
    const showRaw = !!(options && options.showRawModelNames);

    app.appendChild(el("h1", { text: "Claude コスト可視化" }));
    app.appendChild(
      el("p", {
        class: "caveat",
        text:
          "使用率は公式 /usage の実測値（このアカウントのサーバー側の値）。API換算コストは、このマシンのローカルデータと公開API価格に基づく推定です。",
      })
    );

    // 状態バナー
    const worst = worstLevel(o.fiveHour.level, o.weekly.level);
    const banner = el("div", { class: "banner " + worst });
    banner.appendChild(
      el("div", { class: "banner-title", text: "状態: " + levelLabel(worst) })
    );
    banner.appendChild(
      el("div", {
        class: "banner-sub",
        text: "追加使用課金(参考): " + billingText(o.extraUsage),
      })
    );
    app.appendChild(banner);

    // 使用率（要件①）
    const usage = section("サブスク使用制限の使用率（公式 /usage 実測）");
    if (o.fiveHour.percent == null && o.weekly.percent == null) {
      const note = el("div", { class: "cta" });
      note.appendChild(
        el("div", {
          text:
            "公式CLI（claude -p \"/usage\"）から使用率を取得できませんでした。claude が見つからないか取得に失敗しています。",
        })
      );
      note.appendChild(
        el("div", {
          class: "muted",
          text:
            "設定 claudeCost.claudeCliPath で claude のパスを指定できます。useCliUsage を有効にしてください。",
        })
      );
      usage.appendChild(note);
    } else {
      usage.appendChild(barRow("5時間ウィンドウ", o.fiveHour));
      usage.appendChild(barRow("週次ウィンドウ（全モデル）", o.weekly));
      if (o.sonnetWeeklyPercent != null) {
        usage.appendChild(
          el("div", {
            class: "muted",
            text: "週次（Sonnet のみ）: " + o.sonnetWeeklyPercent + "%",
          })
        );
      }
    }
    app.appendChild(usage);

    // API換算コスト（要件②）
    const cost = section("API換算コスト（もしAPIで使っていたら）");
    const cards = el("div", { class: "cards" });
    cards.appendChild(card("5時間", usd(a.fiveHour.costUSD)));
    cards.appendChild(card("週次", usd(a.weekly.costUSD)));
    cards.appendChild(card("当日", usd(a.today.costUSD)));
    cards.appendChild(card("累計", usd(a.total.costUSD)));
    cost.appendChild(cards);
    app.appendChild(cost);

    // 追加使用（超過）コスト（要件③）
    const ov = section("追加使用（超過）コスト");
    if (o.overActive) {
      ov.appendChild(
        el("div", { text: "5時間ウィンドウが上限（100%）に到達しています。" })
      );
      if (o.extraUsage.billingEnabled === false) {
        ov.appendChild(
          el("div", {
            class: "muted",
            text:
              "追加使用課金は無効" +
              (o.extraUsage.disabledReason ? "（" + o.extraUsage.disabledReason + "）" : "") +
              "のため、超過分は課金されず停止します（追加コスト $0）。",
          })
        );
      }
      const ovCards = el("div", { class: "cards" });
      ovCards.appendChild(card("追加使用コスト（概算）", usd(o.overageCostUSD), null, true));
      ov.appendChild(ovCards);
      if (o.overageStartTs) {
        ov.appendChild(
          el("div", {
            class: "muted",
            text:
              "100%到達を観測した時刻: " +
              new Date(o.overageStartTs).toLocaleString() +
              "（以降のトークンを集計）",
          })
        );
      }
    } else {
      ov.appendChild(
        el("div", {
          class: "muted",
          text:
            o.fiveHour.percent == null
              ? "使用率を取得できないため判定できません。"
              : "現在、上限超過はありません。",
        })
      );
    }
    app.appendChild(ov);

    // モデル別内訳（累計）
    const models = section("モデル別内訳（累計）");
    const table = el("table");
    const thead = el("tr");
    thead.appendChild(el("th", { text: "モデル" }));
    thead.appendChild(el("th", { class: "num", text: "トークン" }));
    thead.appendChild(el("th", { class: "num", text: "API換算コスト" }));
    table.appendChild(thead);
    a.total.byModel.forEach((m) => {
      const tr = el("tr");
      const name = displayModel(m.model, showRaw) + (m.priced ? "" : "（価格未定義）");
      tr.appendChild(el("td", { text: name }));
      tr.appendChild(el("td", { class: "num", text: fmtTokens(sumTokens(m.tokens)) }));
      tr.appendChild(el("td", { class: "num", text: m.priced ? usd(m.costUSD) : "—" }));
      table.appendChild(tr);
    });
    models.appendChild(table);
    // unknownModelHandling が "warn" のときは価格未定義モデルの存在を明示する
    // （"zero" との挙動差をUIに反映）。
    if (
      a.unknownModelHandling === "warn" &&
      Array.isArray(a.unknownModels) &&
      a.unknownModels.length > 0
    ) {
      models.appendChild(
        el("div", {
          class: "muted",
          text:
            "価格未定義のモデルが " +
            a.unknownModels.length +
            " 件あります（コストは $0 として集計しています）。",
        })
      );
    }
    app.appendChild(models);

    // 日次グラフ
    const chart = section("日次 API換算コスト（直近30日）");
    chart.appendChild(dailyChart(a.daily));
    app.appendChild(chart);

    // 操作
    const actions = el("div", { class: "actions" });
    const refreshBtn = el("button", { text: "再スキャン" });
    refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    const settingsBtn = el("button", { class: "secondary", text: "設定を開く" });
    settingsBtn.addEventListener("click", () =>
      vscode.postMessage({ type: "openSettings" })
    );
    actions.appendChild(refreshBtn);
    actions.appendChild(settingsBtn);
    app.appendChild(actions);

    // フッタ
    const footer = el("div", { class: "footer" });
    footer.appendChild(
      el("div", {
        text:
          "走査: " +
          view.stats.filesScanned +
          " ファイル / 使用記録 " +
          view.stats.usageRecords +
          " 件 / 最終更新 " +
          new Date(view.generatedAt).toLocaleString(),
      })
    );
    app.appendChild(footer);
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "update") {
      try {
        render(msg.view, msg.options);
      } catch (e) {
        const app = document.getElementById("app");
        if (app) app.textContent = "表示の生成中にエラーが発生しました。";
      }
    }
  });

  vscode.postMessage({ type: "ready" });
})();
