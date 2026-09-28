/* 투자 관제탑 — 클라이언트 (암호 해제 · 라우팅 · 화면 렌더) */
(() => {
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LS = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
             set(k, v) { try { localStorage.setItem(k, v); } catch {} },
             del(k) { try { localStorage.removeItem(k); } catch {} } };
let D = null;            // 복호화된 payload
let PW = null;
let selBuy = null, selConv = null, tvSymbol = null, buySort = "score";
const TITLES = { home: "오늘의 관제", buy: "매수자리 점수", conv: "확신 종목 전략", chart: "실시간 차트",
                 macro: "경제 안정성", market: "시장 전체", bear: "하락장 전략실" };

/* ───────── 형식 ───────── */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nf = (v, d = 2) => v == null || isNaN(v) ? "–" : Number(v).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pc = (v, d = 1, sign = true) => v == null || isNaN(v) ? "–" : `${sign && v > 0 ? "+" : ""}${nf(v, d)}%`;
const cls = v => v > 0 ? "up" : v < 0 ? "down" : "";
const usd = v => v == null ? "–" : "$" + nf(v, v >= 1000 ? 0 : 2);
const pill = (txt, tone = "muted") => `<span class="pill ${tone}">${esc(txt)}</span>`;
const sbar = v => `<div class="sbar"><div class="trk"><div class="fil" style="width:${Math.max(0, Math.min(100, v || 0))}%"></div></div><span class="v num">${v ?? "–"}</span></div>`;

/* ───────── 암호 해제 ───────── */
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decrypt(env, pw) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(env.salt), iterations: env.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(env.iv) }, key, b64(env.ct));
  return JSON.parse(new TextDecoder().decode(buf));
}
async function load(pw) {
  const r = await fetch("data.enc.json?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("데이터 파일을 받지 못했습니다 (" + r.status + ")");
  return decrypt(await r.json(), pw);
}
async function unlock(pw, remember) {
  const msg = $("#lockMsg");
  msg.textContent = "여는 중…";
  try {
    D = await load(pw);
    PW = pw;
    if (remember) LS.set("hub_pw", pw); else LS.del("hub_pw");
    $("#lock").hidden = true; $("#app").hidden = false;
    msg.textContent = "";
    boot();
  } catch (e) {
    msg.textContent = e.name === "OperationError" ? "비밀번호가 맞지 않습니다." : (e.message || "열 수 없습니다.");
    LS.del("hub_pw");
  }
}
$("#lockForm").addEventListener("submit", e => { e.preventDefault(); unlock($("#pw").value, $("#remember").checked); });
$("#logoutBtn").addEventListener("click", () => { LS.del("hub_pw"); location.reload(); });
$("#refreshBtn").addEventListener("click", () => refresh(true));

async function refresh(manual) {
  if (!PW) return;
  try {
    const nd = await load(PW);
    const changed = nd.asof !== D.asof;
    D = nd;
    if (changed || manual) render();
  } catch (e) { if (manual) alertTip("새로고침 실패 : " + e.message); }
}
function alertTip(t) { const el = $("#asof"); el.textContent = t; }

/* ───────── 부팅 · 라우팅 ───────── */
let booted = false;
function boot() {
  if (!booted) {
    booted = true;
    window.addEventListener("hashchange", render);
    setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(false); });
    tape();
  }
  render();
}
function page() { const p = (location.hash || "#home").slice(1).split("/")[0]; return TITLES[p] ? p : "home"; }
function render() {
  const p = page();
  $$(".nav nav a").forEach(a => a.classList.toggle("on", a.dataset.page === p));
  $("#crumb").textContent = TITLES[p];
  $("#asof").textContent = "갱신 " + D.asof_kst;
  $("#navAsof").textContent = "데이터 " + D.asof_kst;
  const ageMin = (Date.now() - Date.parse(D.asof.replace(" UTC", "Z").replace(" ", "T"))) / 60000;
  $("#liveDot").classList.toggle("live", ageMin < 90);
  $("#liveDot").title = ageMin < 90 ? "최근 90분 이내 갱신" : "갱신 지연 " + Math.round(ageMin) + "분";
  const v = $("#view");
  v.innerHTML = ({ home, buy, conv, chart, macro, market, bear })[p]();
  $$("table.tbl", v).forEach(t => { if (!t.parentElement.classList.contains("tbl-wrap")) { const w = document.createElement("div"); w.className = "tbl-wrap"; t.replaceWith(w); w.appendChild(t); } });
  after[p] && after[p]();
  window.scrollTo(0, 0);
}
const after = {};

/* ───────── 실시간 시세 띠 (TradingView) ───────── */
function tape() {
  const syms = [["FOREXCOM:SPXUSD", "S&P 500"], ["NASDAQ:QQQ", "나스닥100"], ["TVC:VIX", "VIX"], ["TVC:DXY", "달러지수"],
    ["FX_IDC:USDKRW", "원/달러"], ["TVC:GOLD", "금"], ["TVC:US10Y", "미 10년물"]]
    .concat((D.conviction.rows || []).map(r => [r.tv, r.name]));
  const box = $("#tape");
  box.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
  const s = document.createElement("script");
  s.src = "https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js"; s.async = true;
  s.text = JSON.stringify({ symbols: syms.map(([proName, title]) => ({ proName, title })), showSymbolLogo: false,
    isTransparent: true, displayMode: "compact", colorTheme: "light", locale: "kr" });
  box.firstChild.appendChild(s);
}

