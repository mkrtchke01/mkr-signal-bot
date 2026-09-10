// Восстановление пути сделки по свечам: где взяли TP1, где включился трейлинг,
// как ползла лесенка стопа, где были лучшая и худшая цены.
//
// В базе этого нет: bot_setups хранит только итог (вход, выход, статус, деньги),
// а промежуточные события уходили сообщением в канал и там растворялись.
// Зато сопровождение — чистая функция trackCandle, ровно тот код, что вёл
// позицию вживую: прогон по тем же свечам даёт те же точки.
//
// Прогон — не главный источник правды. Длинную сделку рисуем крупными свечами,
// а одна такая свеча может задеть и цель, и стоп: консервативный порядок
// проверок в trackCandle покажет худший исход. Поэтому факты из базы (взят ли
// TP1, чем и по какой цене закрылись) главнее, а прогон добавляет к ним время
// и лесенку. Касание уровня при этом от таймфрейма не зависит: хай крупной
// свечи — это максимум её минуток.

import { trackCandle } from "./track";
import type { TrackState } from "./track";
import type { BotSetup, Candle } from "./types";

export type TradeEventKind = "ENTRY" | "TP1" | "TRAIL_ON" | "TARGET" | "EXIT";

export interface TradeEvent {
  kind: TradeEventKind;
  time: number;   // время свечи, на которой событие произошло
  price: number;
  label: string;
  note?: string;
}

// Ступень стопа: с этого момента стоп стоит на этой цене
export interface StopStep { time: number; stop: number }

export interface Extreme { time: number; price: number; pct: number }

export interface TradeReplay {
  events: TradeEvent[];
  stops: StopStep[];
  best: Extreme | null;   // максимум хода в нашу сторону (MFE)
  worst: Extreme | null;  // максимум хода против (MAE)
}

const EXIT_LABEL: Record<string, string> = {
  TP: "тейк — цель взята целиком",
  TRAIL: "выход по трейлингу",
  PART: "остаток выбит стопом, TP1 уже взят",
  SL: "стоп",
  TIME: "выход по лимиту удержания",
  CANCELLED: "закрыт вручную по рынку",
};

export function entryMs(s: BotSetup): number {
  return new Date(s.filledAt ?? s.createdAt).getTime();
}

export function exitMs(s: BotSetup): number {
  return s.closedAt ? new Date(s.closedAt).getTime() : Date.now();
}

// Свечи в границах сделки. Правая граница — свеча, в которой бот закрылся:
// всё, что было с ценой после выхода, к сделке уже не относится.
function tradeWindow(s: BotSetup, candles: Candle[]): Candle[] {
  const from = entryMs(s);
  const to = s.closedAt ? new Date(s.closedAt).getTime() : Infinity;
  return candles.filter((c) => c.closeTime >= from && c.openTime <= to);
}

function firstTouch(win: Candle[], level: number, up: boolean): Candle | null {
  for (const c of win) {
    if (up ? c.high >= level : c.low <= level) return c;
  }
  return null;
}

function extremes(s: BotSetup, win: Candle[]): { best: Extreme | null; worst: Extreme | null } {
  const isLong = s.direction === "LONG";
  const pct = (p: number) => Math.round(
    (isLong ? p / s.entryPrice - 1 : 1 - p / s.entryPrice) * 10000,
  ) / 100;
  let best: Extreme | null = null;
  let worst: Extreme | null = null;
  for (const c of win) {
    const fav = isLong ? c.high : c.low;
    const adv = isLong ? c.low : c.high;
    if (!best || (isLong ? fav > best.price : fav < best.price)) {
      best = { time: c.openTime, price: fav, pct: pct(fav) };
    }
    if (!worst || (isLong ? adv < worst.price : adv > worst.price)) {
      worst = { time: c.openTime, price: adv, pct: pct(adv) };
    }
  }
  return { best, worst };
}

function exitEvent(s: BotSetup): TradeEvent | null {
  if (!s.closedAt || s.exitPrice === null) return null;
  return {
    kind: "EXIT",
    time: new Date(s.closedAt).getTime(),
    price: s.exitPrice,
    label: EXIT_LABEL[s.status] ?? "выход",
    note: s.closeReason ?? undefined,
  };
}

