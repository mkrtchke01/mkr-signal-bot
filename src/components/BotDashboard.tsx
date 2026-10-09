"use client";

// Страница кастомного бота. Сигналы бота общие для всех (статистика в R),
// а деньги у каждого свои: включаю ли я бота на свой капитал, с каким
// риском, мои сделки и их итог в $.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import TradeModal from "./TradeModal";
import {
  expectedRR, fmtMoney, fmtPct, fmtPrice, fmtRR, fmtUsd, fmtWinRate, winRate,
} from "@/lib/format";
import { fmtR, setupR } from "@/lib/rMultiple";
import type { BotSetup, BotStats, UserBotStats, UserTrade } from "@/lib/types";

interface BotConfig {
  scanMinutes: number; maxHoldHours: number;
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
  isAdmin: boolean;
  mine: {
    enabled: boolean;
    riskPct: number;
    stats: UserBotStats;
    trades: UserTrade[];
    account: { balance: number; free: number };
  };
  limits: { minRisk: number; maxRisk: number };
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "в позиции",
  TP: "тейк",
  TRAIL: "снял трейлинг",
  PART: "плюс по TP1",
  SL: "стоп",
  TIME: "по времени",
  CANCELLED: "закрыт вручную",
  SKIPPED: "пропущено",
};
const STATUS_BADGE: Record<string, string> = {
  OPEN: "running", TP: "tp", TRAIL: "tp", PART: "tp", SL: "sl",
  TIME: "time", CANCELLED: "paused", SKIPPED: "paused",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// Биржа бота: подписи в инструкции «как выставить». Все боты торгуют на BingX.
interface ExchangeLabels { name: string; maker: string; taker: string }
const BINGX_LABELS: ExchangeLabels = { name: "BingX", maker: "0.02%", taker: "0.05%" };

export default function BotDashboard({
  slug, title, intro, exchange = BINGX_LABELS,
}: {
  slug: string; title: string; intro: React.ReactNode; exchange?: ExchangeLabels;
}) {
  const [data, setData] = useState<BotData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // id сделки, чья карточка с графиком открыта поверх списка
  const [trade, setTrade] = useState<string | null>(null);
  const [tab, setTab] = useState<"mine" | "all">("mine");
  const [risk, setRisk] = useState("");
  // Показывать только сигналы, по которым у меня открыта сделка. Запоминаем
  // в браузере: это удобство одного зрителя, а не настройка аккаунта.
  const [onlyMine, setOnlyMine] = useState(false);
  useEffect(() => {
    try { setOnlyMine(localStorage.getItem("mkr-only-mine") === "1"); } catch { /* приватный режим */ }
  }, []);
  function toggleOnlyMine(v: boolean) {
    setOnlyMine(v);
    try { localStorage.setItem("mkr-only-mine", v ? "1" : "0"); } catch { /* приватный режим */ }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/bot?bot=${slug}`);
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      const j: BotData = await res.json();
      setData(j);
      setRisk((r) => r || String(j.mine.riskPct));
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

  // Личный сброс: стираются только мои сделки по этому боту
  async function resetMine() {
    const n = (data?.mine.stats.taken ?? 0) + (data?.mine.stats.skipped ?? 0);
    if (!confirm(
      `Удалить твою историю по боту «${title}»? Сотрутся ${n} твоих сделок, включая `
      + `открытые. Общие сигналы бота и чужие сделки не затронет.`,
    )) return;
    await post({ action: "reset", confirm: "RESET" }, "Твоя история очищена");
  }

  // Админ: общий сброс сигналов вместе с личными сделками по ним
  async function resetAll() {
    const n = data?.stats.total ?? 0;
    if (!confirm(
      `Удалить ВСЮ историю сигналов бота «${title}»? Сотрутся ${n} сигналов и все `
      + `личные сделки пользователей по ним — без сообщений в каналы.`,
    )) return;
    await post({ action: "resetAll", confirm: "RESET" }, "Общая история очищена");
  }

  async function setupAction(url: string, method: string, body: unknown, ok: string) {
    setBusy(true);
    setNote("");
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setNote(ok);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Админ: позиция на бирже жива, а бот закрыл сигнал по ошибке — вернуть в работу
  async function reopenSetup(s: BotSetup) {
    if (!confirm(
      `Вернуть сигнал #${s.symbol} в работу? Результат ${fmtR(setupR(s))} уберётся `
      + `из статистики, цели пересчитаются по текущим правилам, вход и стоп останутся `
      + `прежними. Личные сделки, закрытые вместе с ним, тоже откроются.`,
    )) return;
    await setupAction(`/api/bot/setups/${s.id}`, "POST", {},
      `#${s.symbol} возвращён в работу — новые настройки ушли в каналы`);
  }

  // Личное: закрыть мою сделку по рынку, сигнал продолжает жить
  async function closeMine(s: BotSetup) {
    if (!confirm(`Закрыть твою сделку #${s.symbol} по рынку? Сам сигнал продолжит работу.`)) return;
    await setupAction(`/api/bot/setups/${s.id}`, "DELETE", undefined, `#${s.symbol}: твоя сделка закрыта`);
  }

  async function undoMine(s: BotSetup) {
    await setupAction(`/api/bot/setups/${s.id}`, "POST", { action: "undo" },
      `#${s.symbol}: твоя сделка снова в работе`);
  }

  if (error) return <p className="error">Ошибка: {error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  const { config, regime, setups, stats, mine, isAdmin } = data;
  const history = setups.filter((s) => s.status !== "OPEN");
  const myTrade = new Map(mine.trades.map((t) => [t.setupId, t]));
  const allActive = setups.filter((s) => s.status === "OPEN");
  const active = onlyMine
    ? allActive.filter((s) => myTrade.get(s.id)?.status === "OPEN")
    : allActive;
  const bySetup = new Map(setups.map((s) => [s.id, s]));
  const myHistory = mine.trades.filter((t) => t.status !== "OPEN");
  const ms = mine.stats;

  return (
    <main>
      <p style={{ margin: "0 0 8px" }}>
        <Link href="/bots" className="muted">← Кастомные боты</Link>
      </p>
      <h1>{title}</h1>
      <details className="prose" open>
        <summary>Как работает стратегия</summary>
        <div className="prose-body hint">{intro}</div>
      </details>

      <div className="card">
        <div className="trader-head">
          <span className="name">Мой капитал</span>
          <span className={`badge ${mine.enabled ? "running" : "paused"}`}>
            {mine.enabled ? "бот торгует на мой капитал" : "бот не торгует на мой капитал"}
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
        <div className="actions" style={{ marginTop: 10 }}>
          <button
            className={`btn sm ${mine.enabled ? "" : "green"}`}
            disabled={busy}
            onClick={() => post({ action: "enable", enabled: !mine.enabled },
              mine.enabled ? "Бот больше не открывает сделки на твой капитал" : "Бот торгует на твой капитал")}
          >
            {mine.enabled ? "⏸ Не торговать на мой капитал" : "▶ Торговать на мой капитал"}
          </button>
          <label className="inline-field">
            риск, % баланса
            <input
              type="number" min={data.limits.minRisk} max={data.limits.maxRisk} step="0.1"
              style={{ width: 80, minHeight: 30, padding: "4px 8px", fontSize: 13 }}
              value={risk} onChange={(e) => setRisk(e.target.value)}
            />
          </label>
          <button
            className="btn sm" disabled={busy || Number(risk) === mine.riskPct}
            onClick={() => post({ action: "risk", riskPct: Number(risk) }, `Риск ${risk}% сохранён`)}
          >Сохранить риск</button>
          <span className="muted" style={{ fontSize: 13 }}>
            баланс {fmtMoney(mine.account.balance)} · свободно {fmtMoney(mine.account.free)}
            {mine.account.balance <= 0 && <> · <Link href="/profile">задай капитал в профиле</Link></>}
          </span>
        </div>
        {isAdmin && (
          <div className="actions" style={{ marginTop: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>Админ: бот ищет сигналы всегда</span>
            <button
              className="btn sm" disabled={busy}
              onClick={() => post({ action: "scan" }, "Скан выполнен")}
            >🔍 Сканировать сейчас</button>
            <label className="inline-field">
              скан каждые
              <select
                value={config.scanMinutes}
                disabled={busy}
                onChange={(e) => post({ action: "config", scanMinutes: Number(e.target.value) })}
              >
                {[1, 5, 15, 30, 60, 120, 240].map((n) => <option key={n} value={n}>{n} мин</option>)}
              </select>
            </label>
          </div>
        )}
        {note && <p className="hint" style={{ marginTop: 8 }}>{note}</p>}
      </div>

      <div className="card">
        <h2>Моя статистика</h2>
        <div className="stats-grid">
          <div className="stat"><div className="v">{ms.taken - ms.open}</div><div className="l">сделок закрыто</div></div>
          <div className="stat">
            <div className="v">{fmtWinRate(winRate(ms.wins, ms.decided))}</div>
            <div className="l">winrate · {ms.wins} из {ms.decided} в плюс</div>
          </div>
          <div className="stat">
            <div className={`v ${ms.profitUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(ms.profitUsd)}</div>
            <div className="l">итог, $ (риск {mine.riskPct}% баланса)</div>
          </div>
          <div className="stat"><div className="v">{ms.open}</div><div className="l">активных сейчас</div></div>
          <div className="stat"><div className="v">{ms.skipped}</div><div className="l">пропущено — не хватило маржи</div></div>
        </div>
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn sm red" disabled={busy || !(ms.taken + ms.skipped)} onClick={resetMine}>
            🧹 Сбросить мою историю
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Общая статистика — все сигналы</h2>
        <div className="stats-grid">
          <div className="stat"><div className="v">{stats.total}</div><div className="l">сигналов всего</div></div>
          <div className="stat"><div className="v">{stats.tp1Reached}</div><div className="l">дошли до цели</div></div>
          <div className="stat">
            <div className="v">{fmtWinRate(winRate(stats.wins, stats.decided))}</div>
            <div className="l">winrate · {stats.wins} из {stats.decided} в плюс</div>
          </div>
          <div className="stat"><div className="v pos">{stats.tp}</div><div className="l">по тейку</div></div>
          <div className="stat"><div className="v pos">{stats.trail}</div><div className="l">снял трейлинг</div></div>
          <div className="stat"><div className="v pos">{stats.part}</div><div className="l">плюс по TP1</div></div>
          <div className="stat"><div className="v neg">{stats.sl}</div><div className="l">стоп до TP1</div></div>
          <div className="stat"><div className="v">{stats.time}</div><div className="l">по времени</div></div>
          <div className="stat">
            <div className={`v ${stats.profitR >= 0 ? "pos" : "neg"}`}>{fmtR(stats.profitR)}</div>
            <div className="l">итог в R (1R = риск сделки)</div>
          </div>
          <div className="stat">
            <div className={`v ${stats.profitPct >= 0 ? "pos" : "neg"}`}>{fmtPct(stats.profitPct)}</div>
            <div className="l">движение цены</div>
          </div>
        </div>
        {isAdmin && (
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn sm red" disabled={busy || !stats.total} onClick={resetAll}>
              🧹 Сбросить общую историю
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              админ: удалит все сигналы бота и личные сделки по ним у всех пользователей
            </span>
          </div>
        )}
      </div>

      <div className="section-head">
        <h2>Активные сигналы {active.length ? `(${active.length})` : ""}</h2>
        <label className="check">
          <input type="checkbox" checked={onlyMine} onChange={(e) => toggleOnlyMine(e.target.checked)} />
          Только мои открытые сигналы
        </label>
      </div>
      {!active.length && (
        <div className="card"><p className="muted">
          {onlyMine && allActive.length
            ? `Открытых сделок на твой капитал нет — всего активных сигналов ${allActive.length}.`
            : "Пока нет активных сигналов. Бот ищет — новые появятся после очередного скана."}
        </p></div>
      )}
      {active.map((s) => {
        const ageH = (Date.now() - new Date(s.createdAt).getTime()) / 3_600_000;
        // У внутридневных ботов лимит удержания — часы, дни там нечитаемы
        const leftH = Math.max(0, config.maxHoldHours - ageH);
        const left = leftH >= 48 ? `${(leftH / 24).toFixed(1)} дн` : `${leftH.toFixed(1)} ч`;
        // Моя сделка по сигналу: суммы, плечо и маржа — по моему объёму
        const mt = myTrade.get(s.id);
        const mp = mt?.status === "OPEN" ? mt.plan : null;
        return (
          <div className="card trader-card" key={s.id}>
            <div className="trader-head">
              <span className="sym">#{s.symbol}</span>
              <span className={`badge ${s.direction.toLowerCase()}`}>{s.direction}</span>
              <span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
              {s.tp1Done && <span className="badge tp">TP1 взят — сделка в плюсе</span>}
              <span className="badge time" title="Ожидаемое риск/прибыль">
                RR {fmtRR(expectedRR(s))}
              </span>
              {s.trailOn && (
                <span className="badge tp">трейлинг ведёт от {fmtPrice(s.bestPrice)}</span>
              )}
              {!mt && <span className="badge paused">не на моём капитале</span>}
              {mt?.status === "OPEN" && <span className="badge running">моя сделка</span>}
              {mt?.status === "SKIPPED" && <span className="badge paused" title={mt.note ?? ""}>пропущено: не хватило маржи</span>}
              {mt?.status === "CANCELLED" && <span className="badge paused">я закрыл вручную</span>}
              <span className="meta-right">
                {fmtTime(s.createdAt)} · осталось {left}
              </span>
            </div>
            <div className="stats-grid">
              <div className="stat"><div className="v">{fmtPrice(s.entryPrice)}</div><div className="l">вход</div></div>
              <div className="stat">
                <div className={`v ${s.tp1Done ? "pos" : "neg"}`}>{fmtPrice(s.stopPrice)}</div>
                <div className="l">
                  стоп{s.trailOn ? " (трейл)" : ""}
                  {mp && ` · ${fmtUsd(s.tp1Done ? mp.pnl.part : mp.pnl.sl)}`}
                </div>
              </div>
              <div className="stat">
                <div className="v pos">{fmtPrice(s.tp1)}</div>
                <div className="l">
                  {s.tpFull ? "тейк" : "TP1"} ({s.rr1}R)
                  {mp && ` · ${fmtUsd(s.tpFull ? mp.pnl.tpFull : mp.pnl.tp1)}`}
                </div>
              </div>
              {s.tpFinal && (
                <div className="stat">
                  <div className="v pos">{fmtPrice(s.tpFinal)}</div>
                  <div className="l">
                    TP2 остатка · {fmtRR(expectedRR(s))}
                    {mp?.pnl.final !== undefined && ` · ${fmtUsd(mp.pnl.final)}`}
                  </div>
                </div>
              )}
              {!s.tpFull && !s.tpFinal && (
                <div className="stat">
                  <div className={`v ${s.trailOn ? "pos" : ""}`}>{fmtPrice(s.activateAt)}</div>
                  <div className="l">
                    трейлинг {s.trailOn ? "включён" : "с этой цены"} · шаг {fmtPrice(s.trailAbs)}
                  </div>
                </div>
              )}
            </div>
            {mp && (
              <div className="chips" style={{ marginBottom: 4 }}>
                <span className="chip static">
                  <span className="k">плечо</span>
                  <span className="v">×{mp.leverage}</span>
                </span>
                <span className="chip static">
                  <span className="k">маржа</span>
                  <span className="v">{fmtMoney(mp.margin)}</span>
                </span>
                <span className="chip static">
                  <span className="k">объём</span>
                  <span className="v">{fmtMoney(mp.notional)}</span>
                </span>
                <span className="chip static">
                  <span className="k">ликвидация</span>
                  <span className="v">{fmtPrice(mp.liqPrice)}</span>
                  <span className="k">
                    {mp.liqPct.toFixed(2)}% vs стоп {mp.stopPct.toFixed(2)}%
                  </span>
                </span>
                <span className="chip static">
                  <span className="k">комиссия ≈</span>
                  <span className="v">{fmtMoney(mp.feeUsd)}</span>
                </span>
              </div>
            )}
            <div className="card-inner brand">
              <b style={{ fontSize: 14, color: "var(--c-1)" }}>
                Как выставить на {exchange.name}
                {s.tpFinal ? " — после TP1 перенести стоп в безубыток" : " — один раз, потом не трогаем"}
              </b>
              <ol className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>
                  Вход по рынку
                  {mp && <>, плечо ×{mp.leverage}, изолированная маржа, объём {fmtMoney(mp.notional)}</>}
                </li>
                {s.tpFull ? (
                  <li>
                    «TP/SL» на весь объём: стоп-лосс <b>{fmtPrice(s.initialStop)}</b>,
                    тейк-профит <b>{fmtPrice(s.tp1)}</b>
                  </li>
                ) : s.tpFinal ? (
                  <>
                    <li>
                      «TP/SL» → режим <b>«Частичная позиция»</b>: стоп-лосс{" "}
                      <b>{fmtPrice(s.initialStop)}</b> на весь объём, тейк-профит{" "}
                      <b>{fmtPrice(s.tp1)}</b> на 50% и тейк-профит{" "}
                      <b>{fmtPrice(s.tpFinal)}</b> на остальные 50%
                    </li>
                    <li>
                      {s.tp1Done ? "TP1 взят — стоп-лосс должен стоять" : "Когда возьмётся TP1 — переставь стоп-лосс"}
                      {" "}в безубыток: <b>{fmtPrice(s.entryPrice)}</b>
                    </li>
                  </>
                ) : (
                  <li>
                    «TP/SL» → режим <b>«Частичная позиция»</b>: стоп-лосс{" "}
                    <b>{fmtPrice(s.initialStop)}</b> на весь объём, тейк-профит{" "}
                    <b>{fmtPrice(s.tp1)}</b> на 50%
                  </li>
                )}
                {!s.tpFull && !s.tpFinal && (
                  <li>
                    Трейлинг-стоп на оставшиеся 50%: откат{" "}
                    <b>{fmtPrice(s.trailAbs)}</b>
                    {s.activateAt > 0 && <> (≈{((s.trailAbs / s.activateAt) * 100).toFixed(2)}%)</>},
                    цена активации{" "}
                    <b>{fmtPrice(s.activateAt)}</b>
                  </li>
                )}
              </ol>
              <p className="hint" style={{ margin: "6px 0 0" }}>
                {s.tpFull ? (
                  <>
                    Биржа сама закроет позицию по одной из двух цен. Тейк лучше поставить
                    лимитным ордером: комиссия мейкера {exchange.maker} вместо{" "}
                    {exchange.taker} по рынку — на коротком стопе эта разница заметна.
                  </>
                ) : s.tpFinal ? (
                  <>
                    Половина фиксируется на {fmtPrice(s.tp1)}, остаток в безубытке идёт
                    до {fmtPrice(s.tpFinal)} — после TP1 сделка в плюсе при любом исходе.
                  </>
                ) : (
                  <>
                    Половина фиксируется на {fmtPrice(s.tp1)} — после этого сделка в плюсе
                    при любом исходе. Если цена дойдёт до {fmtPrice(s.activateAt)}, остаток
                    подхватит трейлинг и биржа доведёт его сама.
                  </>
                )}
              </p>
            </div>
            <div className="hint">
              <div>• Вход: {s.reasons.entry}</div>
              <div>• Стоп: {s.reasons.stop}</div>
              <div>• {s.tpFull ? "Тейк" : "TP1"}: {s.reasons.tp1}</div>
              {!s.tpFull && <div>• {s.tpFinal ? "Остаток" : "Трейлинг"}: {s.reasons.trail}</div>}
            </div>
            <div className="actions">
              <button className="btn sm" onClick={() => setTrade(s.id)}>
                📈 График сделки
              </button>
              {mt?.status === "OPEN" && (
                <button className="btn sm red" disabled={busy} onClick={() => closeMine(s)}>
                  Закрыть мою по рынку
                </button>
              )}
              {mt?.status === "CANCELLED" && (
                <button className="btn sm" disabled={busy} onClick={() => undoMine(s)}>
                  ♻️ Вернуть мою сделку
                </button>
              )}
            </div>
          </div>
        );
      })}

      <h2>История</h2>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>
          Мои сделки ({myHistory.length})
        </button>
        <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
          Все сигналы ({history.length})
        </button>
      </div>

      {tab === "mine" && !myHistory.length && (
        <div className="card"><p className="muted">
          На твой капитал этот бот ещё ничего не закрыл.
          {!mine.enabled && " Включи его выше — и новые сигналы пойдут в твою историю."}
        </p></div>
      )}
      {tab === "mine" && myHistory.length > 0 && (
        <div className="card table-wrap">
          <p className="hint" style={{ margin: "8px 0 2px" }}>
            Сделки на твой капитал: объём от твоего баланса и риска. Нажми на монету — откроется график.
          </p>
          <table>
            <thead>
              <tr>
                <th>Монета</th><th>Напр.</th><th>Статус</th><th>Вход</th><th>Выход</th>
                <th>RR</th><th>Плечо</th><th>Маржа</th><th>Итог, $</th><th>Открыт</th><th>Закрыт</th>
              </tr>
            </thead>
            <tbody>
              {myHistory.map((t) => {
                const s = bySetup.get(t.setupId);
                if (!s) return null;
                return (
                  <tr key={t.id} className="clickable" onClick={() => setTrade(s.id)} title={t.note ?? ""}>
                    <td className="link-cell">#{s.symbol}</td>
                    <td><span className={`badge ${s.direction.toLowerCase()}`}>{s.direction}</span></td>
                    <td><span className={`badge ${STATUS_BADGE[t.status]}`}>{STATUS_LABEL[t.status]}</span></td>
                    <td>{fmtPrice(s.entryPrice)}</td>
                    <td>{t.status === "SKIPPED" ? "—" : fmtPrice(s.exitPrice)}</td>
                    <td>{fmtRR(expectedRR(s))}</td>
                    <td className="muted">{t.plan ? `×${t.plan.leverage}` : "—"}</td>
                    <td className="muted">{t.plan && t.status !== "SKIPPED" ? fmtMoney(t.plan.margin) : "—"}</td>
                    <td className={t.profitUsd === null ? "muted" : t.profitUsd >= 0 ? "pos" : "neg"}>
                      {fmtUsd(t.profitUsd)}
                    </td>
                    <td className="muted">{fmtTime(t.createdAt)}</td>
                    <td className="muted">{fmtTime(t.closedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === "all" && !history.length && <div className="card"><p className="muted">Истории пока нет.</p></div>}
      {tab === "all" && history.length > 0 && (
        <div className="card table-wrap">
          <p className="hint" style={{ margin: "8px 0 2px" }}>
            Все сигналы бота, итог в R — без привязки к чьему-то капиталу. Нажми на монету —
            откроется график сделки с входом, выходом, TP1 и тем, как за ценой шёл стоп.
          </p>
          <table>
            <thead>
              <tr>
                <th>Монета</th><th>Напр.</th><th>Статус</th><th>Вход</th><th>Выход</th>
                <th title="Ожидаемое риск/прибыль: сколько стопов до цели">RR</th>
                <th>Итог, R</th><th>Движение</th><th>Открыт</th><th>Закрыт</th>
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {history.map((s) => {
                const r = setupR(s);
                return (
                  <tr key={s.id} className="clickable" onClick={() => setTrade(s.id)}>
                    <td className="link-cell">#{s.symbol}</td>
                    <td><span className={`badge ${s.direction.toLowerCase()}`}>{s.direction}</span></td>
                    <td><span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span></td>
                    <td>{fmtPrice(s.entryPrice)}</td>
                    <td>{fmtPrice(s.exitPrice)}</td>
                    <td>{fmtRR(expectedRR(s))}</td>
                    <td className={r === null ? "muted" : r >= 0 ? "pos" : "neg"}>{fmtR(r)}</td>
                    <td className={s.profitPct === null ? "muted" : s.profitPct >= 0 ? "pos" : "neg"}>
                      {fmtPct(s.profitPct)}
                    </td>
                    <td className="muted">{fmtTime(s.createdAt)}</td>
                    <td className="muted">{fmtTime(s.closedAt)}</td>
                    {isAdmin && (
                      <td>
                        <button
                          className="btn sm"
                          disabled={busy}
                          title="Админ: бот закрыл сигнал по ошибке — вернуть в работу"
                          onClick={(e) => { e.stopPropagation(); reopenSetup(s); }}
                        >
                          ♻️
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {trade && <TradeModal id={trade} onClose={() => setTrade(null)} />}
    </main>
  );
}
