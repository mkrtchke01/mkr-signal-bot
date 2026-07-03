"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtPct } from "@/lib/format";
import type { Trader, TraderStats } from "@/lib/types";

type TraderWithStats = Trader & { stats: TraderStats | null };

export default function Dashboard() {
  const [traders, setTraders] = useState<TraderWithStats[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/traders");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      setTraders(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(t: TraderWithStats) {
    await fetch(`/api/traders/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: t.status === "RUNNING" ? "PAUSED" : "RUNNING" }),
    });
    load();
  }

  async function remove(t: TraderWithStats) {
    if (!confirm(`Удалить трейдера «${t.name}» вместе с историей сигналов?`)) return;
    await fetch(`/api/traders/${t.id}`, { method: "DELETE" });
    load();
  }

  if (error) return <p className="error">Ошибка: {error}</p>;
  if (!traders) return <p className="muted">Загрузка…</p>;

  return (
    <main>
      <h1>Мои трейдеры</h1>
      {!traders.length && (
        <div className="card">
          <p>Пока нет ни одного трейдера.</p>
          <Link className="btn primary" href="/new">Создать трейдера</Link>
        </div>
      )}
      {traders.map((t) => {
        const s = t.stats;
        const profit = s?.profitPct ?? 0;
        return (
          <div className="card trader-card" key={t.id}>
            <div className="trader-head">
              <span className="name">{t.name}</span>
              <span className="sym">#{t.symbol}</span>
              <span className={`badge ${t.direction.toLowerCase()}`}>{t.direction}</span>
              <span className="badge open">×{t.leverage}</span>
              <span className="badge open">{t.timeframe}</span>
              <span className={`badge ${t.status === "RUNNING" ? "running" : "paused"}`}>
                {t.status === "RUNNING" ? "работает" : "на паузе"}
              </span>
            </div>
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
            <div className="trader-actions">
              <button
                className={`btn sm ${t.status === "RUNNING" ? "" : "green"}`}
                onClick={() => toggle(t)}
              >
                {t.status === "RUNNING" ? "⏸ Пауза" : "▶ Запустить"}
              </button>
              <Link className="btn sm" href={`/traders/${t.id}`}>Открыть</Link>
              <Link className="btn sm" href={`/traders/${t.id}/edit`}>Редактировать</Link>
              <button className="btn sm red" onClick={() => remove(t)}>Удалить</button>
            </div>
          </div>
        );
      })}
    </main>
  );
}
