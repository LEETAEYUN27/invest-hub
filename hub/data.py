"""시세·거시 원자료 수집 (무료·API 키 불필요)."""
from __future__ import annotations

import io
import time

import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (invest-hub)"}


def prices(tickers: list[str], period="15y") -> dict[str, pd.DataFrame]:
    import yfinance as yf
    out: dict[str, pd.DataFrame] = {}
    for attempt in range(3):
        need = [t for t in tickers if t not in out]
        if not need:
            break
        raw = yf.download(need, period=period, interval="1d", auto_adjust=True,
                          group_by="ticker", progress=False, threads=True)
        for t in need:
            try:
                d = raw[t] if len(need) > 1 else raw
                d = d[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
                if len(d) > 250:
                    d.index = pd.to_datetime(d.index).tz_localize(None)
                    out[t] = d
            except Exception:
                pass
        time.sleep(2)
    return out


def intraday_last(tickers: list[str]) -> dict[str, dict]:
    """장중 최근가(1분봉 마지막) — 점수는 일봉 종가 기준, 이 값은 표시·거리 계산용."""
    import yfinance as yf
    out = {}
    try:
        raw = yf.download(tickers, period="1d", interval="1m", group_by="ticker",
                          progress=False, threads=True, prepost=False)
        for t in tickers:
            try:
                d = (raw[t] if len(tickers) > 1 else raw)["Close"].dropna()
                if len(d):
                    out[t] = {"px": float(d.iloc[-1]), "at": d.index[-1].isoformat()}
            except Exception:
                pass
    except Exception:
        pass
    return out


def _get(url: str, tries=4, **kw) -> requests.Response:
    err = None
    for k in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=60, **kw)
            r.raise_for_status()
            return r
        except Exception as e:  # 일시 차단·연결 끊김 재시도
            err = e
            time.sleep(3 * (k + 1))
    raise err


def fred(series: str) -> pd.Series:
    r = _get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}")
    d = pd.read_csv(io.StringIO(r.text))
    d.columns = ["date", "v"]
    d["v"] = pd.to_numeric(d["v"], errors="coerce")
    s = d.dropna().set_index(pd.to_datetime(d.dropna()["date"]))["v"]
    return s


def nyfed_recession() -> pd.Series:
    """뉴욕연준 수익률곡선 침체확률 — 행 날짜 = 예측 대상 월(12개월 뒤)."""
    r = _get("https://www.newyorkfed.org/medialibrary/media/research/capital_markets/allmonth.xls")
    x = pd.read_excel(io.BytesIO(r.content))
    x.columns = [str(c).strip() for c in x.columns]
    dcol = x.columns[0]
    pcol = [c for c in x.columns if "prob" in c.lower()][0]
    s = pd.Series(pd.to_numeric(x[pcol], errors="coerce").values, index=pd.to_datetime(x[dcol])).dropna()
    if s.max() <= 1.0:
        s = s * 100
    return s


def cape_monthly() -> pd.Series:
    import re
    r = _get("https://www.multpl.com/shiller-pe/table/by-month")
    t = r.text.replace("&#x2002;", " ")
    rows = re.findall(r"<td>([A-Z][a-z]{2} \d{1,2}, \d{4})</td>\s*<td>\s*([\d.]+)", t)
    s = pd.Series({pd.to_datetime(d): float(v) for d, v in rows}).sort_index()
    return s


def macro_console_payload() -> dict:
    r = _get("https://leetaeyun27.github.io/macro-console/payload.json")
    return r.json()


def private_json(repo: str, path: str, token: str | None):
    """비공개 저장소 파일 (읽기 전용 토큰이 있을 때만)."""
    if not token:
        return None
    try:
        r = requests.get(f"https://api.github.com/repos/{repo}/contents/{path}",
                         headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github.raw+json"},
                         timeout=30)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None
