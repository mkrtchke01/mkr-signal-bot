"use client";

// Карточка одной сделки поверх списка: график с входом и выходом, цифры плана
// и хронология того, что с позицией происходило.

import { useEffect, useState } from "react";
import TradeChart from "./TradeChart";
import { fmtDuration, fmtMoney, fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import type { TradeChart as ChartData } from "@/lib/tradeChart";
import type { TradeEvent } from "@/lib/replay";
import type { BotSetup } from "@/lib/types";

const STATUS_LABEL: Record<string, string> = {
  OPEN: "в позиции",
  TP: "тейк",
  TRAIL: "снял трейлинг",
  PART: "плюс по TP1",
  SL: "стоп",
  TIME: "по времени",
  CANCELLED: "закрыт вручную",
};
const STATUS_BADGE: Record<string, string> = {
  OPEN: "running", TP: "tp", TRAIL: "tp", PART: "tp", SL: "sl",
  TIME: "time", CANCELLED: "paused",
};
const EVENT_DOT: Record<TradeEvent["kind"], string> = {
  ENTRY: "brand", TP1: "green", TRAIL_ON: "yellow", EXIT: "c1",
};

// «1 раз», «2 раза», «5 раз»
function times(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 14) return "раз";
  return n % 10 === 1 ? "раз" : n % 10 >= 2 && n % 10 <= 4 ? "раза" : "раз";
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// Ссылка на «большой» график — на биржу, где бот торгует
function outsideUrl(s: BotSetup, exchange: string): string {
  if (exchange === "BingX") {
    return `https://bingx.com/en/perpetual/${s.symbol.replace(/USDT$/, "-USDT")}`;
  }
  return `https://www.bybit.com/trade/usdt/${s.symbol}`;
}

export default function TradeModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ setup: BotSetup; chart: ChartData } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/bot/setups/${id}/chart`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error ?? `${res.status} ${res.statusText}`);
        if (alive) setData(j);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const s = data?.setup;
  const chart = data?.chart;

  const openedMs = s ? new Date(s.filledAt ?? s.createdAt).getTime() : 0;
  const closedMs = s?.closedAt ? new Date(s.closedAt).getTime() : null;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {s ? (
            <>
              <span className="sym">#{s.symbol}</span>
              <span className={`badge ${s.direction.toLowerCase()}`}>{s.direction}</span>
              <span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
              {chart && (
                <span className="muted" style={{ fontSize: 13 }}>
                  {chart.exchange} · свечи {chart.tf}
                </span>
              )}
            </>
          ) : <span className="sym">Сделка</span>}
          <button className="btn sm icon modal-x" onClick={onClose} title="Закрыть">✕</button>
        </div>

        <div className="modal-body">
          {error && <p className="error">Ошибка: {error}</p>}
          {!data && !error && <p className="muted">Тянем свечи с биржи…</p>}

          {s && chart && (
            <>
              <TradeChart
                data={chart} setupId={s.id} fmt={fmtPrice} long={s.direction === "LONG"}
              />

              <div className="stats-grid">
                <div className="stat">
                  <div className="v">{fmtPrice(s.entryPrice)}</div>
                  <div className="l">вход · {fmtWhen(openedMs)}</div>
                </div>
                <div className="stat">
                  <div className="v">{fmtPrice(s.exitPrice)}</div>
                  <div className="l">
                    выход{closedMs ? ` · ${fmtWhen(closedMs)}` : " — ещё в позиции"}
                  </div>
                </div>
                <div className="stat">
                  <div className="v neg">{fmtPrice(s.initialStop)}</div>
                  <div className="l">начальный стоп</div>
                </div>
                <div className="stat">
                  <div className="v pos">{fmtPrice(s.tp1)}</div>
                  <div className="l">{s.tpFull ? "тейк" : `TP1 · ${s.rr1}R`}</div>
                </div>
                <div className="stat">
                  <div className="v">{fmtPrice(s.stopPrice)}</div>
                  <div className="l">стоп на выходе{s.trailOn ? " (трейл)" : ""}</div>
                </div>
                {chart.best && (
                  <div className="stat">
                    <div className={`v ${chart.best.pct >= 0 ? "pos" : "neg"}`}>
                      {fmtPct(chart.best.pct)}
                    </div>
                    <div className="l">лучший ход · {fmtPrice(chart.best.price)}</div>
                  </div>
                )}
                {chart.worst && (
                  <div className="stat">
                    <div className={`v ${chart.worst.pct >= 0 ? "pos" : "neg"}`}>
                      {fmtPct(chart.worst.pct)}
                    </div>
                    <div className="l">
                      {/* цена может ни разу не уйти ниже входа — тогда это не просадка */}
                      {chart.worst.pct >= 0 ? "худшая цена" : "просадка"} · {fmtPrice(chart.worst.price)}
                    </div>
                  </div>
                )}
                <div className="stat">
                  <div className="v">{fmtDuration((closedMs ?? Date.now()) - openedMs)}</div>
                  <div className="l">в позиции</div>
                </div>
                <div className={`stat`}>
                  <div className={`v ${(s.profitPct ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {fmtPct(s.profitPct)}
                  </div>
                  <div className="l">движение цены</div>
                </div>
                <div className="stat">
                  <div className={`v ${(s.profitUsd ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {fmtUsd(s.profitUsd)}
                  </div>
                  <div className="l">
                    итог{s.plan ? ` · ×${s.plan.leverage}, ${fmtMoney(s.plan.notional)}` : ""}
                  </div>
                </div>
              </div>

              <div className="card-inner">
                <b style={{ fontSize: 14, color: "var(--c-1)" }}>Что происходило</b>
                <ul className="timeline">
                  {chart.events.map((e, i) => (
                    <li key={i}>
                      <span className={`dot ${EVENT_DOT[e.kind]}`} />
                      <span className="when">{fmtWhen(e.time)}</span>
                      <span className="what">
                        <b>{e.label}</b> · {fmtPrice(e.price)}
                        {e.note && <span className="hint"> {e.note}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                {chart.stops.length > 1 && (
                  <p className="hint" style={{ margin: "8px 0 0" }}>
                    Стоп подтягивался {chart.stops.length - 1}{" "}
                    {times(chart.stops.length - 1)}: {fmtPrice(chart.stops[0].stop)} →{" "}
                    {fmtPrice(chart.stops[chart.stops.length - 1].stop)}. Пунктирная красная линия
                    на графике — где стоп стоял в каждый момент.
                  </p>
                )}
                <p className="hint" style={{ margin: "8px 0 0" }}>
                  Промежуточные точки восстановлены прогоном свечей через тот же код
                  сопровождения, что вёл позицию. Итог сделки — из базы, как записал бот.
                </p>
              </div>

              {s.reasons?.entry && (
                <div className="hint">
                  <div>• Вход: {s.reasons.entry}</div>
                  {s.reasons.stop && <div>• Стоп: {s.reasons.stop}</div>}
                  {s.reasons.tp1 && <div>• {s.tpFull ? "Тейк" : "TP1"}: {s.reasons.tp1}</div>}
                  {!s.tpFull && s.reasons.trail && <div>• Трейлинг: {s.reasons.trail}</div>}
                </div>
              )}

              <div className="actions">
                <a
                  className="btn sm" target="_blank" rel="noreferrer"
                  href={outsideUrl(s, chart.exchange)}
                >
                  📈 Открыть на {chart.exchange}
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