/* ───────── 홈 ───────── */
function home() {
  const st = D.stability || {}, cv = D.conviction, b = D.buy.rows, bear = D.bear;
  const sig = cv.rows.filter(r => r.state === "매수 신호" || r.state === "매수존");
  const near = cv.rows.filter(r => r.state === "접근");
  const hold = cv.rows.filter(r => r.holding);
  const top = b.filter(r => r.score >= 75 && r.conf === "높음").slice(0, 6);
  const gateTxt = cv.gate.open ? `열림 · ${cv.gate.run}거래일 유지` : "닫힘 — 신규 매수 금지";
  const stabTone = st.score >= 80 ? "good" : st.score >= 65 ? "info" : st.score >= 50 ? "warn" : "bad";
  const line = [
    `경제 안정성 <b>${nf(st.score, 1)}</b>`,
    `시장 게이트 <b>${cv.gate.open ? "열림" : "닫힘"}</b>`,
    sig.length ? `매수존 <b>${sig.map(r => r.ticker).join("·")}</b>` : near.length ? `매수존 접근 <b>${near.map(r => r.ticker).join("·")}</b>` : "확신 종목 매수존 <b>없음</b>",
    hold.length ? `보유 ${hold.map(r => `${r.ticker} 익절까지 ${pc(r.holding.to_tp)}`).join(", ")}` : "",
  ].filter(Boolean).join(" · ");

  const todo = [];
  cv.rows.forEach(r => {
    if (r.state === "매수 신호") todo.push(["good", "매수 신호", `${r.ticker} ${r.name} — 1차 ${usd(r.plan.t1)} · 2차 ${usd(r.plan.t2)}${r.plan.t3 ? " · 3차 " + usd(r.plan.t3) : " (MRI≥50, 3차 생략)"} · 익절 ${usd(r.plan.tp_if_t1)}`]);
    else if (r.state === "매수존") todo.push(["good", "매수존", `${r.ticker} 매수존(${usd(r.zone)}) 도달 — 양봉·상단 마감 반전 확인 시 신호. 원인 점검 메일 확인`]);
    else if (r.state === "접근") todo.push(["warn", "접근", `${r.ticker} 매수존 ${usd(r.zone)}까지 ${nf(r.dist_atr, 1)} ATR (${pc((r.zone / r.px - 1) * 100)}) — 지정가 준비`]);
    else if (r.state === "실적 전 금지") todo.push(["warn", "실적 전", `${r.ticker} 실적 ${r.next_earn} — 3거래일 전부터 신규 매수 금지`]);
    if (r.holding) todo.push(["info", "보유", `${r.ticker} ${r.holding.shares}주 · 평단 ${usd(r.holding.avg)} · 손익 ${pc(r.holding.pnl)} · 익절가 ${usd(r.holding.tp)} (GTC 지정가 권장)`]);
  });
  if (!cv.gate.open) todo.unshift(["bad", "게이트", "SPY가 200일선 +2% 밴드 아래 — 확신 종목 신규 매수 중단, 대기 자금은 SGOV"]);
  if (!todo.length) todo.push(["muted", "대기", "규칙상 할 일 없음 — 매수존 접근 시 메일·푸시로 통보됩니다"]);

  return `
  <div class="band"><span class="tag">종합</span><div>${line}</div></div>
  <div class="grid g4">
    <div class="card kpi" style="--glow:rgba(14,159,110,.14)"><div class="lab">경제 안정성 (100=안정)</div>
      <div class="val num">${nf(st.score, 1)}<small>/100</small></div>
      <div class="foot2">${pill(stabTone === "good" ? "안정" : stabTone === "info" ? "보통" : stabTone === "warn" ? "경계" : "위험", stabTone)} 12개월 고점 대비 ${nf(st.chg12, 1)}점</div></div>
    <div class="card kpi"><div class="lab">시장 게이트 (SPY 200일선 +2%)</div>
      <div class="val num">${pc(cv.gate.gap)}</div>
      <div class="foot2">${pill(gateTxt, cv.gate.open ? "good" : "bad")}</div></div>
    <div class="card kpi" style="--glow:rgba(199,119,0,.14)"><div class="lab">확신 종목 매수존 · 접근</div>
      <div class="val num">${sig.length}<small>매수존</small> ${near.length}<small>접근</small></div>
      <div class="foot2">MRI ${cv.mri ?? "미연결"} ${cv.mri != null && cv.mri >= 50 ? pill("3차 생략", "warn") : ""}</div></div>
    <div class="card kpi"><div class="lab">시장 폭 (관찰 ${bear.breadth_n} 200일선 위)</div>
      <div class="val num">${nf(bear.breadth, 0)}<small>%</small></div>
      <div class="foot2">VIX ${nf(bear.vix, 1)} · HYG 200일선 ${pc(bear.hyg_gap)}</div></div>
  </div>
  <div class="grid g-72">
    <div class="card"><h2>오늘 할 일</h2><div class="sub">확신 종목 감시 규칙 기준 · 주문은 직접 실행</div>
      <div class="todo">${todo.map(([t, l, x]) => `<div class="it">${pill(l, t)}<div>${esc(x)}</div></div>`).join("")}</div></div>
    <div class="card"><h2>매수자리 상위 (점수 ≥ 75 · 신뢰도 높음)</h2><div class="sub">해당 종목이 같은 상태였던 과거 날의 20일 뒤 성과</div>
      ${top.length ? `<table class="tbl"><thead><tr><th>종목</th><th>점수</th><th>자체 20일 승률</th><th>SPY 대비</th><th>표본</th></tr></thead><tbody>
      ${top.map(r => { const x = r.own || r.analog?.all || {}; return `<tr class="click" onclick="location.hash='buy/${r.t}'"><td><span class="tk">${r.t}</span><span class="nm">${esc(r.name)}</span></td>
      <td class="num">${r.score}</td><td class="num">${nf(x.win20, 1)}%</td><td class="num ${cls(x.ex20)}">${pc(x.ex20, 2)}</td><td class="num">${nf(x.n, 0)}일</td></tr>`; }).join("")}
      </tbody></table>` : `<div class="note">현재 조건을 모두 충족하는 종목이 없습니다.</div>`}</div>
  </div>
  <div class="card"><h2>확신 종목 현황</h2><div class="sub">매수존 = 20일 고점 − 3 ATR · 거리는 ATR 단위</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>종목</th><th class="l">상태</th><th>현재가</th><th>매수존</th><th>거리(ATR)</th><th>다음 실적</th></tr></thead><tbody>
    ${cv.rows.map(r => `<tr class="click" onclick="location.hash='conv/${r.ticker}'"><td><span class="tk">${r.ticker}</span><span class="nm">${esc(r.name)}</span></td>
      <td class="l">${pill(r.state, r.tone)}</td><td class="num">${usd(r.px)}</td><td class="num">${usd(r.zone)}</td>
      <td class="num">${nf(r.dist_atr, 1)}</td><td class="num">${r.next_earn || "–"}</td></tr>`).join("")}
    </tbody></table></div></div>
  <div class="summary"><ul>
    <li>경제 안정성 ${nf(st.score, 1)}점 — 최대 취약 축은 CAPE(${nf(st.axes?.find(a => a.key === "cape")?.raw, 1)}). 과거 백테스트상 점수 자체보다 <b>12개월 고점 대비 급락</b>이 경계 신호.</li>
    <li>매수자리 점수는 두 기간(2013~19·2020~26) 모두 재현된 조건(시장·종목 상승추세 + 2 ATR 이상 눌림)만 반영 — 초과 성과는 20일 +0.3%p 수준으로 작음.</li>
    <li>확신 종목 전략의 과거 신호 ${cv.summary.n}회 중 ${cv.summary.done}회 익절(${nf(cv.summary.win, 1)}%) — 손절이 없는 구조이며 최악 평가손 ${pc(cv.summary.worst_mae)}.</li>
  </ul></div>`;
}

