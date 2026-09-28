"""공용 지표 계산 (순수 함수)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def atr(h: pd.Series, l: pd.Series, c: pd.Series, n: int = 14) -> pd.Series:
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def rsi(c: pd.Series, n: int) -> pd.Series:
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(100)


def lin(x, x0, x1, y0, y1):
    """x0→y0, x1→y1 선형 환산 후 절단."""
    t = (np.asarray(x, dtype=float) - x0) / (x1 - x0)
    return np.clip(y0 + t * (y1 - y0), min(y0, y1), max(y0, y1))
