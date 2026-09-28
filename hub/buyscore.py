"""매수자리 종합 점수 (0~100) + 과거 동일 상태 성과(백테스트 신뢰도).

v1 초안(근거 등급 가중 6요소)은 2013~2026 24종목 검증에서 점수대별 20일 성과 차이가 없었음
(단조성 −0.43). 세부 조건 36칸도 전반(2013~19)·후반(2020~26) 재현 실패(상관 −0.46).
두 기간 모두 같은 방향으로 재현된 조건만 남긴 v2:
  종목 상승추세(종가>200일선) 30 · 시장 상승추세(SPY) 20 · 눌림 깊이(20일 고점 대비 ATR) 30 ·
  반전 캔들(양봉·상단 마감) 10 · 12-1개월 모멘텀 양(+) 10
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import atr, rsi, lin

BUCKETS = [(0, 40), (40, 60), (60, 75), (75, 90), (90, 101)]
COMPONENTS = [
    ("trend", "종목 추세 (200일선 위)", 30),
    ("regime", "시장 추세 (SPY 200일선)", 20),
    ("pull", "눌림 깊이 (20일 고점−ATR)", 30),
    ("rev", "반전 캔들", 10),
    ("mom", "12-1개월 모멘텀", 10),
]
SPLIT = "2020-01-01"


def score_frame(df: pd.DataFrame, spy: pd.DataFrame) -> pd.DataFrame:
    """df: Open/High/Low/Close/Volume (일봉). 반환: 구성 점수·총점·보조 지표."""
    c, h, l, o, v = df["Close"], df["High"], df["Low"], df["Open"], df["Volume"]
    ma200 = c.rolling(200, min_periods=200).mean()
    a = atr(h, l, c, 14)
    hi20 = h.rolling(20, min_periods=20).max()
    out = pd.DataFrame(index=df.index)

    out["trend"] = np.where(c > ma200, 30, 0)
    sc = spy["Close"].reindex(df.index).ffill()
    sma = spy["Close"].rolling(200).mean().reindex(df.index).ffill()
    mkt_up = (sc > sma)
    out["regime"] = np.where(mkt_up, 12, 0) + np.where(sma > sma.shift(60), 8, 0)
    d = ((hi20 - c) / a).fillna(0)
    out["pull"] = np.select([d < 1, d < 2, d <= 4, d <= 6], [0, 10, 30, 25], default=15)
    rng = (h - l).replace(0, np.nan)
    bull = (c > o) & ((c - l) / rng >= 0.5)
    out["rev"] = np.where(bull, 10, 0)
    m121 = c.shift(21) / c.shift(252) - 1
    out["mom"] = np.where(m121 > 0, 10, 0)
    out["state"] = (np.where(mkt_up, "시장↑", "시장↓") + "/" + np.where(c > ma200, "종목↑", "종목↓") + "/"
                    + np.select([d < 2, d <= 4], ["눌림<2", "눌림2-4"], default="눌림4+"))
    r2 = rsi(c, 2)
    out["score"] = out[[k for k, _, _ in COMPONENTS]].sum(axis=1).round(1)
    out["valid"] = ma200.notna() & a.notna() & c.shift(252).notna()
    out["close"] = c
    out["atr"] = a
    out["dist_atr"] = d
    out["rsi2"] = r2
    out["ma200"] = ma200
    return out


def forward_outcomes(c: pd.Series, tp=0.05, sl=-0.10, horizon=60) -> pd.DataFrame:
    """20일 후 수익률, 60일 내 +5% 익절 선도달 여부(−10% 먼저면 실패)."""
    arr = c.to_numpy(dtype=float)
    n = len(arr)
    hit = np.full(n, np.nan)
    for i in range(n - 1):
        j_end = min(n, i + 1 + horizon)
        if i + horizon >= n:
            break
        seg = arr[i + 1:j_end] / arr[i] - 1
        up = np.argmax(seg >= tp) if (seg >= tp).any() else None
        dn = np.argmax(seg <= sl) if (seg <= sl).any() else None
        if up is not None and (dn is None or up < dn):
            hit[i] = 1
        else:
            hit[i] = 0
    f20 = c.shift(-20) / c - 1
    return pd.DataFrame({"f20": f20, "tp_hit": hit}, index=c.index)


def bucket_of(s: float) -> int:
    for i, (a, b) in enumerate(BUCKETS):
        if a <= s < b:
            return i
    return len(BUCKETS) - 1


def _agg(s: pd.DataFrame, base_ex: float | None = None) -> dict:
    if not len(s):
        return {"n": 0}
    r = {"n": int(len(s)),
         "win20": round(float((s["f20"] > 0).mean() * 100), 1),
         "avg20": round(float(s["f20"].mean() * 100), 2),
         "ex20": round(float(s["ex"].mean() * 100), 2),
         "tp_rate": round(float(s["tp_hit"].mean() * 100), 1)}
    if base_ex is not None:
        r["edge"] = round(float((s["ex"].mean() - base_ex) * 100), 2)
    return r


def pooled(frames: dict[str, pd.DataFrame], spy_close: pd.Series, start="2013-01-01") -> pd.DataFrame:
    spyf = spy_close.shift(-20) / spy_close - 1
    rows = []
    for t, f in frames.items():
        g = f[(f.index >= start) & f["valid"]].copy()
        g = g.join(forward_outcomes(f["close"]).reindex(g.index))
        g["ex"] = g["f20"] - spyf.reindex(g.index)
        g["b"] = g["score"].map(bucket_of)
        g["ticker"] = t
        rows.append(g[["score", "b", "state", "f20", "ex", "tp_hit", "ticker"]])
    allg = pd.concat(rows).dropna(subset=["f20", "tp_hit", "ex"])
    allg["per"] = np.where(allg.index < SPLIT, "is", "oos")
    return allg


def bucket_stats(allg: pd.DataFrame) -> dict:
    """점수대별 성과 — 전반(2013~2019)·후반(2020~) 분리. edge = 전체 평균 대비 초과(%p)."""
    base = {p: float(x["ex"].mean()) for p, x in allg.groupby("per")}
    out = []
    for i, (a, b) in enumerate(BUCKETS):
        s = allg[allg["b"] == i]
        out.append({"range": f"{a}~{min(b, 100)}",
                    "all": _agg(s),
                    "is": _agg(s[s.per == "is"], base["is"]),
                    "oos": _agg(s[s.per == "oos"], base["oos"])})
    states = {}
    for st, s in allg.groupby("state"):
        i_, o_ = s[s.per == "is"], s[s.per == "oos"]
        states[st] = {"all": _agg(s), "is": _agg(i_, base["is"]), "oos": _agg(o_, base["oos"])}
    per_ticker = {}
    for (t, st), s in allg.groupby(["ticker", "state"]):
        if len(s) >= 30:
            per_ticker.setdefault(t, {})[st] = _agg(s)
    def mono(key):
        v = [r[key].get("edge") for r in out if r[key].get("n", 0) >= 100]
        return round(float(pd.Series(v).rank().corr(pd.Series(range(len(v)), dtype=float).rank())), 2) if len(v) > 2 else None
    return {"buckets": out, "states": states, "per_ticker": per_ticker,
            "base": {"all": _agg(allg), "is": _agg(allg[allg.per == "is"]), "oos": _agg(allg[allg.per == "oos"])},
            "mono_is": mono("is"), "mono_oos": mono("oos"),
            "start": str(allg.index.min().date()), "end": str(allg.index.max().date()), "split": SPLIT}


def confidence(st: dict | None) -> tuple[str, str]:
    """상태 신뢰도: 전반·후반 모두 초과(+)이고 표본 충분 → 높음."""
    if not st or st["is"].get("n", 0) < 150 or st["oos"].get("n", 0) < 150:
        return "표본 부족", "muted"
    ei, eo = st["is"].get("edge", 0), st["oos"].get("edge", 0)
    if ei > 0 and eo > 0:
        return "높음", "good"
    if ei > 0 or eo > 0:
        return "엇갈림", "warn"
    return "낮음", "bad"


def grade(score: float) -> tuple[str, str]:
    if score >= 90:
        return "최적 매수자리", "good"
    if score >= 75:
        return "매수자리", "good"
    if score >= 60:
        return "관심", "info"
    if score >= 40:
        return "대기", "muted"
    return "매수 부적합", "bad"