/* ───────── 매수자리 ───────── */
function buy() {
  const rows = [...D.buy.rows];
  const key = { score: r => -(r.score || 0), d1: r => r.d1 || 0, dd52: r => r.dd52 || 0, dist: r => -(r.dist_atr || 0), t: r => r.t };
  rows.sort((a, b) => { const f = key[buySort] || key.score; const x = f(a), y = f(b); return x < y ? -1 : x > y ? 1 : 0; });
  const want = (location.hash.split("/")[1] || "").toUpperCase();
  if (want) selBuy = want;
  if (!selBuy || !rows.find(r => r.t === selBuy)) selBuy = rows[0].t;
  const s = D.buy.stats;
  return `
  <div class="band"><span class="tag">원리</span><div>점수 = 두 기간 모두 재현된 조건의 충족도(0~100). <b>신뢰도</b>는 같은 상태였던 과거 날(24종목·2013~) 의 20일 뒤 성과가 전반·후반 모두 평균을 넘었는지로 판정.</div></div>
  <div class="grid" style="grid-template-columns:minmax(0,1.9fr) minmax(340px,1fr)">
    <div class="card"><h2>관찰 종목 ${rows.length}</h2><div class="sub">행을 누르면 오른쪽에 상세 · 기준일 ${rows[0].asof} 종가 (장중가는 참고)</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr>
        <th class="sort" data-s="t">종목</th><th class="sort" data-s="score">점수</th><th class="l">판정</th><th class="l">신뢰도</th>
        <th>현재가</th><th class="sort" data-s="d1">1일</th><th class="sort" data-s="dd52">52주 고점比</th><th class="sort" data-s="dist">눌림(ATR)</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="click ${r.t === selBuy ? "sel" : ""}" data-t="${r.t}">
        <td><span class="tk">${r.t}</span><span class="nm">${esc(r.name)}</span>${r.group === "conviction" ? ' <span class="pill info" style="padding:0 6px">확신</span>' : ""}</td>
        <td>${sbar(r.score)}</td><td class="l">${pill(r.grade, r.tone)}</td><td class="l">${pill(r.conf, r.conf_tone)}</td>
        <td class="num">${usd(r.live || r.close)}</td><td class="num ${cls(r.d1)}">${pc(r.d1)}</td>
        <td class="num ${cls(r.dd52)}">${pc(r.dd52)}</td><td class="num">${nf(r.dist_atr, 1)}</td></tr>`).join("")}
      </tbody></table></div></div>
    <div class="card" id="buyDetail">${buyDetail(rows.find(r => r.t === selBuy))}</div>
  </div>
  <div class="card"><h2>점수는 실제로 맞았나 — 점수대별 20일 뒤 성과</h2>
    <div class="sub">표본 ${s.start} ~ ${s.end} · 초과(%p) = 같은 기간 전체 평균 대비 SPY 초과수익 차이 · 전반 2013~2019 / 후반 ${s.split.slice(0, 4)}~</div>
    <div class="grid g2">
      <div id="bucketChart"></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>점수대</th><th>표본(일)</th><th>20일 승률</th><th>+5% 익절 선도달</th><th>전반 초과</th><th>후반 초과</th></tr></thead><tbody>
      ${s.buckets.map(b => `<tr><td>${b.range}</td><td class="num">${nf(b.all.n, 0)}</td><td class="num">${nf(b.all.win20, 1)}%</td><td class="num">${nf(b.all.tp_rate, 1)}%</td>
        <td class="num ${cls(b.is.edge)}">${pc(b.is.edge, 2)}p</td><td class="num ${cls(b.oos.edge)}">${pc(b.oos.edge, 2)}p</td></tr>`).join("")}
      <tr><td class="muted">전체</td><td class="num">${nf(s.base.all.n, 0)}</td><td class="num">${nf(s.base.all.win20, 1)}%</td><td class="num">${nf(s.base.all.tp_rate, 1)}%</td><td></td><td></td></tr>
      </tbody></table></div>
    </div>
    <div class="note" style="margin-top:12px"><b>판독</b> · 점수대 간 차이는 20일 기준 ±0.3%p 안팎으로 작고, 순위 상관(전반 ${s.mono_is ?? "–"} · 후반 ${s.mono_oos ?? "–"})도 약합니다.
    전체 평균 승률 ${nf(s.base.all.win20, 1)}%가 높은 것은 <b>오늘 살아남은 우량주를 골라 과거를 본 효과(생존 편향)</b>가 큽니다. 기술적 자리는 수익의 원천이 아니라 <b>진입 규율</b>이며, 성과는 종목 선택과 보유 규칙이 좌우합니다.</div>
  </div>`;
}
function buyDetail(r) {
  if (!r) return "";
  const a = r.analog, own = r.own;
  const comp = D.buy.components.map(([k, n, mx]) => `<div class="comp"><span>${n}</span><div class="trk"><div class="fil ${r.comp[k] ? "" : "zero"}" style="width:${(r.comp[k] || 0) / mx * 100}%"></div></div><span class="num">${r.comp[k]}/${mx}</span></div>`).join("");
  const arow = (lab, x) => x && x.n ? `<tr><td>${lab}</td><td class="num">${nf(x.n, 0)}</td><td class="num">${nf(x.win20, 1)}%</td><td class="num ${cls(x.avg20)}">${pc(x.avg20, 2)}</td><td class="num ${cls(x.ex20)}">${pc(x.ex20, 2)}</td><td class="num">${nf(x.tp_rate, 1)}%</td></tr>` : "";
  return `<div class="hd" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h2>${r.t} <span class="nm">${esc(r.name)}</span></h2>${pill(r.grade, r.tone)}</div>
  <div class="sub">점수 ${r.score} · 상태 <b>${esc(r.state)}</b> · RSI(2) ${r.rsi2} · 200일선 ${usd(r.ma200)}</div>
  <div id="buyChart" class="chart sm"></div>
  <h3>점수 구성</h3>${comp}
  <h3>같은 상태였던 과거 (20일 뒤) — 신뢰도 ${pill(r.conf, r.conf_tone)}</h3>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>구분</th><th>표본</th><th>승률</th><th>평균</th><th>SPY 대비</th><th>+5% 선도달</th></tr></thead><tbody>
  ${arow("24종목 전체", a?.all)}${arow("전반 2013~19", a?.is)}${arow("후반 2020~", a?.oos)}${arow(r.t + " 자체", own)}
  </tbody></table></div>
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn small" onclick="location.hash='chart/${r.t}'">실시간 차트</button>
  ${r.group === "conviction" ? `<button class="btn small" onclick="location.hash='conv/${r.t}'">매수존 전략 보기</button>` : ""}</div>`;
}
after.buy = () => {
  $$("#view tr[data-t]").forEach(tr => tr.addEventListener("click", () => {
    selBuy = tr.dataset.t; history.replaceState(null, "", "#buy/" + selBuy);
    $$("#view tr[data-t]").forEach(x => x.classList.toggle("sel", x === tr));
    $("#buyDetail").innerHTML = buyDetail(D.buy.rows.find(r => r.t === selBuy)); drawBuyChart();
  }));
  $$("#view th.sort").forEach(th => th.addEventListener("click", () => { buySort = th.dataset.s; render(); }));
  drawBuyChart();
  const s = D.buy.stats;
  $("#bucketChart").innerHTML = barPairs(s.buckets.map(b => [b.range, b.is.edge, b.oos.edge]), ["전반 2013~19", "후반 2020~"], "%p");
};
function drawBuyChart() {
  const r = D.buy.rows.find(x => x.t === selBuy);
  candle($("#buyChart"), r.ohlc, [{ data: r.ma200s, color: "#7a859c", title: "200일선" }], []);
}

/* ───────── 확신 종목 ───────── */
function conv() {
  const cv = D.conviction;
  const want = (location.hash.split("/")[1] || "").toUpperCase();
  if (want) selConv = want;
  if (!selConv || !cv.rows.find(r => r.ticker === selConv)) selConv = cv.rows[0]?.ticker;
  const r = cv.rows.find(x => x.ticker === selConv);
  const sm = cv.summary;
  return `
  <div class="band"><span class="tag">규칙</span><div>종가 > 200일선 · <b>20일 고점 − 3 ATR</b> 매수존 · 양봉 상단 마감 반전 확인 · SPY 200일선 +2% 밴드 20거래일 유지 ·
    분할 1차/−1.5 ATR/−3 ATR · 익절 평단 + 3 ATR(5~10%) 전량 · 손절 없음(논지 붕괴 시 재량)</div></div>
  <div class="grid g4">
    <div class="card kpi"><div class="lab">시장 게이트</div><div class="val">${cv.gate.open ? "열림" : "닫힘"}</div><div class="foot2">SPY 200일선 ${pc(cv.gate.gap)} · ${cv.gate.run}거래일</div></div>
    <div class="card kpi" style="--glow:rgba(14,159,110,.14)"><div class="lab">과거 신호 익절 비율 (8종목·2016~)</div><div class="val num">${nf(sm.win, 1)}<small>%</small></div><div class="foot2">${sm.done}/${sm.n}회 · 손절 없는 구조의 결과</div></div>
    <div class="card kpi" style="--glow:rgba(196,43,58,.14)"><div class="lab">보유 중 최악 평가손</div><div class="val num down">${pc(sm.worst_mae)}</div><div class="foot2">최장 보유 ${sm.max_days}거래일</div></div>
    <div class="card kpi"><div class="lab">장부 연동</div><div class="val" style="font-size:20px;margin-top:10px">${cv.linked ? "연결됨" : "미연결"}</div><div class="foot2">${cv.linked ? "확신 종목 감시 장부 기준 익절가" : "읽기 토큰 등록 시 보유·MRI 자동 반영"}</div></div>
  </div>
  <div class="grid g4">${cv.rows.map(c => convCard(c)).join("")}</div>
  ${r ? `<div class="grid g-72">
    <div class="card"><h2>${r.ticker} ${esc(r.name)} — 매수존 차트</h2><div class="sub">녹색 선 = 매수존(20일 고점 − 3 ATR) · 회색 = 200일선${r.holding ? " · 빨강 = 익절가" : ""}</div>
      <div id="convChart" class="chart"></div></div>
    <div class="card"><h2>과거 동일 신호 (${r.past.n}회)</h2><div class="sub">신호일 종가 진입 → 익절가 도달까지 · MAE = 보유 중 최대 평가손</div>
      <dl class="kv"><dt>익절 도달</dt><dd>${r.past.n_done}/${r.past.n} (${nf(r.past.win_rate, 1)}%)</dd><dt>중앙 보유일</dt><dd>${r.past.med_days ?? "–"}거래일</dd>
      <dt>최장 보유</dt><dd>${r.past.max_days ?? "–"}거래일</dd><dt>중앙 MAE</dt><dd class="down">${pc(r.past.med_mae)}</dd><dt>최악 MAE</dt><dd class="down">${pc(r.past.worst_mae)}</dd></dl>
      <div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>신호일</th><th>진입</th><th>익절가</th><th>일수</th><th>MAE</th></tr></thead><tbody>
      ${r.past.trades.slice().reverse().map(t => `<tr><td class="num">${t.date}</td><td class="num">${usd(t.entry)}</td><td class="num">${t.done ? usd(t.tp) : pill("미도달", "warn")}</td><td class="num">${t.days}</td><td class="num down">${pc(t.mae)}</td></tr>`).join("")}
      </tbody></table></div></div>
  </div>` : ""}
  <div class="card"><h2>전략 백테스트 (확신 종목 감시 설명서 기준 · 세전)</h2><div class="sub">사후 선정 편향을 걷어낸 무작위 표본이 현실적 기대치</div>
    <table class="tbl"><thead><tr><th>구분</th><th>연 수익률</th><th>최대 낙폭</th><th>샤프</th></tr></thead><tbody>
    ${cv.backtest_ref.map(b => `<tr><td>${esc(b.case)}</td><td class="num up">${nf(b.cagr, 1)}%</td><td class="num down">${nf(b.mdd, 1)}%</td><td class="num">${b.sharpe ?? "–"}</td></tr>`).join("")}
    </tbody></table>
    <div class="note" style="margin-top:12px"><b>「승률 98%·연 30%」 점검</b> · 익절 비율이 90% 후반인 것은 사실이나, <b>손절이 없어 손실 거래가 「미실현」으로 남는 구조</b>이기 때문입니다.
    같은 기간 보유 중 −40~−88% 평가손, 최장 ${sm.max_days}거래일 묶임 사례가 있습니다. 연 수익률은 사후 선정 8종목 22.3%, 무작위 표본 14~16%가 현실적 범위입니다.</div>
  </div>`;
}
function convCard(c) {
  const d = Math.max(-1, Math.min(5, c.dist_atr));
  const pos = (d + 1) / 6 * 100;
  const pl = c.plan;
  return `<div class="card cc ${c.tone === "good" ? "good" : c.tone === "warn" ? "warn" : ""}" onclick="location.hash='conv/${c.ticker}'" style="cursor:pointer">
    <div class="hd"><div><span class="tk">${c.ticker}</span><span class="nm">${esc(c.name)}</span></div>${pill(c.state, c.tone)}</div>
    <div class="px num">${usd(c.px)}</div>
    <div class="dist"><div class="rail"></div><div class="mk" style="left:${pos}%"></div></div>
    <div class="distlbl"><span style="left:0">← 매수존</span><span style="left:41.7%">1.5 ATR</span><span style="left:100%">5 ATR</span></div>
    <dl class="kv"><dt>매수존</dt><dd class="num">${usd(c.zone)} (${nf(c.dist_atr, 1)} ATR)</dd>
    <dt>200일선</dt><dd class="num">${usd(c.ma200)} ${c.up ? "" : pill("하회", "bad")}</dd><dt>다음 실적</dt><dd class="num">${c.next_earn || "–"}</dd>
    ${c.cap_pct ? `<dt>비중 한도</dt><dd>총자산 ${c.cap_pct}%</dd>` : ""}</dl>
    ${c.holding ? `<div class="tranche" style="grid-template-columns:repeat(3,1fr)"><div>보유<b class="num">${c.holding.shares}주</b></div><div>손익<b class="num ${cls(c.holding.pnl)}">${pc(c.holding.pnl)}</b></div><div>익절가<b class="num">${usd(c.holding.tp)}</b></div></div>`
      : pl ? `<div class="tranche"><div>1차<b class="num">${usd(pl.t1)}</b></div><div>2차<b class="num">${usd(pl.t2)}</b></div><div>3차<b class="num">${pl.t3 ? usd(pl.t3) : "생략"}</b></div><div>익절<b class="num">${usd(pl.tp_if_t1)}</b></div></div>` : ""}
  </div>`;
}
after.conv = () => {
  const r = D.conviction.rows.find(x => x.ticker === selConv);
  if (!r) return;
  const b = D.buy.rows.find(x => x.t === r.ticker);
  const lines = [{ data: r.zone_series, color: "#0e9f6e", title: "매수존" }];
  if (b) lines.push({ data: b.ma200s, color: "#7a859c", title: "200일선" });
  const pl = r.holding ? [{ price: r.holding.tp, color: "#d6303a", title: "익절가" }, { price: r.holding.avg, color: "#1d4ed8", title: "평단" }] : [];
  candle($("#convChart"), b ? b.ohlc.slice(-130) : [], lines, pl);
};

/* ───────── 실시간 차트 ───────── */
function chart() {
  const want = (location.hash.split("/")[1] || "").toUpperCase();
  const all = D.buy.rows;
  const f = all.find(r => r.t === want);
  tvSymbol = f ? f.tv : (tvSymbol || all.find(r => r.t === "GOOGL")?.tv || "NASDAQ:GOOGL");
  const chips = [["AMEX:SPY", "SPY"], ["NASDAQ:QQQ", "QQQ"], ["TVC:VIX", "VIX"]].concat(all.map(r => [r.tv, r.t]));
  return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
    <div><h2>실시간 차트</h2><div class="sub" style="margin:0">TradingView · 지표·그리기 도구는 차트 상단 메뉴</div></div>
    <div class="seg" id="tvSeg">${chips.map(([s, l]) => `<button data-s="${s}" class="${s === tvSymbol ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div id="tv" class="tv"></div></div>`;
}
after.chart = () => {
  $$("#tvSeg button").forEach(b => b.addEventListener("click", () => { tvSymbol = b.dataset.s; $$("#tvSeg button").forEach(x => x.classList.toggle("on", x === b)); tvWidget(); }));
  tvWidget();
};
function tvWidget() {
  const box = $("#tv");
  box.innerHTML = '<div class="tradingview-widget-container" style="height:100%;width:100%"><div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div></div>';
  const s = document.createElement("script");
  s.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"; s.async = true;
  s.text = JSON.stringify({ autosize: true, symbol: tvSymbol, interval: "D", timezone: "Asia/Seoul", theme: "light", style: "1",
    locale: "kr", allow_symbol_change: true, calendar: false, hide_volume: false,
    studies: ["STD;SMA", "STD;RSI"], support_host: "https://www.tradingview.com" });
  box.firstChild.appendChild(s);
}

