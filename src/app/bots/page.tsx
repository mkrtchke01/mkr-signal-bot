"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtPct, fmtUsd } from "@/lib/format";
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
      <h1>🤖 Кастомные боты</h1>
      <p className="hint">
        Стратегии, которые нельзя собрать в конструкторе: многотаймфреймовый
        анализ, уровневые входы, сопровождение позиции. Каждый бот сигналит
        в подключённые Telegram-каналы. Открой бота, чтобы увидеть активные
        сетапы, настройки и полную историю.
      </p>
      {bots.map((b) => {
        const s = b.stats;
        const closed = s.total - s.open;
        return (
          <Link
            key={b.slug}
            href={`/bots/${b.slug}`}
            style={{ textDecoration: "none", color: "inherit", display: "block" }}
          >
            <div className="card trader-card" style={{ cursor: "pointer" }}>
              <div className="trader-head">
                <span className="name">{b.name}</span>
                <span className={`badge ${b.enabled ? "running" : "paused"}`}>
                  {b.enabled ? "работает" : "на паузе"}
                </span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {runLabel(b.enabled, b.enabledAt)}
                </span>
                <span className="muted" style={{ marginLeft: "auto" }}>→</span>
              </div>
              <p className="hint" style={{ margin: 0 }}>{b.short}</p>
              <div className="chips">
                <span className="chip">💼 {closed} сделок</span>
                <span className="chip">🎯 {s.tp1Reached} дошли до TP1</span>
                <span className="chip">✅ {s.trail} снял трейлинг</span>
                <span className="chip">🟩 {s.part} плюс по TP1</span>
                <span className="chip">⛔ {s.sl} по стопу</span>
                <span className="chip">🚪 {s.early} идея не пошла</span>
                <span className="chip">⌛ {s.time} по времени</span>
                <span className="chip">🔄 {s.open} активных</span>
                <span className="chip">
                  {s.profitUsd >= 0 ? "📈" : "📉"} {fmtUsd(s.profitUsd)}
                </span>
                <span className="chip">〽️ {fmtPct(s.profitPct)} движения</span>
              </div>
            </div>
          </Link>
        );
      })}
    </main>
  );
}
