"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtUsd, fmtWinRate, winRate } from "@/lib/format";
import { fmtR } from "@/lib/rMultiple";
import type { BotStats, UserBotStats } from "@/lib/types";

interface BotListItem {
  slug: string;
  name: string;
  short: string;
  stats: BotStats; // общая статистика сигналов, в R
  mine: { enabled: boolean; riskPct: number; stats: UserBotStats }; // моя, в $
}

export default function BotsPage() {
  const [bots, setBots] = useState<BotListItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bots");
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      setBots(await res.json());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="error">Ошибка: {error}</p>;
  if (!bots) return <p className="muted">Загрузка…</p>;

  return (
    <main>
      <h1>Кастомные боты</h1>
      <p className="hint" style={{ maxWidth: "70ch" }}>
        Стратегии, которые нельзя собрать в конструкторе: многотаймфреймовый
        анализ, уровневые входы, сопровождение позиции. Каждый бот сигналит
        в подключённые Telegram-каналы. Открой бота, чтобы увидеть активные
        сетапы, настройки и полную историю.
      </p>
      <div style={{ marginTop: 20 }}>
        {bots.map((b) => {
          const s = b.stats;
          const closed = s.total - s.open;
          const m = b.mine;
          const ms = m.stats;
          return (
            <Link key={b.slug} href={`/bots/${b.slug}`} className="card-link">
              <div className="card trader-card">
                <div className="trader-head">
                  <span className="name">{b.name}</span>
                  <span className={`badge ${m.enabled ? "running" : "paused"}`}>
                    {m.enabled ? `торгует на мой капитал · риск ${m.riskPct}%` : "не торгует на мой капитал"}
                  </span>
                </div>
                <p className="hint" style={{ margin: 0, maxWidth: "70ch" }}>{b.short}</p>
                <div className="stat-panels">
                  <div className="stat-panel mine">
                    <div className="stat-panel-title">Мои сделки <span>· в $, на мой капитал</span></div>
                    <div className="chips">
                      <span className="chip static">
                        <span className="k">Сделок</span> <span className="v">{ms.taken - ms.open}</span>
                      </span>
                      <span className="chip static">
                        <span className="k">Winrate</span>
                        <span className="v">{fmtWinRate(winRate(ms.wins, ms.decided))}</span>
                      </span>
                      <span className="chip static">
                        <span className="k">PnL</span>
                        <span className={`v ${ms.profitUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(ms.profitUsd)}</span>
                      </span>
                      <span className="chip static">
                        <span className="k">Активных</span> <span className="v">{ms.open}</span>
                      </span>
                      {ms.skipped > 0 && (
                        <span className="chip static">
                          <span className="k">Пропущено</span> <span className="v">{ms.skipped}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="stat-panel">
                    <div className="stat-panel-title">Все сигналы <span>· в R, общая статистика бота</span></div>
                    <div className="chips">
                      <span className="chip static">
                        <span className="k">Сделок</span> <span className="v">{closed}</span>
                      </span>
                      <span className="chip static">
                        <span className="k">Winrate</span>
                        <span className="v">{fmtWinRate(winRate(s.wins, s.decided))}</span>
                      </span>
                      <span className="chip static">
                        <span className="k">Итог</span>
                        <span className={`v ${s.profitR >= 0 ? "pos" : "neg"}`}>{fmtR(s.profitR)}</span>
                      </span>
                      <span className="chip static">
                        <span className="k">Активных</span> <span className="v">{s.open}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