/* ───────── 경제 안정성 ───────── */
function macro() {
  const st = D.stability, m = D.market || {};
  if (!st || !st.score) return `<div class="card">경제 지표를 받지 못했습니다.</div>`;
  const bt = st.bt;
  const ro = m.rate_odds;
  return `
  <div class="band"><span class="tag">판독</span><div>경제 안정성 <b>${nf(st.score, 1)}</b>점 (CAPE 제외 시 ${nf(st.score_ex_cape, 1)}) · 12개월 고점 대비 <b>${nf(st.chg12, 1)}</b>점 ·
    뉴욕연준 침체확률 ${nf(st.recession_prob, 1)}% (${st.recession_target} 시점) · 관제실 공식값 ${st.official ?? "–"}</div></div>
  <div class="grid g-72">
    <div class="card"><h2>1990년 이후 월별 안정성 점수</h2><div class="sub">빨간 점선 = 주요 급락 정점 · 녹색 띠 80점↑ · 주황 띠 60~80점 · 관제실 7축 산식 재현(발표 시차 반영)</div>
      <div id="stabChart"></div></div>
    <div class="card"><h2>7개 축</h2><div class="sub">각 축 0~100 (100 = 안정) · 단순 평균</div>
      ${st.axes.map(a => `<div class="comp" title="${esc(a.range)}"><span>${esc(a.name)}</span><div class="trk"><div class="fil" style="width:${a.score || 0}%;background:${a.score < 30 ? "var(--bad)" : a.score < 60 ? "var(--warn)" : "var(--blue)"}"></div></div><span class="num">${nf(a.score, 0)}</span></div>
      <div class="muted small" style="margin:-4px 0 6px 0">현재 ${nf(a.raw, 2)} · ${esc(a.range)}</div>`).join("")}
    </div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>점수대별 이후 12개월 (1990~ · ${bt.base.n}개월)</h2><div class="sub">급락 = 이후 12개월 중 S&P500 −15% 이상 하락 · 침체 = 12개월 내 NBER 침체 시작</div>
      <table class="tbl"><thead><tr><th>점수대</th><th>개월</th><th>−15% 급락</th><th>−25% 급락</th><th>평균 최대낙폭</th><th>12개월 수익</th><th>침체 진입</th></tr></thead><tbody>
      ${bt.buckets.map(b => `<tr><td>${b.range}</td><td class="num">${b.n}</td><td class="num">${nf(b.p_dd15, 1)}%</td><td class="num">${nf(b.p_dd25, 1)}%</td><td class="num down">${nf(b.avg_dd, 1)}%</td><td class="num ${cls(b.avg_ret)}">${pc(b.avg_ret)}</td><td class="num">${nf(b.p_rec, 1)}%</td></tr>`).join("")}
      <tr><td class="muted">전체</td><td class="num">${bt.base.n}</td><td class="num">${nf(bt.base.p_dd15, 1)}%</td><td></td><td></td><td class="num">${pc(bt.base.avg_ret)}</td><td></td></tr></tbody></table>
      <div class="note" style="margin-top:10px"><b>판독</b> · 80점 이상은 급락 확률이 낮지만, <b>위험은 60~80점 「중간」 구간에 몰려</b> 있습니다. 점수가 가장 낮을 때는 이미 폭락이 진행된 뒤라 이후 수익이 오히려 좋았습니다 — 동행 지표 성격. 점수 수준만으로 매도 판단은 금물.</div></div>
    <div class="card"><h2>악화 속도가 더 중요</h2><div class="sub">12개월 고점 대비 점수 하락폭별 이후 12개월 −15% 급락 확률</div>
      <div id="chgChart"></div>
      <table class="tbl"><thead><tr><th>12개월 고점 대비</th><th>개월</th><th>−15% 급락</th><th>평균 최대낙폭</th></tr></thead><tbody>
      ${st.bt_chg.map(b => `<tr><td>${b.label}</td><td class="num">${b.n}</td><td class="num">${nf(b.p_dd15, 1)}%</td><td class="num down">${nf(b.avg_dd, 1)}%</td></tr>`).join("")}</tbody></table>
      <div class="note" style="margin-top:10px">현재 <b>${nf(st.chg12, 1)}점</b> — ${st.chg12 <= -15 ? "급격한 악화 구간 (역사적 급락 확률 최고)" : st.chg12 <= -8 ? "악화 진행 — 신규 매수 규모 축소 검토" : "고점 부근 유지 — 거시발 급락 신호 없음"}</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>과거 급락 직전 점수</h2><div class="sub">정점 월 점수와 직전 12개월 최저·평균</div>
      <table class="tbl"><thead><tr><th>사건</th><th>정점</th><th>정점 점수</th><th>12개월 최저</th><th>12개월 평균</th></tr></thead><tbody>
      ${st.crisis.map(c => `<tr><td>${esc(c.event)}</td><td class="num">${c.peak}</td><td class="num">${nf(c.at_peak, 1)}</td><td class="num">${nf(c.min_12m, 1)}</td><td class="num">${nf(c.avg_12m, 1)}</td></tr>`).join("")}</tbody></table>
      <div class="note" style="margin-top:10px">2015·2018 급락은 80점대에서 발생 — 이 점수는 <b>경기 침체형</b> 하락은 잡지만 <b>밸류에이션·유동성 충격형</b>은 못 잡습니다. 시장위험레이더 MRI(${D.conviction.mri ?? "미연결"})를 함께 보십시오.</div></div>
    <div class="card"><h2>금리 · 일정</h2><div class="sub">${ro ? esc(ro.meeting) : ""} · 연방기금 선물 내재</div>
      ${ro ? ro.outcomes.map(o => `<div class="comp"><span>${esc(o.label)}</span><div class="trk"><div class="fil" style="width:${o.prob}%"></div></div><span class="num">${o.prob}%</span></div>`).join("") : ""}
      <h3>다가오는 이벤트</h3>
      <div class="todo">${(m.events || []).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") && e.date >= new Date().toISOString().slice(0, 10)).slice(0, 6).map(e => `<div class="it">${pill(e.date.slice(5), "info")}<div><b>${esc(e.name)}</b><div class="muted small">${esc(e.why || "")}</div></div></div>`).join("") || '<div class="muted">예정 이벤트 없음</div>'}</div></div>
  </div>`;
}
after.macro = () => {
  const st = D.stability;
  if (!st || !st.history) return;
  const pts = st.history.filter(x => x[1] != null).map(([d, v]) => [Date.parse(d + "-15"), v]);
  const marks = st.crisis.map(c => [Date.parse(c.peak + "-15"), c.event.split(" ")[0]]);
  $("#stabChart").innerHTML = lineChart(pts, { h: 300, y0: 30, y1: 100, bands: [[80, 100, "rgba(14,159,110,.07)"], [60, 80, "rgba(199,119,0,.06)"]], marks, fmt: v => nf(v, 1) + "점", color: "#1d4ed8" });
  bindLine($("#stabChart"));
  $("#chgChart").innerHTML = barPairs(st.bt_chg.map(b => [b.label, b.p_dd15, null]), ["−15% 급락 확률"], "%", true);
};

