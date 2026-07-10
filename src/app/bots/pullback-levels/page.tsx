"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtPct, fmtPrice } from "@/lib/format";
import type { BotSetup, BotStats } from "@/lib/types";

interface BotConfig { enabled: boolean; maxActive: number; scanMinutes: number }
interface Regime {
  bias: "LONG" | "SHORT" | "NEUTRAL";
  price: number; ema20d: number; ema50d: number;
  note: string; updatedMs: number;
}
interface BotData {
  config: BotConfig;
  regime: Regime | null;
  setups: BotSetup[];
  stats: BotStats;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "ждёт налива",
  OPEN: "в позиции",
  TP: "тейк",
  SL: "стоп",
  BE: "безубыток",
  CANCELLED: "отменён",
  EXPIRED: "истёк",
};
const STATUS_BADGE: Record<string, string> = {
  PENDING: "open", OPEN: "running", TP: "tp", SL: "sl",
  BE: "time", CANCELLED: "paused", EXPIRED: "paused",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export default function BotPage() {
  const [data, setData] = useState<BotData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bot");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      setData(await res.json());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function post(body: Record<string, unknown>, okNote = "") {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch("/api/bot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      if (okNote) setNote(okNote);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelSetup(s: BotSetup) {
    const what = s.status === "OPEN" ? "закрыть позицию по рынку" : "отменить сетап";
    if (!confirm(`Точно ${what} #${s.symbol}? В каналы уйдёт сообщение об отмене.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/bot/setups/${s.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error">Ошибка: {error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  const { config, regime, setups, stats } = data;
  const active = setups.filter((s) => s.status === "PENDING" || s.status === "OPEN");
  const history = setups.filter((s) => s.status !== "PENDING" && s.status !== "OPEN");

  return (
    <main>
      <p style={{ margin: "0 0 6px" }}>
        <Link href="/bots" className="muted">← Кастомные боты</Link>
      </p>
      <h1>🤖 Откат к уровням</h1>
      <p className="hint">
        Автономная стратегия: лонги/шорты в сторону режима BTC. Сигнал публикуется,
        только когда цена уже откатилась к кластеру уровней — вход по рынку по
        текущей цене со стопом и целями на реальных уровнях, дальше бот сопровождает
        позицию: TP1 (фикс 50% + безубыток) → TP2. Сигналы уходят во все каналы
        из раздела «Каналы».
      </p>

      <div className="card">
        <div className="trader-head">
          <span className="name">Статус</span>
          <span className={`badge ${config.enabled ? "running" : "paused"}`}>
            {config.enabled ? "ищет сетапы" : "на паузе"}
          </span>
          {regime && (
            <span className={`badge ${
              regime.bias === "LONG" ? "long" : regime.bias === "SHORT" ? "short" : "time"
            }`}>
              режим BTC: {regime.bias === "NEUTRAL" ? "нейтральный" : regime.bias}
            </span>
          )}
        </div>
        {regime && (
          <p className="hint" style={{ margin: "8px 0" }}>
            {regime.note} BTC {fmtPrice(regime.price)}, дневные EMA20 {fmtPrice(regime.ema20d)}
            {" / "}EMA50 {fmtPrice(regime.ema50d)}. Обновлено{" "}
            {new Date(regime.updatedMs).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.
          </p>
        )}
        <div className="trader-actions" style={{ marginTop: 10 }}>
          <button
            className={`btn sm ${config.enabled ? "" : "green"}`}
            disabled={busy}
            onClick={() => post({ action: "toggle" })}
          >
            {config.enabled ? "⏸ Пауза" : "▶ Запустить"}
          </button>
          <button
            className="btn sm"
            disabled={busy || !config.enabled}
            onClick={() => post({ action: "scan" }, "Скан выполнен")}
          >
            🔍 Сканировать сейчас
          </button>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: 0 }}>
            макс. сетапов
            <select
              value={config.maxActive}
              disabled={busy}
              style={{ width: 70 }}
              onChange={(e) => post({ action: "config", maxActive: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: 0 }}>
            скан каждые
            <select
              value={config.scanMinutes}
              disabled={busy}
              style={{ width: 90 }}
              onChange={(e) => post({ action: "config", scanMinutes: Number(e.target.value) })}
            >
              {[15, 30, 60, 120, 240].map((n) => <option key={n} value={n}>{n} мин</option>)}
            </select>
          </label>
        </div>
        {note && <p className="hint" style={{ marginTop: 8 }}>{note}</p>}
      </div>

      <div className="card">
        <h2>Статистика</h2>
        <div className="stats-grid">
          <div className="stat"><div className="v">{stats.total}</div><div className="l">сетапов всего</div></div>
          <div className="stat"><div className="v pos">{stats.tp}</div><div className="l">TP2</div></div>
          <div className="stat"><div className="v">{stats.be}</div><div className="l">безубыток</div></div>
          <div className="stat"><div className="v neg">{stats.sl}</div><div className="l">стоп</div></div>
          <div className="stat"><div className="v">{stats.cancelled}</div><div className="l">отменено</div></div>
          <div className="stat">
            <div className={`v ${stats.profitPct >= 0 ? "pos" : "neg"}`}>{fmtPct(stats.profitPct)}</div>
            <div className="l">профит (движение цены)</div>
          </div>
        </div>
      </div>

      <h2>Активные сетапы {active.length ? `(${active.length})` : ""}</h2>
      {!active.length && (
        <div className="card"><p className="muted">
          Пока нет активных сетапов. {config.enabled
            ? "Бот ищет — новые появятся после очередного скана."
            : "Запусти бота, чтобы начать поиск."}
        </p></div>
      )}
      {active.map((s) => (
        <div className="card trader-card" key={s.id}>
          <div className="trader-head">
            <span className="sym">#{s.symbol}</span>
            <span className={`badge ${s.direction.toLowerCase()}`}>{s.direction}</span>
            <span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
            {s.tp1Done && <span className="badge tp">TP1 взят, стоп в БУ</span>}
            <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>
              {fmtTime(s.createdAt)}
            </span>
          </div>
          <div className="stats-grid">
            <div className="stat"><div className="v">{fmtPrice(s.entryPrice)}</div><div className="l">вход</div></div>
            <div className="stat"><div className="v neg">{fmtPrice(s.stopPrice)}</div><div className="l">стоп{s.tp1Done ? " (БУ)" : ""}</div></div>
            <div className="stat"><div className="v pos">{fmtPrice(s.tp1)}</div><div className="l">TP1 (RR {s.rr1})</div></div>
            <div className="stat"><div className="v pos">{fmtPrice(s.tp2)}</div><div className="l">TP2 (RR {s.rr2})</div></div>
          </div>
          <div className="hint">
            <div>• Вход: {s.reasons.entry}</div>
            <div>• Стоп: {s.reasons.stop}</div>
            <div>• TP1: {s.reasons.tp1}</div>
            <div>• TP2: {s.reasons.tp2}</div>
          </div>
          <div className="trader-actions">
            <button className="btn sm red" disabled={busy} onClick={() => cancelSetup(s)}>
              {s.status === "OPEN" ? "Закрыть по рынку" : "Отменить сетап"}
            </button>
          </div>
        </div>
      ))}

      <h2>История</h2>
      {!history.length && <div className="card"><p className="muted">Истории пока нет.</p></div>}
      {history.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Монета</th><th>Напр.</th><th>Статус</th><th>Вход</th>
                <th>Выход</th><th>Результат</th><th>Закрыт</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.id}>
                  <td>#{s.symbol}</td>
                  <td><span className={`badge ${s.direction.toLowerCase()}`}>{s.direction}</span></td>
                  <td><span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span></td>
                  <td>{fmtPrice(s.entryPrice)}</td>
                  <td>{fmtPrice(s.exitPrice)}</td>
                  <td className={s.profitPct === null ? "" : s.profitPct >= 0 ? "pos" : "neg"}>
                    {fmtPct(s.profitPct)}
                  </td>
                  <td className="muted">{fmtTime(s.closedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