// ── Фьючерсные боты: сопровождение считает trackCandle ──
function replayFutures(s: BotSetup, win: Candle[]): TradeReplay {
  const isLong = s.direction === "LONG";
  const st: TrackState = {
    stop: s.initialStop, best: s.entryPrice,
    tp1Done: false, trailOn: false, moved: false,
  };
  const stops: StopStep[] = [{ time: win[0]?.openTime ?? entryMs(s), stop: s.initialStop }];
  let tp1At: Candle | null = null;
  let trailAt: Candle | null = null;

  for (const c of win) {
    const wasTrail = st.trailOn;
    const prevStop = st.stop;
    // Стоп внутри окна означал бы конец сделки, но на крупной свече он может
    // быть ложным (минутки шли иначе). Правая граница окна уже задана выходом
    // из базы, поэтому прогон не прерываем — просто пропускаем такую свечу.
    const step = trackCandle(s, st, c);
    if (step.tp1Hit && !tp1At) tp1At = c;
    if (st.trailOn && !wasTrail) trailAt = c;
    if (st.stop !== prevStop) stops.push({ time: c.openTime, stop: st.stop });
  }

  const events: TradeEvent[] = [{
    kind: "ENTRY", time: entryMs(s), price: s.entryPrice,
    label: `вход ${s.direction}`, note: s.reasons?.entry,
  }];

  // TP1 показываем, только если база подтверждает: на крупной свече, задевшей
  // и цель, и стоп, порядок внутри бара по свече не восстановить.
  if (!s.tpFull && (s.tp1Done || s.status === "TP")) {
    const c = tp1At ?? firstTouch(win, s.tp1, isLong);
    if (c) {
      events.push({
        kind: "TP1", time: c.openTime, price: s.tp1,
        label: `TP1 (${s.rr1}R) — зафиксирована половина`, note: s.reasons?.tp1,
      });
    }
  }
  if (!s.tpFull && s.trailAbs > 0 && s.activateAt > 0) {
    const c = trailAt ?? (s.trailOn ? firstTouch(win, s.activateAt, isLong) : null);
    if (c) {
      events.push({
        kind: "TRAIL_ON", time: c.openTime, price: s.activateAt,
        label: "трейлинг подхватил остаток", note: s.reasons?.trail,
      });
    }
  }
  const exit = exitEvent(s);
  if (exit) events.push(exit);
  events.sort((a, b) => a.time - b.time);

  return { events, stops, ...extremes(s, win) };
}

// ── Мемкоин-бот: спот без биржевых стопов. Колонки те же, но смысл другой:
// tp1 — ориентир ×2, stop_price — уровень инвалидации, activate_at — цена
// включения выхода по откату, trail_abs — доля отката от пика. ──
const DEX_MILESTONE = 1.5; // отметка +50%, ей же помечается tp1_done

function replayDex(s: BotSetup, win: Candle[]): TradeReplay {
  const retrace = s.trailAbs > 0 && s.trailAbs < 1 ? s.trailAbs : 0;
  const stops: StopStep[] = [{ time: win[0]?.openTime ?? entryMs(s), stop: s.stopPrice }];
  let peak = s.entryPrice;
  let armed = false;
  let line = s.stopPrice;
  for (const c of win) {
    peak = Math.max(peak, c.high);
    if (!armed && s.activateAt > 0 && peak >= s.activateAt) armed = true;
    if (!armed || !retrace) continue;
    const next = Math.max(line, peak * (1 - retrace));
    if (next !== line) {
      line = next;
      stops.push({ time: c.openTime, stop: line });
    }
  }

  const milestone = s.entryPrice * DEX_MILESTONE;
  const events: TradeEvent[] = [{
    kind: "ENTRY", time: entryMs(s), price: s.entryPrice,
    label: "покупка", note: s.reasons?.entry,
  }];
  const arm = s.activateAt > 0 ? firstTouch(win, s.activateAt, true) : null;
  if (arm) {
    events.push({
      kind: "TRAIL_ON", time: arm.openTime, price: s.activateAt,
      label: `включился выход по откату ${Math.round(retrace * 100)}% от пика`,
    });
  }
  const ms = firstTouch(win, milestone, true);
  if (ms) {
    events.push({
      kind: "TP1", time: ms.openTime, price: milestone,
      label: "+50% — можно снять часть",
    });
  }
  const tgt = firstTouch(win, s.tp1, true);
  if (tgt) {
    events.push({ kind: "TARGET", time: tgt.openTime, price: s.tp1, label: "ориентир +100%" });
  }
  const exit = exitEvent(s);
  if (exit) events.push(exit);
  events.sort((a, b) => a.time - b.time);

  return { events, stops, ...extremes(s, win) };
}

export function replayTrade(s: BotSetup, candles: Candle[]): TradeReplay {
  const win = tradeWindow(s, candles);
  return s.poolAddress ? replayDex(s, win) : replayFutures(s, win);
}