/* ───────── 시장 전체 ───────── */
function market() {
  const g = (D.market || {}).groups;
  if (!g) return `<div class="card">시장 데이터를 받지 못했습니다 (관제실 payload).</div>`;
  const names = { indices: "주요 지수", sectors_us: "미국 섹터", commodities: "원자재", fx_rates: "환율·금리", sectors_kr: "국내 섹터", realestate: "부동산·리츠" };
  const c = D.market.concentration;
  return `${c ? `<div class="band"><span class="tag">쏠림</span><div>SPY−RSP 12개월 수익 차 <b>${nf(c.last, 2)}%p</b> (역사적 ${nf(c.pctile, 0)} 백분위 · ${esc(c.level)}) — ${esc(c.comment)}</div></div>` : ""}
  <div class="grid g2">${Object.entries(names).filter(([k]) => g[k]).map(([k, n]) => `<div class="card"><h2>${n}</h2><div class="sub">관제실 수집 · 종가 기준</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>항목</th><th>현재</th><th>1일</th><th>1주</th><th>1개월</th><th>연초 대비</th><th>60일</th></tr></thead><tbody>
    ${g[k].map(x => `<tr><td>${esc(x.name)}</td><td class="num">${nf(x.last, x.last > 1000 ? 0 : 2)}</td><td class="num ${cls(x.chg?.d1)}">${pc(x.chg?.d1)}</td><td class="num ${cls(x.chg?.w1)}">${pc(x.chg?.w1)}</td>
      <td class="num ${cls(x.chg?.m1)}">${pc(x.chg?.m1)}</td><td class="num ${cls(x.ytd)}">${pc(x.ytd)}</td><td>${spark(x.spark)}</td></tr>`).join("")}
    </tbody></table></div></div>`).join("")}</div>`;
}

