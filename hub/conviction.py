"""확신 종목 매수존 전략 — conviction-sentinel v1.1 규칙 재현 (표시용).

알림·판정의 원본은 market-risk-radar/conviction-sentinel (메일·ntfy). 이 화면은 같은 규칙으로 상태를 다시 계산해
보여주며, 보유 기록이 연결되면(읽기 토큰) 익절가를 원본 장부 기준으로 표시한다.

규칙 : 추세 종가>200일선 · 매수존 종가 ≤ 20일 고점 − 3×ATR(14), 최근 3거래일 내 도달 · 반전 확인(양봉+상단 절반 마감)
      · 거시 게이트 SPY 200일선 +2% 밴드 위 20거래일 유지 · 실적 3거래일 전 금지
      · 분할 1차 시가 → 2차 −1.5 ATR → 3차 −3 ATR (MRI ≥ 50 이면 3차 생략)
      · 익절 평단 × (1 + clamp(3×ATR/평단, 5%, 10%)) · 손절 없음(논지 붕괴 시 재량)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import atr


def spy_gate(spy: pd.DataFrame, band=0.02, days=20) -> pd.DataFrame:
    c = spy["Close"]
    ma = c.rolling(200).mean()
    above = c > ma * (1 + band)
    below = c < ma
    regime = pd.Series(np.nan, index=c.index)
    regime[above] = 1
    regime[below] = 0
    regime = regime.ffill().fillna(0)
    run = regime.groupby((regime != regime.shift()).cumsum()).cumcount() + 1
    open_ = (regime == 1) & (run >= days)
    return pd.DataFrame({"regime": regime, "run": run.where(regime == 1, 0), "open": open_, "ma200": ma,
                         "gap": (c / ma - 1) * 100})


def frame(df: pd.DataFrame, zone_atr=3.0, recent=3) -> pd.DataFrame:
    c, h, l, o = df["Close"], df["High"], df["Low"], df["Open"]
    a = atr(h, l, c, 14)
    hi20 = h.rolling(20).max()
    zone = hi20 - zone_atr * a
    ma200 = c.rolling(200).mean()
    inzone = c <= zone
    touched = inzone.rolling(recent).max().fillna(0) > 0
    rng = (h - l).replace(0, np.nan)
    bull = (c > o) & ((c - l) / rng >= 0.5)
    up = c > ma200
    sig = touched & bull & up
    return pd.DataFrame({"close": c, "atr": a, "hi20": hi20, "zone": zone, "ma200": ma200, "inzone": inzone,
                         "touched": touched, "bull": bull, "up": up, "sig": sig,
                         "dist_atr": (c - zone) / a})


def take_profit(avg: float, atr0: float) -> float:
    pct = min(max(3 * atr0 / avg, 0.05), 0.10)
    return avg * (1 + pct)


def past_signals(fr: pd.DataFrame, gate: pd.Series, start="2016-01-01", max_hold=756) -> dict:
    """과거 신호 → 익일 시가 대용(당일 종가) 진입, 익절가 도달까지 추적. 손절 없음 = 규칙과 동일."""
    f = fr[fr.index >= start]
    sig = f["sig"] & gate.reindex(f.index).fillna(False)
    closes = fr["close"]
    trades = []
    i_next_free = None
    idx = list(fr.index)
    pos = {d: k for k, d in enumerate(idx)}
    for d in f.index[sig.to_numpy()]:
        k = pos[d]
        if i_next_free is not None and k <= i_next_free:
            continue
        entry = float(closes.iloc[k])
        tp = take_profit(entry, float(fr["atr"].iloc[k]))
        seg = closes.iloc[k + 1:k + 1 + max_hold].to_numpy()
        hit = np.where(seg >= tp)[0]
        mae = float(seg[: (hit[0] + 1 if len(hit) else len(seg))].min() / entry - 1) if len(seg) else 0.0
        if len(hit):
            j = int(hit[0]) + 1
            trades.append({"date": str(d.date()), "entry": round(entry, 2), "tp": round(tp, 2), "days": j,
                           "ret": round((tp / entry - 1) * 100, 1), "mae": round(mae * 100, 1), "done": True})
            i_next_free = k + j
        else:
            trades.append({"date": str(d.date()), "entry": round(entry, 2), "tp": round(tp, 2),
                           "days": len(seg), "ret": round((float(seg[-1]) / entry - 1) * 100, 1) if len(seg) else 0,
                           "mae": round(mae * 100, 1), "done": False})
            i_next_free = k + len(seg)
    done = [t for t in trades if t["done"]]
    return {
        "n": len(trades), "n_done": len(done), "open": len(trades) - len(done),
        "win_rate": round(len(done) / len(trades) * 100, 1) if trades else None,
        "med_days": int(np.median([t["days"] for t in done])) if done else None,
        "max_days": int(max(t["days"] for t in trades)) if trades else None,
        "worst_mae": round(min(t["mae"] for t in trades), 1) if trades else None,
        "med_mae": round(float(np.median([t["mae"] for t in trades])), 1) if trades else None,
        "trades": trades[-12:],
    }


def status_row(t: str, fr: pd.DataFrame, gate_open: bool, holding: dict | None, next_earn: str | None,
               today: pd.Timestamp, mri: float | None, live_px: float | None) -> dict:
    last = fr.iloc[-1]
    px = live_px or float(last["close"])
    a = float(last["atr"])
    zone = float(last["zone"])
    dist = (px - zone) / a
    blackout = False
    if next_earn:
        try:
            bd = np.busday_count(today.date(), pd.Timestamp(next_earn).date())
            blackout = 0 <= bd <= 3
        except Exception:
            pass
    if holding:
        state, tone = "보유", "info"
    elif not bool(last["up"]):
        state, tone = "차단 · 하락추세", "bad"
    elif bool(last["sig"]) and gate_open and not blackout:
        state, tone = "매수 신호", "good"
    elif blackout:
        state, tone = "실적 전 금지", "warn"
    elif bool(last["touched"]) or dist <= 0:
        state, tone = "매수존", "good"
    elif dist <= 1.5:
        state, tone = "접근", "warn"
    else:
        state, tone = "대기", "muted"
    plan = None
    if not holding:
        p1 = min(px, zone) if dist > 0 else px
        plan = {"t1": round(p1, 2), "t2": round(p1 - 1.5 * a, 2),
                "t3": None if (mri is not None and mri >= 50) else round(p1 - 3 * a, 2),
                "tp_if_t1": round(take_profit(p1, a), 2)}
    h = None
    if holding:
        avg = float(holding["avg"])
        atr0 = float(holding.get("atr0") or a)
        tp = take_profit(avg, atr0)
        h = {"shares": holding.get("shares"), "avg": avg, "tp": round(tp, 2),
             "pnl": round((px / avg - 1) * 100, 2), "to_tp": round((tp / px - 1) * 100, 2)}
    return {"ticker": t, "state": state, "tone": tone, "px": round(px, 2), "close": round(float(last["close"]), 2),
            "zone": round(zone, 2), "dist_atr": round(dist, 2), "atr": round(a, 2), "ma200": round(float(last["ma200"]), 2),
            "up": bool(last["up"]), "next_earn": next_earn, "plan": plan, "holding": h}
