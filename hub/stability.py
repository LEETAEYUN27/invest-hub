"""경제 안정성 점수 (100 = 안정) — 관제실(macro-console) 7축 산식을 1990년부터 월별 재현하고,
점수대별로 이후 12개월 S&P500 급락(고점 대비 −15% 이상)·침체 진입 빈도를 백테스트한다.

7축 환산 (관제실과 동일) : 침체확률 0%→100/60%→0 · 근원CPI |YoY−2| 0→100/5%p→0 · NFCI −0.5→100/+1.5→0 ·
10Y−3M +1.5→100/−0.6→0 · VIX 12→100/48→0 · 실업률 3.5→100/10→0 · CAPE 10→100/42→0
발표 시차 : CPI·실업률 1개월 지연 반영 (룩어헤드 방지). 침체확률은 12개월 전 곡선으로 계산된 값 → 해당 월 시점에 이미 공개.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import lin

AXES = [
    ("rec", "침체 확률 (뉴욕연준)", (0, 60)),
    ("cpi", "근원 CPI 목표 이격", (0, 5)),
    ("nfci", "금융여건 (NFCI)", (-0.5, 1.5)),
    ("curve", "장단기 금리차 10Y−3M", (1.5, -0.6)),
    ("vix", "변동성 (VIX)", (12, 48)),
    ("unemp", "실업률", (3.5, 10)),
    ("cape", "밸류에이션 (CAPE)", (10, 42)),
]
BUCKETS = [(0, 50), (50, 60), (60, 70), (70, 80), (80, 101)]


def monthly_history(raw: dict[str, pd.Series]) -> pd.DataFrame:
    m = lambda s: s.resample("ME").last()
    rec = raw["rec"].copy()
    rec.index = rec.index + pd.offsets.MonthEnd(0)
    # 행 날짜 = 예측 대상월. 시점 t 에 공개된 값 = 대상월 t+12 의 확률
    rec_avail = rec.shift(-12, freq="ME") if False else pd.Series(rec.values, index=rec.index - pd.DateOffset(months=12))
    rec_avail.index = rec_avail.index + pd.offsets.MonthEnd(0)
    cpi = raw["cpi"].resample("ME").last()
    cpi_yoy = (cpi / cpi.shift(12) - 1) * 100
    df = pd.DataFrame({
        "rec": rec_avail.groupby(level=0).last(),
        "cpi": (cpi_yoy - 2).abs().shift(1),
        "nfci": m(raw["nfci"]),
        "curve": m(raw["curve"]),
        "vix": m(raw["vix"]),
        "unemp": raw["unemp"].resample("ME").last().shift(1),
        "cape": m(raw["cape"]),
    })
    df = df.ffill(limit=3)  # 발표 지연 축은 직전 공개값 유지(최대 3개월)
    df = df[df.index >= "1990-01-31"]
    sc = pd.DataFrame(index=df.index)
    for k, _, (x0, x1) in AXES:
        sc[k] = lin(df[k], x0, x1, 100, 0)
        sc.loc[df[k].isna(), k] = np.nan
    sc["score"] = sc[[k for k, _, _ in AXES]].mean(axis=1, skipna=True)
    sc["score_ex_cape"] = sc[[k for k, _, _ in AXES if k != "cape"]].mean(axis=1, skipna=True)
    return sc.join(df.add_prefix("raw_"))


def backtest(sc: pd.DataFrame, spx: pd.Series, usrec: pd.Series, col="score") -> dict:
    px = spx.resample("ME").last()
    daily = spx
    fwd_dd, fwd_ret = {}, {}
    for d in sc.index:
        if d not in px.index:
            continue
        p0 = px.loc[d]
        seg = daily[(daily.index > d) & (daily.index <= d + pd.DateOffset(months=12))]
        if len(seg) < 200:
            continue
        fwd_dd[d] = float(seg.min() / p0 - 1)
        fwd_ret[d] = float(seg.iloc[-1] / p0 - 1)
    r = usrec.resample("ME").last().reindex(sc.index).ffill()
    start_rec = {}
    for d in sc.index:
        nxt = r[(r.index > d) & (r.index <= d + pd.DateOffset(months=12))]
        if len(nxt) < 12:
            continue
        start_rec[d] = bool((r.loc[d] == 0) and (nxt == 1).any())
    t = pd.DataFrame({"s": sc[col], "dd": pd.Series(fwd_dd), "ret": pd.Series(fwd_ret),
                      "rec": pd.Series(start_rec)}).dropna(subset=["s", "dd"])
    rows = []
    for a, b in BUCKETS:
        x = t[(t.s >= a) & (t.s < b)]
        rx = x.dropna(subset=["rec"])
        rows.append({"range": f"{a}~{min(b,100)}", "n": int(len(x)),
                     "p_dd15": round(float((x.dd <= -0.15).mean() * 100), 1) if len(x) else None,
                     "p_dd25": round(float((x.dd <= -0.25).mean() * 100), 1) if len(x) else None,
                     "avg_dd": round(float(x.dd.mean() * 100), 1) if len(x) else None,
                     "avg_ret": round(float(x.ret.mean() * 100), 1) if len(x) else None,
                     "p_rec": round(float(rx.rec.astype(float).mean() * 100), 1) if len(rx) else None})
    base = {"n": int(len(t)), "p_dd15": round(float((t.dd <= -0.15).mean() * 100), 1),
            "avg_ret": round(float(t.ret.mean() * 100), 1)}
    # 조기경보 : 과거 주요 급락 직전 12개월 최저 점수
    return {"buckets": rows, "base": base, "col": col,
            "corr_dd": round(float(t.s.rank().corr(t.dd.rank())), 2)}


def crisis_table(sc: pd.DataFrame) -> list[dict]:
    events = [("1990 걸프전·침체", "1990-07"), ("1998 LTCM", "1998-07"), ("2000 닷컴 정점", "2000-03"),
              ("2007 금융위기 정점", "2007-10"), ("2011 미 신용등급 강등", "2011-04"), ("2015 위안화 쇼크", "2015-05"),
              ("2018 4분기 급락", "2018-09"), ("2020 코로나", "2020-02"), ("2022 긴축 약세장", "2021-12")]
    out = []
    for name, ym in events:
        d = pd.Timestamp(ym) + pd.offsets.MonthEnd(0)
        win = sc[(sc.index > d - pd.DateOffset(months=12)) & (sc.index <= d)]["score"]
        if len(win):
            out.append({"event": name, "peak": ym, "at_peak": round(float(sc["score"].get(d, np.nan)), 1),
                        "min_12m": round(float(win.min()), 1), "avg_12m": round(float(win.mean()), 1)})
    return out