/* ───────── 하락장 전략실 ───────── */
function bear() {
  const b = D.bear, cv = D.conviction, st = D.stability || {};
  const regime = b.spy_gap < 0 ? ["약세 (SPY 200일선 아래)", "bad"] : b.spy_gap < 2 ? ["경계 (200일선 +2% 이내)", "warn"] : ["강세 (200일선 +2% 위)", "good"];
  const cands = [
    { name: "롱-현금 전환 (200일선 ±1% 버퍼)", ev: 3, status: ["검증 완료 · 채택", "good"],
      why: "S&P500 76년 : CAGR 8.55→8.73%, 최대낙폭 −56.8→−21.1%. 하락장에서 「버는」 전략이 아니라 「잃지 않는」 전략. 확신 종목 게이트와 같은 원리",
      now: b.spy_gap < 0 ? "지금 발동 — 대기 자금 SGOV" : `미발동 (SPY 200일선 ${pc(b.spy_gap)})` },
    { name: "매수존 대기 중 현금담보 풋 매도", ev: 2, status: ["검증 완료 · 기각", "bad"],
      why: "2007~2026 8종목 검증 : 연 18.5% vs 기준 19.35% (개선 없음). 2020 급락 −24% vs 기준 −4.8% — 반전 확인 없이 떨어지는 칼날을 받음. 실제 풋 매도 지수도 하락장 5회 모두 손실",
      now: "아래 검증표 참조" },
    { name: "보유 중 익절가 콜 매도 (휠)", ev: 1, status: ["보류", "warn"],
      why: "내재변동성이 실현변동성보다 10% 이상 높을 때만 연 +1.7%p. 가정 의존도가 커 실제 옵션 호가로 모의 운용 후 재판단",
      now: "익절 지정가(GTC) 방식 유지" },
    { name: "추세추종(매니지드 퓨처스)·금 분산", ev: 2, status: ["검증 예정", "info"],
      why: "2022년처럼 주식·채권 동반 하락 때 DBMF·KMLM류가 플러스를 낸 사례. 주식 롱 전략과 상관이 낮아 포트폴리오 낙폭 완충",
      now: "ETF 상장 이력이 짧아 SG CTA 지수로 근사 검증 필요" },
    { name: "공포 극단 역발상 매수", ev: 2, status: ["부분 채택", "warn"],
      why: "심리-타이밍 엔진 검증 : 공포 게이지는 비중 조절엔 손해, 「재진입 시점」으로만 +0.85%p. MRI 85↑는 역사적으로 패닉 바닥 동반",
      now: `VIX ${nf(b.vix, 1)} — ${b.vix >= 32 ? "공포 극단권" : b.vix >= 25 ? "공포 확대" : "평온"}` },
    { name: "지수 숏·인버스·풋 매수·추세 숏", ev: 0, status: ["기각 (516개 변형)", "bad"],
      why: "76년간 숏 기여가 플러스인 10년 구간 0개. 하락장 구간만 자르면 +70%지만 그 구간을 사전에 아는 방법이 없음 — 나머지 86% 기간에서 −97%",
      now: "사용하지 않음" },
  ];
  return `
  <div class="band"><span class="tag">현재 체제</span><div>${pill(regime[0], regime[1])} · QQQ 200일선 ${pc(b.qqq_gap)} · 하이일드(HYG) ${pc(b.hyg_gap)} · VIX ${nf(b.vix, 1)} · 관찰 종목 ${b.breadth_n} 200일선 위 · 경제 안정성 ${nf(st.score, 1)}</div></div>
  <div class="grid g-72">
    <div class="card"><h2>S&P500 ETF(SPY) · 200일선</h2><div class="sub">200일선 아래 = 확신 종목 신규 매수 중단 · 롱-현금 전환 구간</div><div id="bearChart" class="chart"></div></div>
    <div class="card"><h2>하락장에서 할 수 있는 것 — 같이 고민할 목록</h2><div class="sub">근거 막대 ■ = 실증 강도 · 상태는 우리 검증 기준</div>
      <div class="strat">${cands.map(c => `<div class="note" style="border-style:solid;background:var(--surface)"><div class="hd"><b>${esc(c.name)}</b>${pill(c.status[0], c.status[1])}</div>
        <div class="ev" title="근거 강도">${[1, 2, 3].map(i => `<i class="${i <= c.ev ? "on" : ""}"></i>`).join("")}</div>
        <div style="margin:6px 0 4px">${esc(c.why)}</div><div class="muted small">지금 : ${esc(c.now)}</div></div>`).join("")}</div></div>
  </div>
  <div class="summary"><ul>
    <li>하락장 「수익」의 현실적 원천은 ① 현금 전환으로 낙폭을 피한 뒤 ② 바닥권에서 더 싸게 사는 것 ③ 변동성 프리미엄(풋 매도) — 방향 베팅(숏)은 검증상 기각.</li>
    <li>풋 매도 검증(2026-09-28) 결과 하락장 수익 수단으로는 기각 — 프리미엄은 폭락 위험의 대가이며, 기존 「반전 확인 후 매수」 규칙이 급락장에서 훨씬 방어적.</li>
  </ul></div>
  ${putStudy()}`;
}
function putStudy() {
  const ps = D.put_study; if (!ps) return "";
  const tone = v => v == null ? "" : cls(v);
  return `<div class="card"><h2>풋 매도 백테스트 — 확신 종목 매수존 결합 (${ps.asof})</h2><div class="sub">${esc(ps.setup)}</div>
    <div class="note" style="margin-bottom:12px"><b>모형 검증</b> · ${esc(ps.validation)}</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>전략</th><th>연 수익률</th><th>최대 낙폭</th><th>2008 위기</th><th>2018 4Q</th><th>2020 코로나</th><th>2022 긴축</th><th class="l">판정</th></tr></thead><tbody>
    ${ps.rows.map(r => `<tr><td><b>${r.k}</b> ${esc(r.name)}</td><td class="num">${nf(r.cagr, 2)}%</td><td class="num down">${nf(r.mdd, 1)}%</td>
      <td class="num ${tone(r.p2008)}">${pc(r.p2008)}</td><td class="num ${tone(r.p2018)}">${pc(r.p2018)}</td><td class="num ${tone(r.p2020)}">${pc(r.p2020)}</td><td class="num ${tone(r.p2022)}">${pc(r.p2022)}</td>
      <td class="l">${pill(r.verdict[0], r.verdict[1])}</td></tr>`).join("")}</tbody></table></div>
    <div class="grid g2" style="margin-top:14px">
      <div><h3>내재변동성 가정별 연 수익률 (기준 A ${ps.sens.A}%)</h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>IV = 실현변동성 ×</th>${ps.sens.mults.map(m => `<th>${m}</th>`).join("")}</tr></thead><tbody>
        ${["B", "D", "G"].map(k => `<tr><td>${k}</td>${ps.sens[k].map(v => `<td class="num ${v != null && v > ps.sens.A ? "up" : ""}">${v == null ? "–" : nf(v, 2) + "%"}</td>`).join("")}</tr>`).join("")}
        </tbody></table></div><div class="muted small" style="margin-top:6px">개별주 옵션은 지수보다 변동성 프리미엄이 작다는 실증이 다수 → ×1.0~1.1 이 현실적 범위</div></div>
      <div><h3>실제 지수 : Cboe 풋 매도(PUT) vs S&P500 총수익</h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>하락장</th><th>풋 매도</th><th>S&P500</th></tr></thead><tbody>
        ${ps.index.rows.map(r => `<tr><td>${esc(r[0])}</td><td class="num down">${pc(r[1])}</td><td class="num down">${pc(r[2])}</td></tr>`).join("")}</tbody></table></div>
        <div class="muted small" style="margin-top:6px">${esc(ps.index.long)}</div></div>
    </div>
    <div class="summary" style="margin-top:14px"><ul>${ps.conclusion.map(c => `<li>${esc(c)}</li>`).join("")}</ul></div></div>`;
}
after.bear = () => {
  const b = D.bear;
  const ohlc = b.spy_series.map(([d, v]) => [d, v, v, v, v]);
  candle($("#bearChart"), ohlc, [{ data: b.spy_ma200, color: "#c77700", title: "200일선" }], [], true);
};

