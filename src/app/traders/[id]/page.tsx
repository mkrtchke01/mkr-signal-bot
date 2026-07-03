"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { exitLabel, fmtPct, fmtPrice, ruleLabel } from "@/lib/format";
import type { BacktestResult, Signal, Trader, TraderStats } from "@/lib/types";

type Full = Trader & { stats: TraderStats | null; signals: Signal[] };

export default function TraderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [t, setT] = useState<Full | null>(null);
  const [error, setError] = useState("");
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [btLoading, setBtLoading] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/traders/${id}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return setError(j.error ?? `${res.status} ${res.statusText}`);
    }
    setT(await res.json());
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function toggle() {
    if (!t) return;
    await fetch(`/api/traders/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: t.status === "RUNNING" ? "PAUSED" : "RUNNING" }),
    });
    load();
  }

  async function remove() {
    if (!t || !confirm(`Удалить трейдера «${t.name}»?`)) return;
    await fetch(`/api/traders/${id}`, { method: "DELETE" });
    router.push("/");
  }

  async function backtest(days: number) {
    setBtLoading(days);
    setBt(null);
    setError("");
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ traderId: id, days }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setBt(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBtLoading(null);
    }
  }

  if (error && !t) return <p className="error">Ошибка: {error}</p>;
  if (!t) return <p className="muted">Загрузка…</p>;

  const s = t.stats;
  const profit = s?.profitPct ?? 0;

  return (
    <main>
      <div className="trader-head" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>{t.name}</h1>
        <span className="sym">#{t.symbol}</span>
        <span className={`badge ${t.direction.toLowerCase()}`}>{t.direction}</span>
        <span className="badge open">×{t.leverage}</span>
        <span className={`badge ${t.status === "RUNNING" ? "running" : "paused"}`}>
          {t.status === "RUNNING" ? "работает" : "на паузе"}
        </span>
      </div>

      <div className="trader-actions" style={{ marginBottom: 16 }}>
        <button className={`btn ${t.status === "RUNNING" ? "" : "green"}`} onClick={toggle}>
          {t.status === "RUNNING" ? "⏸ Пауза" : "▶ Запустить"}
        </button>
        <Link className="btn" href={`/traders/${id}/edit`}>Редактировать</Link>
        <button className="btn red" onClick={remove}>Удалить</button>
      </div>

      <div className="card">
        <h2>Настройки</h2>
        <div className="rules-list">
          <div className="rule-item"><span>Базовый таймфрейм: {t.timeframe}</span></div>
          {t.rules.map((r, i) => <div className="rule-item" key={i}><span>Вход: {ruleLabel(r)}</span></div>)}
          <div className="rule-item"><span>🛑 Стоп: {exitLabel(t.stopLoss)}</span></div>
          <div className="rule-item"><span>🎯 Тейк: {exitLabel(t.takeProfit)}</span></div>
        </div>
      </div>

      <div className="card">
        <h2>Статистика</h2>
        <div className="stats-grid">
          <div className="stat"><div className="v">{s?.total ?? 0}</div><div className="l">сигналов</div></div>
          <div className="stat"><div className="v pos">{s?.tp ?? 0}</div><div className="l">по тейку</div></div>
          <div className="stat"><div className="v neg">{s?.sl ?? 0}</div><div className="l">по стопу</div></div>
          <div className="stat"><div className="v">{s?.open ?? 0}</div><div className="l">открыто</div></div>
          <div className="stat">
            <div className={`v ${profit >= 0 ? "pos" : "neg"}`}>{fmtPct(profit)}</div>
            <div className="l">профит (×плечо)</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Бэктест</h2>
        <div className="trader-actions">
          <button className="btn" disabled={btLoading !== null} onClick={() => backtest(7)}>
            {btLoading === 7 ? "Считаю…" : "За неделю"}
          </button>
          <button className="btn" disabled={btLoading !== null} onClick={() => backtest(30)}>
            {btLoading === 30 ? "Считаю…" : "За месяц"}
          </button>
        </div>
        {error && t && <p className="error">{error}</p>}
        {bt && (
          <>
            <div className="stats-grid" style={{ marginTop: 14 }}>
              <div className="stat"><div className="v">{bt.stats.total}</div><div className="l">сделок за {bt.days} дн.</div></div>
              <div className="stat"><div className="v pos">{bt.stats.tp}</div><div className="l">по тейку</div></div>
              <div className="stat"><div className="v neg">{bt.stats.sl}</div><div className="l">по стопу</div></div>
              <div className="stat"><div className="v">{bt.stats.winRate}%</div><div className="l">winrate</div></div>
              <div className="stat">
                <div className={`v ${bt.stats.profitPct >= 0 ? "pos" : "neg"}`}>{fmtPct(bt.stats.profitPct)}</div>
                <div className="l">профит (×плечо)</div>
              </div>
            </div>
            {bt.trades.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table>
                  <thead>
                    <tr><th>Вход</th><th>Цена входа</th><th>Выход</th><th>Цена выхода</th><th>Итог</th><th>Профит</th></tr>
                  </thead>
                  <tbody>
                    {bt.trades.slice(-50).reverse().map((tr, i) => (
                      <tr key={i}>
                        <td>{new Date(tr.entryTime).toLocaleString("ru-RU")}</td>
                        <td>{fmtPrice(tr.entryPrice)}</td>
                        <td>{tr.exitTime ? new Date(tr.exitTime).toLocaleString("ru-RU") : "—"}</td>
                        <td>{fmtPrice(tr.exitPrice)}</td>
                        <td><span className={`badge ${tr.result.toLowerCase()}`}>{tr.result}</span></td>
                        <td className={tr.profitPct !== null && tr.profitPct >= 0 ? "pos" : "neg"}>{fmtPct(tr.profitPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Сигналы</h2>
        {!t.signals.length && <p className="muted">Пока нет сигналов. Запусти трейдера — сигналы появятся здесь и в Telegram-каналах.</p>}
        {t.signals.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Открыт</th><th>Вход</th><th>Стоп</th><th>Тейк</th><th>Статус</th><th>Выход</th><th>Профит</th></tr>
              </thead>
              <tbody>
                {t.signals.map((sig) => (
                  <tr key={sig.id}>
                    <td>{new Date(sig.entryTime).toLocaleString("ru-RU")}</td>
                    <td>{fmtPrice(sig.entryPrice)}</td>
                    <td>{sig.stopPrice !== null ? fmtPrice(sig.stopPrice) : "RSI"}</td>
                    <td>{sig.takePrice !== null ? fmtPrice(sig.takePrice) : "RSI"}</td>
                    <td><span className={`badge ${sig.status.toLowerCase()}`}>{sig.status}</span></td>
                    <td>{fmtPrice(sig.exitPrice)}</td>
                    <td className={sig.profitPct !== null && sig.profitPct >= 0 ? "pos" : "neg"}>{fmtPct(sig.profitPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
