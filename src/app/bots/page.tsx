"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtUsd } from "@/lib/format";
import type { BotStats } from "@/lib/types";

interface BotListItem {
  slug: string;
  name: string;
  short: string;
  enabled: boolean;
  enabledAt: string | null;
  stats: BotStats;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function runLabel(enabled: boolean, enabledAt: string | null): string {
  if (enabled) return enabledAt ? `запущен с ${fmtDate(enabledAt)}` : "запущен";
  return enabledAt ? `последний запуск ${fmtDate(enabledAt)}` : "ещё не запускался";
}

export default function BotsPage() {
  const [bots, setBots] = useState<BotListItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bots");
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
          return (
            <Link key={b.slug} href={`/bots/${b.slug}`} className="card-link">
              <div className="card trader-card">
                <div className="trader-head">
                  <span className="name">{b.name}</span>
                  <span className={`badge ${b.enabled ? "running" : "paused"}`}>
                    {b.enabled ? "работает" : "на паузе"}
                  </span>
                  <span className="meta-right">{runLabel(b.enabled, b.enabledAt)}</span>
                </div>
                <p className="hint" style={{ margin: 0, maxWidth: "70ch" }}>{b.short}</p>
                <div className="chips">
                  <span className="chip static">
                    <span className="k">Сделок</span> <span className="v">{closed}</span>
                  </span>
                  <span className="chip static">
                    <span className="k">TP</span>
                    <span className="v pos">{s.tp + s.trail + s.part}</span>
                  </span>
                  <span className="chip static">
                    <span className="k">SL</span> <span className="v neg">{s.sl}</span>
                  </span>
                  <span className="chip static">
                    <span className="k">Активных</span> <span className="v">{s.open}</span>
                  </span>
                  <span className="chip static">
                    <span className="k">PnL</span>
                    <span className={`v ${s.profitUsd >= 0 ? "pos" : "neg"}`}>
                      {fmtUsd(s.profitUsd)}
                    </span>
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
