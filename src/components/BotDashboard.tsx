"use client";

// Общая панель кастомного бота: статус, настройки, статистика, активные сетапы
// и история. Работает и с фиксированными целями, и с трейлингом.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtMoney, fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import type { BotSetup, BotStats } from "@/lib/types";

interface BotConfig {
  enabled: boolean; maxActive: number; scanMinutes: number; maxHoldHours: number;
}
interface Regime {
  bias: "LONG" | "SHORT" | "NEUTRAL";
  price: number; ema20d: number; ema50d: number;
  note: string; updatedMs: number;
}
interface BotData {
  meta: { slug: string; name: string; short: string };
  config: BotConfig;
  regime: Regime | null;
  setups: BotSetup[];
  stats: BotStats;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "в позиции",
  TRAIL: "снял трейлинг",
  PART: "плюс по TP1",
  SL: "стоп",
  TIME: "по времени",
  CANCELLED: "закрыт вручную",
};
const STATUS_BADGE: Record<string, string> = {
  OPEN: "running", TRAIL: "tp", PART: "tp", SL: "sl",
  TIME: "time", CANCELLED: "paused",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export default function BotDashboard({
  slug, title, intro,
}: { slug: string; title: string; intro: React.ReactNode }) {
  const [data, setData] = useState<BotData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/bot?bot=${slug}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      setData(await res.json());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function post(body: Record<string, unknown>, okNote = "") {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(`/api/bot?bot=${slug}`, {
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

  // Сброс истории: сетапы стираются из базы насовсем, в каналы ничего не уходит
  async function resetHistory() {
    const n = data?.stats.total ?? 0;
    if (!confirm(
      `Удалить всю историю бота «${title}»? Сотрутся все ${n} сетапов, включая `
      + `открытые позиции — без сообщений в каналы. Восстановить будет нельзя.`,
    )) return;
    await post({ action: "reset", confirm: "RESET" }, "История очищена");
  }

  // Позиция на бирже жива, а бот закрыл её у себя по ошибке — возвращаем в работу
  async function reopenSetup(s: BotSetup) {
    if (!confirm(
      `Вернуть #${s.symbol} в работу? Записанный результат ${fmtUsd(s.profitUsd)} `
      + `уберётся из статистики, цели пересчитаются по текущим правилам, `
      + `а вход и стоп останутся прежними. Делай это, только если позиция `
      + `реально открыта на бирже.`,
    )) return;
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(`/api/bot/setups/${s.id}`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setNote(`#${s.symbol} возвращён в работу — новые настройки ушли в каналы`);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelSetup(s: BotSetup) {
    if (!confirm(
      `Точно закрыть позицию по рынку #${s.symbol}? В каналы уйдёт сообщение.`,
    )) return;
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
  const active = setups.filter((s) => s.status === "OPEN");
  const history = setups.filter((s) => s.status !== "OPEN");

  return (
    <main>
      <p style={{ margin: "0 0 6px" }}>
        <Link href="/bots" className="muted">← Кастомные боты</Link>
      </p>
      <h1>{title}</h1>
      {intro}

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
            макс. позиций
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
              {[5, 15, 30, 60, 120, 240].map((n) => <option key={n} value={n}>{n} мин</option>)}
            </select>
          </label>
        </div>
        {note && <p className="hint" style={{ marginTop: 8 }}>{note}</p>}
      </div>

      <div className="card">
        <h2>Статистика</h2>
        <div className="stats-grid">
          <div className="stat"><div className="v">{stats.total}</div><div className="l">сделок всего</div></div>
          <div className="stat"><div className="v">{stats.tp1Reached}</div><div className="l">дошли до TP1</div></div>
          <div className="stat"><div className="v pos">{stats.trail}</div><div className="l">снял трейлинг</div></div>
          <div className="stat"><div className="v pos">{stats.part}</div><div className="l">плюс по TP1</div></div>
          <div className="stat"><div className="v neg">{stats.sl}</div><div className="l">стоп до TP1</div></div>
          <div className="stat"><div className="v">{stats.time}</div><div className="l">по времени</div></div>
          <div className="stat"><div className="v">{stats.cancelled}</div><div className="l">вручную</div></div>
          <div className="stat">
            <div className={`v ${stats.profitUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(stats.profitUsd)}</div>
            <div className="l">итог, $ (риск $3/сделку)</div>
          </div>
          <div className="stat">
            <div className={`v ${stats.profitPct >= 0 ? "pos" : "neg"}`}>{fmtPct(stats.profitPct)}</div>
            <div className="l">движение цены</div>
          </div>
        </div>
        <div className="trader-actions" style={{ marginTop: 10 }}>
          <button className="btn sm red" disabled={busy || !stats.total} onClick={resetHistory}>
            🧹 Сбросить историю
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            удалит все сетапы и открытые позиции без сообщений в каналы
          </span>
        </div>
      </div>

      <h2>Активные позиции {active.length ? `(${active.length})` : ""}</h2>
      {!active.length && (
        <div className="card"><p className="muted">
          Пока нет активных позиций. {config.enabled
            ? "Бот ищет — новые появятся после очередного скана."
            : "Запусти бота, чтобы начать поиск."}
        </p></div>
      )}
      {active.map((s) => {
        const ageH = (Date.now() - new Date(s.createdAt).getTime()) / 3_600_000;
        const leftDays = Math.max(0, (config.maxHoldHours - ageH) / 24);
        return (
          <div className="card trader-card" key={s.id}>
            <div className="trader-head">
              <span className="sym">#{s.symbol}</span>
              <span className={`badge ${s.direction.toLowerCase()}`}>{s.direction}</span>
              <span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
              {s.tp1Done && <span className="badge tp">TP1 взят — сделка в плюсе</span>}
              {s.trailOn && (
                <span className="badge tp">трейлинг ведёт от {fmtPrice(s.bestPrice)}</span>
              )}
              <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>
                {fmtTime(s.createdAt)} · осталось {leftDays.toFixed(1)} дн
              </span>
            </div>
            <div className="stats-grid">
              <div className="stat"><div className="v">{fmtPrice(s.entryPrice)}</div><div className="l">вход</div></div>
              <div className="stat">
                <div className={`v ${s.tp1Done ? "pos" : "neg"}`}>{fmtPrice(s.stopPrice)}</div>
                <div className="l">
                  стоп{s.trailOn ? " (трейл)" : ""}
                  {s.plan && ` · ${fmtUsd(s.tp1Done ? s.plan.pnl.part : s.plan.pnl.sl)}`}
                </div>
              </div>
              <div className="stat">
                <div className="v pos">{fmtPrice(s.tp1)}</div>
                <div className="l">
                  TP1 ({s.rr1}R){s.plan && ` · ${fmtUsd(s.plan.pnl.tp1)}`}
                </div>
              </div>
              <div className="stat">
                <div className={`v ${s.trailOn ? "pos" : ""}`}>{fmtPrice(s.activateAt)}</div>
                <div className="l">
                  трейлинг {s.trailOn ? "включён" : "с этой цены"} · шаг {fmtPrice(s.trailAbs)}
                </div>
              </div>
            </div>
            {s.plan && (
              <div className="chips" style={{ marginBottom: 4 }}>
                <span className="chip">💵 плечо ×{s.plan.leverage}</span>
                <span className="chip">🔒 маржа {fmtMoney(s.plan.margin)}</span>
                <span className="chip">📦 объём {fmtMoney(s.plan.notional)}</span>
                <span className="chip">
                  🧯 ликвидация {fmtPrice(s.plan.liqPrice)} ({s.plan.liqPct.toFixed(2)}%
                  {" vs "}стоп {s.plan.stopPct.toFixed(2)}%)
                </span>
                <span className="chip">🧾 комиссия ≈ {fmtMoney(s.plan.feeUsd)}</span>
              </div>
            )}
            <div className="card" style={{ margin: "8px 0", background: "rgba(74,158,255,.06)" }}>
              <b style={{ fontSize: 14 }}>⚙️ Как выставить на Bybit — один раз, потом не трогаем</b>
              <ol className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>
                  Вход по рынку
                  {s.plan && <> , плечо ×{s.plan.leverage}, изолированная маржа, объём {fmtMoney(s.plan.notional)}</>}
                </li>
                <li>
                  «TP/SL» → режим <b>«Частичная позиция»</b>: стоп-лосс{" "}
                  <b>{fmtPrice(s.initialStop)}</b> на весь объём, тейк-профит{" "}
                  <b>{fmtPrice(s.tp1)}</b> на 50%
                </li>
                <li>
                  «Скользящий стоп-ордер» → «+ Добавить»: коррекция{" "}
                  <b>{fmtPrice(s.trailAbs)}</b> (режим «По сумме»), цена активации{" "}
                  <b>{fmtPrice(s.activateAt)}</b>
                </li>
              </ol>
              <p className="hint" style={{ margin: "6px 0 0" }}>
                Половина фиксируется на {fmtPrice(s.tp1)} — после этого сделка в плюсе
                при любом исходе. Если цена дойдёт до {fmtPrice(s.activateAt)}, остаток
                подхватит трейлинг и биржа доведёт его сама.
              </p>
            </div>
            <div className="hint">
              <div>• Вход: {s.reasons.entry}</div>
              <div>• Стоп: {s.reasons.stop}</div>
              <div>• TP1: {s.reasons.tp1}</div>
              <div>• Трейлинг: {s.reasons.trail}</div>
            </div>
            <div className="trader-actions">
              <button className="btn sm red" disabled={busy} onClick={() => cancelSetup(s)}>
                Закрыть по рынку
              </button>
            </div>
          </div>
        );
      })}

      <h2>История</h2>
      {!history.length && <div className="card"><p className="muted">Истории пока нет.</p></div>}
      {history.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Монета</th><th>Напр.</th><th>Статус</th><th>Вход</th>
                <th>Выход</th><th>Плечо</th><th>Итог, $</th><th>Движение</th>
                <th>Закрыт</th><th></th>
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
                  <td className="muted">{s.plan ? `×${s.plan.leverage}` : "—"}</td>
                  <td className={s.profitUsd === null ? "" : s.profitUsd >= 0 ? "pos" : "neg"}>
                    {fmtUsd(s.profitUsd)}
                  </td>
                  <td className={s.profitPct === null ? "muted" : s.profitPct >= 0 ? "pos" : "neg"}>
                    {fmtPct(s.profitPct)}
                  </td>
                  <td className="muted">{fmtTime(s.closedAt)}</td>
                  <td>
                    <button
                      className="btn sm"
                      disabled={busy}
                      title="Позиция на бирже осталась открытой — вернуть сделку в работу"
                      onClick={() => reopenSetup(s)}
                    >
                      ♻️
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