/* ───────── 차트 도구 ───────── */
const charts = [];
function candle(el, ohlc, lines, plines, lineOnly) {
  if (!el) return;
  if (!window.LightweightCharts) { setTimeout(() => candle(el, ohlc, lines, plines, lineOnly), 300); return; }
  el.innerHTML = "";
  const ch = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: "transparent" }, textColor: "#7a859c", fontFamily: "Noto Sans KR" },
    grid: { vertLines: { visible: false }, horzLines: { color: "#eef1f6" } }, rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false }, crosshair: { mode: 0 }, localization: { locale: "ko-KR" } });
  let main;
  if (lineOnly) {
    main = ch.addLineSeries({ color: "#1d4ed8", lineWidth: 2, priceLineVisible: false });
    main.setData(ohlc.map(([t, , , , c]) => ({ time: t, value: c })));
  } else {
    main = ch.addCandlestickSeries({ upColor: "#d6303a", downColor: "#1f5fd6", borderVisible: false, wickUpColor: "#d6303a", wickDownColor: "#1f5fd6", priceLineVisible: false });
    main.setData(ohlc.filter(x => x[4] != null).map(([t, o, h, l, c]) => ({ time: t, open: o, high: h, low: l, close: c })));
  }
  const t0 = ohlc.length ? ohlc[0][0] : "0";
  lines.forEach(L => { const s = ch.addLineSeries({ color: L.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: L.title });
    s.setData((L.data || []).filter(([d, v]) => v != null && d >= t0).map(([d, v]) => ({ time: d, value: v }))); });
  plines.forEach(p => main.createPriceLine({ price: p.price, color: p.color, lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: p.title }));
  ch.timeScale().fitContent();
}
function spark(v) {
  if (!v || v.length < 2) return "";
  const w = 90, h = 24, mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1;
  const p = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (y - mn) / r * (h - 4)).toFixed(1)}`).join(" ");
  const col = v[v.length - 1] >= v[0] ? "#d6303a" : "#1f5fd6";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${p}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}
function lineChart(pts, o) {
  const W = 900, H = o.h || 240, L = 36, R = 10, T = 10, B = 24;
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
  const X = x => L + (x - x0) / (x1 - x0) * (W - L - R), Y = y => T + (1 - (y - o.y0) / (o.y1 - o.y0)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" data-pts='${JSON.stringify(pts.map(p => [p[0], p[1]]))}' data-cfg='${JSON.stringify({ L, R, T, B, W, H, x0, x1, y0: o.y0, y1: o.y1 })}'>`;
  (o.bands || []).forEach(([a, b, c]) => s += `<rect x="${L}" y="${Y(b)}" width="${W - L - R}" height="${Y(a) - Y(b)}" fill="${c}"/>`);
  for (let v = o.y0; v <= o.y1; v += 10) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eef1f6"/><text x="${L - 6}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#7a859c">${v}</text>`;
  const yrs = []; for (let y = new Date(x0).getFullYear() + 1; y <= new Date(x1).getFullYear(); y += 5) yrs.push(y);
  yrs.forEach(y => { const x = X(Date.parse(y + "-01-01")); s += `<text x="${x}" y="${H - 6}" font-size="11" text-anchor="middle" fill="#7a859c">${y}</text>`; });
  (o.marks || []).forEach(([t, lab]) => { const x = X(t); s += `<line x1="${x}" x2="${x}" y1="${T}" y2="${H - B}" stroke="#c42b3a" stroke-dasharray="3 3" opacity=".5"/><text x="${x + 3}" y="${T + 10}" font-size="10" fill="#c42b3a">${lab}</text>`; });
  s += `<polyline points="${pts.map(p => X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join(" ")}" fill="none" stroke="${o.color}" stroke-width="2" stroke-linejoin="round"/>`;
  const lp = pts[pts.length - 1]; s += `<circle cx="${X(lp[0])}" cy="${Y(lp[1])}" r="4.5" fill="${o.color}" stroke="#fff" stroke-width="2"/>`;
  s += `<line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#141b2d" opacity="0"/><circle class="xd" r="4" fill="${o.color}" stroke="#fff" stroke-width="2" opacity="0"/>`;
  return s + `</svg>`;
}
function bindLine(box) {
  const svg = box.querySelector("svg"); if (!svg) return;
  const pts = JSON.parse(svg.dataset.pts), c = JSON.parse(svg.dataset.cfg), tip = $("#tip");
  const X = x => c.L + (x - c.x0) / (c.x1 - c.x0) * (c.W - c.L - c.R), Y = y => c.T + (1 - (y - c.y0) / (c.y1 - c.y0)) * (c.H - c.T - c.B);
  svg.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * c.W;
    const t = c.x0 + (vx - c.L) / (c.W - c.L - c.R) * (c.x1 - c.x0);
    let best = pts[0]; for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const xh = svg.querySelector(".xh"), xd = svg.querySelector(".xd");
    xh.setAttribute("x1", X(best[0])); xh.setAttribute("x2", X(best[0])); xh.setAttribute("opacity", ".25");
    xd.setAttribute("cx", X(best[0])); xd.setAttribute("cy", Y(best[1])); xd.setAttribute("opacity", "1");
    const d = new Date(best[0]); tip.hidden = false; tip.textContent = `${d.getFullYear()}.${d.getMonth() + 1} · ${nf(best[1], 1)}점`;
    tip.style.left = Math.min(innerWidth - 150, e.clientX + 12) + "px"; tip.style.top = (e.clientY - 34) + "px";
  });
  svg.addEventListener("pointerleave", () => { $("#tip").hidden = true; svg.querySelector(".xh").setAttribute("opacity", "0"); svg.querySelector(".xd").setAttribute("opacity", "0"); });
}
function barPairs(rows, names, unit, single) {
  const dp = unit === "%" ? 1 : 2;
  const vals = rows.flatMap(r => [r[1], r[2]]).filter(v => v != null);
  const mx = Math.max(0.1, ...vals.map(Math.abs));
  const pos = vals.every(v => v >= 0);
  const W = 460, rowH = single ? 30 : 38, H = rows.length * rowH + 30, L = 130, R = 50, mid = pos ? L : L + (W - L - R) / 2;
  const sc = v => (v / mx) * (pos ? (W - L - R) : (W - L - R) / 2);
  const cols = ["#8fb0ff", "#1d4ed8"];
  let s = `<div class="legend">${names.map((n, i) => `<span style="--c:${single ? cols[1] : cols[i]}">${n}</span>`).join("")}</div><svg viewBox="0 0 ${W} ${H}" width="100%">`;
  s += `<line x1="${mid}" x2="${mid}" y1="0" y2="${H - 20}" stroke="#cfd7e3"/>`;
  rows.forEach((r, i) => {
    const y = i * rowH + 6;
    s += `<text x="${L - 8}" y="${y + rowH / 2}" font-size="12" text-anchor="end" fill="#44506a">${esc(r[0])}</text>`;
    [r[1], r[2]].forEach((v, j) => {
      if (v == null) return;
      const bh = single ? 14 : 12, by = y + (single ? 7 : j * 14 + 4), w = sc(v);
      const x = w >= 0 ? mid : mid + w;
      s += `<rect x="${x}" y="${by}" width="${Math.max(2, Math.abs(w))}" height="${bh}" rx="3" fill="${single ? cols[1] : cols[j]}"><title>${esc(r[0])} · ${names[j] || ""} ${nf(v, dp)}${unit}</title></rect>`;
      s += `<text x="${w >= 0 ? mid + w + 4 : mid + w - 4}" y="${by + bh - 2}" font-size="11" text-anchor="${w >= 0 ? "start" : "end"}" fill="#44506a">${v > 0 && !pos ? "+" : ""}${nf(v, dp)}${unit}</text>`;
    });
  });
  return s + `</svg>`;
}

/* ───────── PWA ───────── */
let deferred = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("#installBtn").hidden = false; });
$("#installBtn").addEventListener("click", async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("#installBtn").hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* 자동 열기 */
const saved = LS.get("hub_pw");
if (saved) unlock(saved, true);
})();
