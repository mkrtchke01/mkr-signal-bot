"use client";

// Панель мемкоин-бота. Отличается от фьючерсной: спот, без плеча и биржевых
// ордеров. Показываем вход, ориентир +100%, пик и уровень «идея не сыграла»,
// плюс ссылку на график DexScreener. Выход приходит сообщением в канал.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import TradeModal from "./TradeModal";
import { fmtPct, fmtTiny } from "@/lib/format";
import type { BotSetup, BotStats } from "@/lib/types";

interface Config {
  enabled: boolean; maxActive: number; scanMinutes: number; maxHoldHours: number;
}
interface Data {
  meta: { slug: string; name: string; short: string };
  config: Config;
  setups: BotSetup[];
  stats: BotStats;
  watchCount: number;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "в позиции", TP: "цель +100%", TRAIL: "вышли по откату",
  PART: "частичный плюс", SL: "не сыграла", TIME: "по времени", CANCELLED: "вручную",
};
const STATUS_BADGE: Record<string, string> = {
  OPEN: "running", TP: "tp", TRAIL: "tp", PART: "tp", SL: "sl", TIME: "time", CANCELLED: "paused",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
function dexUrl(s: BotSetup): string | null {
  return s.chain && s.poolAddress ? `https://dexscreener.com/${s.chain}/${s.poolAddress}` : null;
}

export default function DexBotDashboard({
  slug, title, intro,
}: {
  slug: string; title: string; intro: React.ReactNode;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // id сделки, чья карточка с графиком открыта поверх списка
  const [trade, setTrade] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dexbot");
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
      const res = await fetch("/api/dexbot", {
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

  async function resetHistory() {
    const n = data?.stats.total ?? 0;
    if (!confirm(`Удалить всю историю бота «${title}»? Сотрутся все ${n} сигналов, `
      + `включая открытые позиции — без сообщений в каналы.`)) return;
    await post({ action: "reset", confirm: "RESET" }, "История очищена");
  }

  if (error) return <p className="error">Ошибка: {error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  const { config, setups, stats, watchCount } = data;
  const active = setups.filter((s) => s.status === "OPEN");
  const history = setups.filter((s) => s.status !== "OPEN");
  const wins = stats.tp + stats.trail + stats.part;

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
          <span className="name">Статус</span>
          <span className={`badge ${config.enabled ? "running" : "paused"}`}>
            {config.enabled ? "ищет монеты" : "на паузе"}
          </span>
          <span className="badge time">в наблюдении: {watchCount}</span>
        </div>
        <div className="actions" style={{ marginTop: 10 }}>
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
          <label className="inline-field">
            макс. позиций
            <select
              value={config.maxActive}
              disabled={busy}
              onChange={(e) => post({ action: "config", maxActive: Number(e.target.value) })}
            >
              {[1, 2, 3, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="inline-field">
            скан каждые
            <select
              value={config.scanMinutes}
              disabled={busy}
              onChange={(e) => post({ action: "config", scanMinutes: Number(e.target.value) })}
            >
              {[2, 3, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{n} мин</option>)}
            </select>
          </label>
          <label className="inline-field">
            держим до
            <select
              value={config.maxHoldHours}
              disabled={busy}
              onChange={(e) => post({ action: "config", maxHoldHours: Number(e.target.value) })}
            >
              {[6, 12, 24, 48, 72].map((n) => <option key={n} value={n}>{n} ч</option>)}
            </select>
          </label>
        </div>
        {note && <p className="hint" style={{ marginTop: 8 }}>{note}</p>}
      </div>

      <div className="card">
        <h2>Статистика</h2>
        <div className="stats-grid">
          <div className="stat"><div className="v">{stats.total}</div><div className="l">сигналов всего</div></div>
          <div className="stat"><div className="v pos">{wins}</div><div className="l">в плюс</div></div>
          <div className="stat"><div className="v pos">{stats.tp}</div><div className="l">цель +100%</div></div>
          <div className="stat"><div className="v pos">{stats.trail}</div><div className="l">по откату</div></div>
          <div className="stat"><div className="v neg">{stats.sl}</div><div className="l">не сыграли</div></div>
          <div className="stat"><div className="v">{stats.time}</div><div className="l">по времени</div></div>
          <div className="stat"><div className="v">{stats.open}</div><div className="l">открыто</div></div>
          <div className="stat">
            <div className={`v ${stats.profitPct >= 0 ? "pos" : "neg"}`}>{fmtPct(stats.profitPct)}</div>
            <div className="l">сумма движений</div>
          </div>
        </div>
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn sm red" disabled={busy || !stats.total} onClick={resetHistory}>
            🧹 Сбросить историю
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            сумма движений — это сложенные проценты по сделкам, без учёта размера позиции
          </span>
        </div>
      </div>

      <h2>Активные позиции {active.length ? `(${active.length})` : ""}</h2>
      {!active.length && (
        <div className="card"><p className="muted">
          {config.enabled
            ? "Пока пусто. Бот наблюдает за свежими пулами — сигнал придёт, когда монета начнёт разгон."
            : "Запусти бота, чтобы начать поиск."}
        </p></div>
      )}
      {active.map((s) => {
        const peakGain = (s.bestPrice / s.entryPrice - 1) * 100;
        const url = dexUrl(s);
        return (
          <div className="card trader-card" key={s.id}>
            <div className="trader-head">
              <span className="sym">#{s.symbol}</span>
              <span className="badge long">{s.chain}</span>
              {s.tp1Done && <span className="badge tp">+50% пройдено</span>}
              {s.trailOn && <span className="badge tp">цель +100% взята</span>}
              <span className="meta-right">
                {fmtTime(s.createdAt)}
              </span>
            </div>
            <div className="stats-grid">
              <div className="stat"><div className="v">{fmtTiny(s.entryPrice)}</div><div className="l">вход</div></div>
              <div className="stat"><div className="v pos">{fmtTiny(s.tp1)}</div><div className="l">цель +100%</div></div>
              <div className="stat">
                <div className={`v ${peakGain >= 0 ? "pos" : "neg"}`}>{fmtTiny(s.bestPrice)}</div>
                <div className="l">пик ({fmtPct(peakGain)})</div>
              </div>
              <div className="stat"><div className="v neg">{fmtTiny(s.stopPrice)}</div><div className="l">не сыграла (−35%)</div></div>
            </div>
            <div className="hint">
              <div>• Вход: {s.reasons.entry}</div>
              <div>• Выход: {s.reasons.trail}</div>
              <div>• Провал: {s.reasons.stop}</div>
            </div>
            <div className="actions">
              <button className="btn sm" onClick={() => setTrade(s.id)}>📈 График сделки</button>
              {url && (
                <a className="btn sm" href={url} target="_blank" rel="noreferrer">DexScreener</a>
              )}
            </div>
          </div>
        );
      })}

      <h2>История</h2>
      {!history.length && <div className="card"><p className="muted">Истории пока нет.</p></div>}
      {history.length > 0 && (
        <div className="card table-wrap">
          <p className="hint" style={{ margin: "8px 0 2px" }}>
            Нажми на монету — откроется график сделки с покупкой, пиком и выходом.
          </p>
          <table>
            <thead>
              <tr>
                <th>Монета</th><th>Сеть</th><th>Статус</th><th>Вход</th>
                <th>Выход</th><th>Движение</th><th>Открыт</th><th>Закрыт</th><th></th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => {
                const url = dexUrl(s);
                return (
                  <tr key={s.id} className="clickable" onClick={() => setTrade(s.id)}>
                    <td className="link-cell">#{s.symbol}</td>
                    <td className="muted">{s.chain ?? "—"}</td>
                    <td><span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span></td>
                    <td>{fmtTiny(s.entryPrice)}</td>
                    <td>{fmtTiny(s.exitPrice)}</td>
                    <td className={s.profitPct === null ? "muted" : s.profitPct >= 0 ? "pos" : "neg"}>
                      {fmtPct(s.profitPct)}
                    </td>
                    <td className="muted">{fmtTime(s.createdAt)}</td>
                    <td className="muted">{fmtTime(s.closedAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {url && <a className="muted" href={url} target="_blank" rel="noreferrer">📈</a>}
                    </td>
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
