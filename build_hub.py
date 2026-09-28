"""종합 투자 관제탑(invest-hub) 빌드 — 수집 → 계산 → 암호화 → site/ 출력.

환경 변수
  HUB_PASSWORD      (필수) 화면 잠금 비밀번호. 데이터는 이 비밀번호로 AES-256-GCM 암호화되어 공개 페이지에 올라간다.
  GH_READ_TOKEN     (선택) market-risk-radar 비공개 저장소 읽기 전용 토큰 → 보유 장부·MRI·실적일 연동
  HUB_FAST=1        (선택) 장중 빠른 실행: 백테스트 통계는 직전 캐시(state/stats.json) 재사용
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

from hub import buyscore as B, conviction as C, data as D, stability as S

ROOT = Path(__file__).parent
SITE = ROOT / "site"
STATE = ROOT / "state"
PRIVATE_REPO = "LEETAEYUN27/market-risk-radar"
LOG: list[str] = []


def log(msg: str):
    line = f"[{dt.datetime.utcnow():%H:%M:%S}] {msg}"
    LOG.append(line)
    print(line, flush=True)


def r2(x, n=2):
    try:
        if x is None or (isinstance(x, float) and np.isnan(x)):
            return None
        return round(float(x), n)
    except Exception:
        return None


def series(s: pd.Series, n=260, nd=2) -> list:
    s = s.dropna().iloc[-n:]
    return [[d.strftime("%Y-%m-%d"), r2(v, nd)] for d, v in s.items()]


# ───────────────────────── 암호화 ─────────────────────────
def encrypt(obj: dict, password: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    salt, iv, it = os.urandom(16), os.urandom(12), 250_000
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=it).derive(password.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), None)
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": it, "salt": b(salt), "iv": b(iv), "ct": b(ct)}


# ───────────────────────── 거시 ─────────────────────────
def build_macro() -> tuple[dict, dict]:
    mc = {}
    try:
        mc = D.macro_console_payload()
        log(f"관제실 payload 수신 · {mc.get('asof')}")
    except Exception as e:
        log(f"관제실 payload 실패 : {e}")

    raw, usrec, spx = {}, None, None
    cache = STATE / "macro_raw.pkl"
    try:
        import yfinance as yf
        raw = {"rec": D.nyfed_recession(), "cpi": D.fred("CPILFESL"), "nfci": D.fred("NFCI"),
               "curve": D.fred("T10Y3M"), "vix": D.fred("VIXCLS"), "unemp": D.fred("UNRATE"),
               "cape": D.cape_monthly()}
        usrec = D.fred("USREC")
        spx = yf.download("^GSPC", start="1989-01-01", progress=False, auto_adjust=True)["Close"].squeeze()
        spx.index = pd.to_datetime(spx.index).tz_localize(None)
        pd.to_pickle((raw, usrec, spx), cache)
        log("거시 원자료 수집 완료 (FRED·뉴욕연준·multpl·^GSPC)")
    except Exception as e:
        log(f"거시 원자료 일부 실패 → 캐시 사용 : {e}")
        if cache.exists():
            raw, usrec, spx = pd.read_pickle(cache)
    stab = {}
    if raw:
        sc = S.monthly_history(raw)
        last = sc.iloc[-1]
        chg12 = float(last["score"] - sc["score"].iloc[-12:].max())
        bt = S.backtest(sc, spx, usrec, "score")
        # 악화 속도(12개월 고점 대비 하락폭)별 12개월 급락 확률
        px = spx.resample("ME").last()
        sc["chg"] = sc["score"] - sc["score"].rolling(12).max()
        rows = []
        for d in sc.index:
            seg = spx[(spx.index > d) & (spx.index <= d + pd.DateOffset(months=12))]
            if len(seg) < 200 or d not in px.index or np.isnan(sc["chg"].get(d, np.nan)):
                continue
            rows.append((sc["chg"][d], float(seg.min() / px[d] - 1)))
        t = pd.DataFrame(rows, columns=["chg", "dd"])
        chg_rows = []
        for lo, hi, lab in [(-100, -15, "−15점 이상 악화"), (-15, -8, "−8~−15점"), (-8, -3, "−3~−8점"), (-3, 0.01, "고점 부근 유지")]:
            x = t[(t.chg >= lo) & (t.chg < hi)]
            chg_rows.append({"label": lab, "n": int(len(x)), "p_dd15": r2((x.dd <= -0.15).mean() * 100, 1),
                             "avg_dd": r2(x.dd.mean() * 100, 1)})
        axes = []
        for k, name, (x0, x1) in S.AXES:
            axes.append({"key": k, "name": name, "score": r2(last[k], 1), "raw": r2(last["raw_" + k], 2),
                         "range": f"{x0} → 100점 / {x1} → 0점"})
        stab = {"score": r2(last["score"], 1), "score_ex_cape": r2(last["score_ex_cape"], 1),
                "asof": sc.index[-1].strftime("%Y-%m"), "chg12": r2(chg12, 1), "axes": axes,
                "history": [[d.strftime("%Y-%m"), r2(v, 1)] for d, v in sc["score"].items()],
                "bt": bt, "bt_chg": chg_rows, "crisis": S.crisis_table(sc),
                "official": (mc.get("stability") or {}).get("score"),
                "recession_prob": r2(raw["rec"].iloc[-1], 1), "recession_target": raw["rec"].index[-1].strftime("%Y-%m")}
        log(f"경제 안정성 {stab['score']} (12개월 고점 대비 {stab['chg12']:+.1f})")
    market = {k: mc.get(k) for k in ["asof", "groups", "concentration", "rate_odds", "events"] if mc.get(k)}
    for items in (market.get("groups") or {}).values():
        for it in items:
            d = it.pop("daily", None) or []
            it.pop("monthly", None)
            it["spark"] = [v for _, v in d[-60:]] if d and isinstance(d[0], list) else []
    if market.get("concentration"):
        market["concentration"].pop("series", None)
    return stab, market


# ───────────────────────── 종목 ─────────────────────────
def build_stocks(stab: dict) -> dict:
    uni = json.loads((ROOT / "config" / "universe.json").read_text(encoding="utf-8"))
    conv, qual = uni["conviction"], uni["quality"]
    names = {**conv, **qual}
    tickers = list(names)
    px = D.prices(tickers + ["SPY", "QQQ", "HYG", "^VIX"], period="15y")
    miss = [t for t in tickers if t not in px]
    log(f"시세 {len(px)}종 수신, 누락 {miss}")
    spy = px["SPY"]
    live = D.intraday_last(tickers + ["SPY", "QQQ"])
    log(f"장중 최근가 {len(live)}종")

    token = os.environ.get("GH_READ_TOKEN")
    port = D.private_json(PRIVATE_REPO, "conviction-sentinel/state/portfolio.json", token)
    mri = D.private_json(PRIVATE_REPO, "conviction-sentinel/state/mri.json", token)
    earn_priv = D.private_json(PRIVATE_REPO, "conviction-sentinel/state/earnings.json", token)
    log(f"비공개 장부 연동 : {'연결' if port else '미연결'} · MRI {'연결' if mri else '미연결'}")
    mri_val = None
    if isinstance(mri, dict):
        mri_val = mri.get("mri") or mri.get("value") or mri.get("score")
    if not port and os.environ.get("HOLDINGS_JSON"):
        try:
            port = {"holdings": json.loads(os.environ["HOLDINGS_JSON"]), "history": []}
            log("보유 장부 : HOLDINGS_JSON 시크릿 사용")
        except Exception as e:
            log(f"HOLDINGS_JSON 해석 실패 : {e}")
    holdings = {h["ticker"]: h for h in (port or {}).get("holdings", [])}

    # 실적일
    earn = {}
    for t in list(conv):
        v = None
        if isinstance(earn_priv, dict):
            e = earn_priv.get(t)
            v = e.get("date") if isinstance(e, dict) else e
        if not v:
            try:
                import yfinance as yf
                cal = yf.Ticker(t).calendar
                ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
                if ed:
                    v = str(ed[0])
            except Exception:
                pass
        earn[t] = v

    # 매수자리 점수 + 백테스트 통계
    frames = {t: B.score_frame(px[t], spy) for t in tickers if t in px}
    stats_path = STATE / "stats.json"
    if os.environ.get("HUB_FAST") == "1" and stats_path.exists():
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
        log("백테스트 통계 캐시 사용")
    else:
        t0 = time.time()
        stats = B.bucket_stats(B.pooled(frames, spy["Close"]))
        stats_path.write_text(json.dumps(stats, ensure_ascii=False), encoding="utf-8")
        log(f"백테스트 통계 재계산 {time.time()-t0:.1f}s · 표본 {stats['base']['all']['n']:,}일")

    rows = []
    for t, f in frames.items():
        last = f.iloc[-1]
        d = px[t]
        c = d["Close"]
        lp = live.get(t, {}).get("px")
        st = last["state"]
        conf, conf_tone = B.confidence(stats["states"].get(st))
        g, tone = B.grade(float(last["score"]))
        rows.append({
            "t": t, "name": names[t]["name"], "tv": names[t].get("tv", t), "group": "conviction" if t in conv else "quality",
            "score": r2(last["score"], 0), "grade": g, "tone": tone,
            "comp": {k: r2(last[k], 0) for k, _, _ in B.COMPONENTS},
            "state": st, "conf": conf, "conf_tone": conf_tone,
            "analog": stats["states"].get(st), "own": stats["per_ticker"].get(t, {}).get(st),
            "close": r2(c.iloc[-1]), "live": r2(lp), "d1": r2((c.iloc[-1] / c.iloc[-2] - 1) * 100),
            "m1": r2((c.iloc[-1] / c.iloc[-22] - 1) * 100), "y1": r2((c.iloc[-1] / c.iloc[-253] - 1) * 100),
            "dd52": r2((c.iloc[-1] / c.iloc[-252:].max() - 1) * 100), "dist_atr": r2(last["dist_atr"]),
            "rsi2": r2(last["rsi2"], 0), "ma200": r2(last["ma200"]), "atr": r2(last["atr"]),
            "asof": f.index[-1].strftime("%Y-%m-%d"),
            "ohlc": [[i.strftime("%Y-%m-%d"), r2(o), r2(h), r2(l), r2(cc)] for i, o, h, l, cc in
                     zip(d.index[-260:], d["Open"].iloc[-260:], d["High"].iloc[-260:], d["Low"].iloc[-260:], c.iloc[-260:])],
            "ma200s": series(f["ma200"], 260),
        })
    rows.sort(key=lambda r: (-(r["score"] or 0), r["t"]))

    # 확신 종목 매수존 전략
    gate = C.spy_gate(spy)
    g_last = gate.iloc[-1]
    today = pd.Timestamp(dt.date.today())
    conv_rows, evidence = [], {}
    for t in conv:
        if t not in px:
            continue
        fr = C.frame(px[t])
        row = C.status_row(t, fr, bool(g_last["open"]), holdings.get(t), earn.get(t), today, mri_val,
                           live.get(t, {}).get("px"))
        row["name"] = conv[t]["name"]
        row["tv"] = conv[t].get("tv", t)
        row["cap_pct"] = conv[t].get("cap_pct")
        row["zone_series"] = series(fr["zone"], 130)
        ev = C.past_signals(fr, gate["open"])
        row["past"] = ev
        evidence[t] = {k: v for k, v in ev.items() if k != "trades"}
        conv_rows.append(row)
    order = {"매수 신호": 0, "매수존": 1, "보유": 2, "접근": 3, "실적 전 금지": 4, "대기": 5, "차단 · 하락추세": 6}
    conv_rows.sort(key=lambda r: (order.get(r["state"], 9), r["dist_atr"]))
    allt = [x for v in evidence.values() for x in [v]]
    tot_n = sum(v["n"] for v in allt)
    tot_done = sum(v["n_done"] for v in allt)
    conviction = {
        "gate": {"open": bool(g_last["open"]), "run": int(g_last["run"]), "gap": r2(g_last["gap"], 1)},
        "mri": r2(mri_val, 1), "linked": bool(port), "rows": conv_rows,
        "summary": {"n": tot_n, "done": tot_done, "win": r2(tot_done / tot_n * 100, 1) if tot_n else None,
                    "worst_mae": min((v["worst_mae"] for v in allt if v["worst_mae"] is not None), default=None),
                    "max_days": max((v["max_days"] for v in allt if v["max_days"] is not None), default=None)},
        "backtest_ref": [
            {"case": "확신 8종목 2016~2026 (사후 선정 편향 포함)", "cagr": 22.3, "mdd": -26.2, "sharpe": 1.00},
            {"case": "무작위 8종목 · 113종목 풀 2016~2026 (80회 중앙값)", "cagr": 15.9, "mdd": -38.3, "sharpe": 0.76},
            {"case": "무작위 8종목 · 장기 36종목 2007~2026 (60회 중앙값)", "cagr": 14.4, "mdd": -38.9, "sharpe": None},
        ],
        "history": (port or {}).get("history", [])[-20:],
    }

    # 하락장 레이더
    def above(t):
        if t not in px:
            return None
        c = px[t]["Close"]
        return r2((c.iloc[-1] / c.rolling(200).mean().iloc[-1] - 1) * 100, 1)
    vix = px.get("^VIX")
    breadth = [r["t"] for r in rows if r["close"] and r["ma200"] and r["close"] > r["ma200"]]
    bear = {
        "spy_gap": above("SPY"), "qqq_gap": above("QQQ"), "hyg_gap": above("HYG"),
        "vix": r2(vix["Close"].iloc[-1], 1) if vix is not None else None,
        "breadth": r2(len(breadth) / len(rows) * 100, 0), "breadth_n": f"{len(breadth)}/{len(rows)}",
        "spy_series": series(spy["Close"], 260), "spy_ma200": series(spy["Close"].rolling(200).mean(), 260),
        "live": {k: live.get(k) for k in ["SPY", "QQQ"]},
    }
    return {"buy": {"rows": rows, "stats": stats, "components": B.COMPONENTS}, "conviction": conviction, "bear": bear}


def main():
    pw = os.environ.get("HUB_PASSWORD")
    if not pw:
        sys.exit("HUB_PASSWORD 가 없습니다 (GitHub → Settings → Secrets → Actions 에 등록)")
    STATE.mkdir(exist_ok=True)
    started = time.time()
    stab, market = build_macro()
    stocks = build_stocks(stab)
    now = dt.datetime.now(dt.timezone.utc)
    payload = {"asof": now.strftime("%Y-%m-%d %H:%M UTC"),
               "asof_kst": (now + dt.timedelta(hours=9)).strftime("%Y-%m-%d %H:%M KST"),
               "stability": stab, "market": market, **stocks, "log": LOG[-40:]}
    ps = ROOT / "config" / "put_study.json"
    if ps.exists():
        payload["put_study"] = json.loads(ps.read_text(encoding="utf-8"))
    SITE.mkdir(exist_ok=True)
    for p in (ROOT / "web").iterdir():
        if p.is_file():
            shutil.copy(p, SITE / p.name)
    (SITE / "data.enc.json").write_text(json.dumps(encrypt(payload, pw)), encoding="utf-8")
    (SITE / "build.txt").write_text(f"{payload['asof']} · {time.time()-started:.0f}s\n", encoding="utf-8")
    if os.environ.get("HUB_DEBUG_PLAIN") == "1":
        (ROOT / "payload.debug.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    log(f"완료 {time.time()-started:.0f}s · 암호문 {len((SITE / 'data.enc.json').read_text())/1024:.0f}KB")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
