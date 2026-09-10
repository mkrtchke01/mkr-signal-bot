"use client";

// График одной сделки: свечи вокруг неё, зоны риска и цели, лесенка стопа
// и метки событий (вход, TP1, включение трейлинга, выход).
//
// Рисуем руками в SVG, без библиотеки: нужен один конкретный график, а не
// универсальный движок, зато он тянет цвета из темы и весит ноль килобайт.
//
// График листается и масштабируется. Окно задаётся правым краем (i1) и числом
// свечей (n) — так при зуме и догрузке истории картинка не «уезжает»: индексы
// уже загруженных свечей сдвигаются вместе с ней. Когда левый край окна уходит
// за начало загруженного, соседний кусок подтягивается тем же таймфреймом.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fmtPct } from "@/lib/format";
import { TF_MS } from "@/lib/types";
import type { ChartCandle, ChartLevel, TradeChart as Data } from "@/lib/tradeChart";
import type { TradeEvent } from "@/lib/replay";

const W = 1000;
const H = 430;
const PAD_L = 10;
const PAD_R = 74;  // справа шкала цен
const PAD_T = 48;  // сверху две строки под метки событий
const PAD_B = 26;

const MIN_BARS = 25;
const MAX_BARS = 700;
const CHUNK = 300;    // сколько свечей просим за раз
const MAX_LOADED = 4000; // дальше не листаем: и памяти жалко, и смысла мало

const TONE: Record<string, string> = {
  entry: "var(--brand)",
  stop: "var(--red)",
  tp: "var(--green)",
  trail: "var(--yellow)",
};

const EVENT_TONE: Record<TradeEvent["kind"], string> = {
  ENTRY: "var(--brand)",
  TP1: "var(--green)",
  TARGET: "var(--green)",
  TRAIL_ON: "var(--yellow)",
  EXIT: "var(--c-1)",
};

const EVENT_SHORT: Record<TradeEvent["kind"], string> = {
  ENTRY: "вход",
  TP1: "TP1",
  TARGET: "цель",
  TRAIL_ON: "трейл",
  EXIT: "выход",
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function fmtTime(ms: number, withDate: boolean): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!withDate) return hm;
  return `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

export default function TradeChart({
  data, setupId, fmt, long,
}: {
  data: Data;
  setupId: string;
  fmt: (p: number | null | undefined) => string;
  long: boolean; // направление сделки: от него зависит, где «в плюс»
}) {
  const step = TF_MS[data.tf];
  const clipId = useId();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; i1: number } | null>(null);
  const touched = useRef(false); // график уже двигали руками

  const [all, setAll] = useState<ChartCandle[]>(data.candles);
  // Правый край окна (исключая) и ширина в свечах — одним состоянием: колесо
  // мыши сыплет событиями пачкой, и обновления должны складываться, а не
  // считаться каждое от одного и того же устаревшего значения.
  const [view, setView] = useState({
    i1: data.candles.length, n: Math.max(data.candles.length, MIN_BARS),
  });
  const [busy, setBusy] = useState(false);
  const [atStart, setAtStart] = useState(false); // истории левее нет
  const [atEnd, setAtEnd] = useState(false);     // правее только будущее
  const [hover, setHover] = useState<number | null>(null); // глобальный индекс
  const [failed, setFailed] = useState("");

  // Длина в ref: обновления состояния считаются вне рендера и должны видеть
  // актуальный размер массива, а не тот, что был при создании обработчика
  const lenRef = useRef(all.length);
  lenRef.current = all.length;

  // Новая сделка — новое окно
  useEffect(() => {
    setAll(data.candles);
    setView({ i1: data.candles.length, n: Math.max(data.candles.length, MIN_BARS) });
    setAtStart(false);
    setAtEnd(false);
    setFailed("");
  }, [data]);

  const bars = clamp(view.n, MIN_BARS, MAX_BARS);
  const right = clamp(view.i1, 1, all.length);
  const left = right - bars; // может быть отрицательным: слева ещё не загружено

  const load = useCallback(async (dir: "older" | "newer") => {
    if (!all.length) return;
    setBusy(true);
    try {
      const from = dir === "older"
        ? all[0].t - CHUNK * step
        : all[all.length - 1].t + step;
      const to = dir === "older"
        ? all[0].t - 1
        : Math.min(Date.now(), all[all.length - 1].t + CHUNK * step);
      if (to <= from) {
        (dir === "older" ? setAtStart : setAtEnd)(true);
        return;
      }
      const res = await fetch(
        `/api/bot/setups/${setupId}/candles?tf=${data.tf}`
        + `&from=${Math.floor(from)}&to=${Math.ceil(to)}`,
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      const fresh: ChartCandle[] = (j.candles ?? []).filter(
        (c: ChartCandle) => (dir === "older" ? c.t < all[0].t : c.t > all[all.length - 1].t),
      );
      if (!fresh.length) {
        (dir === "older" ? setAtStart : setAtEnd)(true);
        return;
      }
      if (dir === "older") {
        // Окно стоит на месте, а индексы уже загруженных свечей сдвинулись.
        // Тянущемуся пальцу/мыши точка отсчёта тоже сдвигается — иначе
        // график дёрнется прямо посреди жеста.
        setAll([...fresh, ...all]);
        setView((v) => ({ ...v, i1: v.i1 + fresh.length }));
        if (drag.current) drag.current.i1 += fresh.length;
      } else {
        setAll([...all, ...fresh]);
      }
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      (dir === "older" ? setAtStart : setAtEnd)(true);
    } finally {
      setBusy(false);
    }
  }, [all, data.tf, setupId, step]);

  // Докачиваем, когда окно подошло к краю загруженного. Пока график не трогали,
  // ничего не грузим: окно сделки и так упирается в оба края, а лишний запрос
  // к бирже на каждое открытие карточки не нужен.
  useEffect(() => {
    if (!touched.current || busy || all.length >= MAX_LOADED) return;
    if (left < 5 && !atStart) load("older");
    else if (right >= all.length && !atEnd) load("newer");
  }, [left, right, busy, atStart, atEnd, all.length, load]);

  const geo = useMemo(() => {
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const cw = plotW / bars;
    const from = Math.max(0, left);
    const to = Math.min(all.length, right);
    const win = all.slice(from, to);

    const prices: number[] = [];
    for (const c of win) prices.push(c.h, c.l);
    if (!prices.length) prices.push(0, 1);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    // Уровни сетапа тянут шкалу на себя, только когда они рядом с ценой:
    // улистав график далеко от сделки, не хочется смотреть на сплющенные свечи
    const room = (hi - lo) * 0.35 || Math.abs(hi) * 0.02;
    for (const l of data.levels) {
      if (l.price > lo - room && l.price < hi + room) {
        lo = Math.min(lo, l.price);
        hi = Math.max(hi, l.price);
      }
    }
    const padY = (hi - lo) * 0.07 || Math.abs(hi) * 0.01 || 1;
    const top = hi + padY;
    const bottom = lo - padY;

    const y = (v: number) => PAD_T + ((top - v) / (top - bottom)) * plotH;
    const xIdx = (gi: number) => PAD_L + (gi - left) * cw + cw / 2;
    // Время → дробный индекс свечи. Двоичный поиск, а не деление на шаг:
    // у DEX-пулов пустые свечи пропущены, равномерной сетки нет.
    const idxOf = (ms: number) => {
      if (!all.length) return 0;
      if (ms <= all[0].t) return (ms - all[0].t) / step;
      let a = 0;
      let b = all.length - 1;
      while (a < b) {
        const mid = (a + b + 1) >> 1;
        if (all[mid].t <= ms) a = mid; else b = mid - 1;
      }
      return a + (ms - all[a].t) / step;
    };
    const x = (ms: number) => xIdx(idxOf(ms));
    return { plotW, plotH, cw, from, to, win, top, bottom, y, x, xIdx, idxOf };
  }, [all, left, right, bars, step, data.levels]);

  const { plotW, plotH, cw, from, to, win, top, bottom, y, x, xIdx } = geo;

  // ── управление ──
  const pan = useCallback((deltaBars: number) => {
    touched.current = true;
    setView((v) => ({ ...v, i1: clamp(Math.round(v.i1 + deltaBars), 1, lenRef.current) }));
  }, []);

  // Свеча под курсором (или в центре) остаётся на месте
  const zoom = useCallback((factor: number, anchorFrac = 0.5) => {
    touched.current = true;
    setView((v) => {
      const prev = clamp(v.n, MIN_BARS, MAX_BARS);
      const next = clamp(Math.round(prev * factor), MIN_BARS, MAX_BARS);
      const anchor = clamp(v.i1, 1, lenRef.current) - prev + anchorFrac * prev;
      return {
        n: next,
        i1: clamp(Math.round(anchor + (1 - anchorFrac) * next), 1, lenRef.current),
      };
    });
  }, []);

  const reset = useCallback(() => {
    const base = all.findIndex((c) => c.t >= data.candles[0].t);
    setView({
      n: Math.max(data.candles.length, MIN_BARS),
      i1: (base < 0 ? 0 : base) + data.candles.length,
    });
  }, [all, data.candles]);

  // Колесо мыши масштабирует. Слушатель вешаем вручную: React вешает wheel
  // пассивно, а из пассивного нельзя отменить прокрутку страницы.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, frac);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  function onDown(e: React.PointerEvent<SVGRectElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, i1: right };
    setHover(null);
  }

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (drag.current) {
      touched.current = true;
      const dx = ((e.clientX - drag.current.x) / r.width) * plotW;
      const next = clamp(Math.round(drag.current.i1 - dx / cw), 1, lenRef.current);
      setView((v) => ({ ...v, i1: next }));
      return;
    }
    const rel = ((e.clientX - r.left) / r.width) * plotW;
    const gi = left + Math.floor(rel / cw);
    setHover(gi >= 0 && gi < all.length ? gi : null);
  }

  function onUp(e: React.PointerEvent<SVGRectElement>) {
    if (drag.current) e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
  }

  if (!all.length) {
    return <p className="muted">Биржа не отдала свечи за это время — график построить не из чего.</p>;
  }

  const spanDays = (bars * step) / 86_400_000;
  const withDate = spanDays > 1;

  const entryX = x(data.entryMs);
  const exitX = data.exitMs === null ? xIdx(all.length) : x(data.exitMs);
  const entry = data.levels.find((l) => l.tone === "entry")?.price ?? 0;
  const stopLv = data.levels.find((l) => l.tone === "stop")?.price ?? 0;
  const tpLv = data.levels.find((l) => l.tone === "tp")?.price ?? 0;

  const grid = [0, 1, 2, 3, 4].map((k) => bottom + ((top - bottom) * k) / 4);

  // Метки времени: примерно шесть штук по видимым свечам
  const ticks: number[] = [];
  const tickStep = Math.max(1, Math.floor(win.length / 6));
  for (let i = 0; i < win.length; i += tickStep) ticks.push(from + i);

  // Лесенка стопа: горизонталь до следующей ступени, вертикаль на подъёме.
  // Ступени вне окна пропускаем — обрезкой займётся clipPath.
  const stopPath = (() => {
    const pts: string[] = [];
    data.stops.forEach((s, i) => {
      const xs = Math.max(entryX, x(s.time));
      const xe = i + 1 < data.stops.length ? Math.max(entryX, x(data.stops[i + 1].time)) : exitX;
      if (!pts.length) pts.push(`M ${xs.toFixed(1)} ${y(s.stop).toFixed(1)}`);
      else pts.push(`L ${xs.toFixed(1)} ${y(s.stop).toFixed(1)}`);
      pts.push(`L ${xe.toFixed(1)} ${y(s.stop).toFixed(1)}`);
    });
    return pts.join(" ");
  })();

  // Метки событий расходятся по двум строкам: TP1 и включение трейлинга
  // часто приходятся на одну свечу и иначе печатались бы друг на друге
  const eventRows: number[] = [];
  const rowLastX = [-999, -999];
  for (const e of data.events) {
    const ex = x(e.time);
    const row = Math.abs(ex - rowLastX[0]) >= 70 ? 0 : 1;
    rowLastX[row] = ex;
    eventRows.push(row);
  }

  const hc: ChartCandle | null = hover === null ? null : all[hover] ?? null;
  const hoverX = hover === null ? 0 : xIdx(hover);
  const shown = win.length;

  const zone = (a: number, b: number, fill: string, stroke: string) => (
    <rect
      x={entryX} y={Math.min(y(a), y(b))}
      width={Math.max(exitX - entryX, 2)}
      height={Math.max(Math.abs(y(a) - y(b)), 1)}
      fill={fill} stroke={stroke} strokeWidth={1} strokeDasharray="4 4" opacity={0.55}
    />
  );

  return (
    <div>
      <div className="chart-box" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} className="trade-chart">
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD_L} y={PAD_T - 2} width={plotW} height={plotH + 2} />
            </clipPath>
          </defs>

          {/* сетка цен */}
          {grid.map((v, i) => (
            <g key={`g${i}`}>
              <line
                x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)}
                stroke="var(--border)" strokeWidth={1}
              />
              <text x={W - PAD_R + 6} y={y(v) + 4} fill="var(--c-4)" fontSize={11}>{fmt(v)}</text>
            </g>
          ))}

          <g clipPath={`url(#${clipId})`}>
            {/* зоны риска и цели — только на времени жизни сделки */}
            {stopLv > 0 && zone(entry, stopLv, "var(--red-soft)", "var(--red)")}
            {tpLv > 0 && zone(entry, tpLv, "var(--green-soft)", "var(--green)")}

            {/* свечи */}
            {win.map((c, k) => {
              const gi = from + k;
              const up = c.c >= c.o;
              const col = up ? "var(--green)" : "var(--red)";
              const cx = xIdx(gi);
              const bodyTop = y(Math.max(c.o, c.c));
              const bodyH = Math.max(1, Math.abs(y(c.c) - y(c.o)));
              return (
                <g key={c.t} opacity={hover === null || hover === gi ? 1 : 0.72}>
                  <line x1={cx} y1={y(c.h)} x2={cx} y2={y(c.l)} stroke={col} strokeWidth={1} />
                  <rect
                    x={cx - Math.max(cw * 0.32, 0.6)} y={bodyTop}
                    width={Math.max(cw * 0.64, 1.2)} height={bodyH} fill={col}
                  />
                </g>
              );
            })}

            {/* лесенка стопа: где реально стоял стоп в каждый момент */}
            {stopPath && (
              <path d={stopPath} fill="none" stroke="var(--red)" strokeWidth={1.8}
                strokeDasharray="6 3" opacity={0.9} />
            )}

            {/* лучшая и худшая цены за сделку — кружки без подписей, чтобы не
                загромождать; что это, подсказывает нативный тултип */}
            {data.best && (
              <circle cx={x(data.best.time)} cy={y(data.best.price)} r={3}
                fill="none" stroke="var(--green)" strokeWidth={1.5}>
                <title>лучшая цена за сделку {fmt(data.best.price)}</title>
              </circle>
            )}
            {data.worst && (
              <circle cx={x(data.worst.time)} cy={y(data.worst.price)} r={3}
                fill="none" stroke="var(--red)" strokeWidth={1.5}>
                <title>худшая цена за сделку {fmt(data.worst.price)}</title>
              </circle>
            )}

            {/* курсор */}
            {hc && (
              <line x1={hoverX} y1={PAD_T} x2={hoverX} y2={PAD_T + plotH}
                stroke="var(--c-4)" strokeWidth={1} strokeDasharray="2 3" />
            )}
          </g>

          {/* уровни сетапа: подпись слева на самой линии, чтобы не спорить
              со шкалой цен справа. Обводка цветом фона — «дырка» под текстом,
              иначе он теряется в свечах */}
          {data.levels.map((l: ChartLevel, i) => {
            if (l.price > top || l.price < bottom) return null;
            return (
              <g key={`l${i}`}>
                <line
                  x1={PAD_L} y1={y(l.price)} x2={W - PAD_R} y2={y(l.price)}
                  stroke={TONE[l.tone]} strokeWidth={1.2}
                  strokeDasharray={l.tone === "entry" ? "" : "7 5"} opacity={0.85}
                />
                <text
                  x={PAD_L + 5} y={y(l.price) - 5}
                  fill={TONE[l.tone]} fontSize={11} fontWeight={650}
                  stroke="var(--bg)" strokeWidth={3} paintOrder="stroke"
                >
                  {l.label} {fmt(l.price)}
                </text>
              </g>
            );
          })}

          {/* события: вертикаль до цены + точка */}
          {data.events.map((e, i) => {
            const ex = x(e.time);
            if (ex < PAD_L - 2 || ex > W - PAD_R + 2) return null;
            const ey = clamp(y(e.price), PAD_T, PAD_T + plotH);
            const col = EVENT_TONE[e.kind];
            const anchor = ex > W - PAD_R - 60 ? "end" : ex < PAD_L + 40 ? "start" : "middle";
            const row = eventRows[i];
            return (
              <g key={`e${i}`}>
                <line x1={ex} y1={PAD_T - 16 + row * 15} x2={ex} y2={ey} stroke={col}
                  strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
                <circle cx={ex} cy={ey} r={4.5} fill={col} stroke="var(--bg)" strokeWidth={1.5} />
                <text
                  x={ex} y={PAD_T - 22 + row * 15} fill={col} fontSize={11} fontWeight={700}
                  textAnchor={anchor} stroke="var(--bg)" strokeWidth={3} paintOrder="stroke"
                >
                  {EVENT_SHORT[e.kind]}
                </text>
              </g>
            );
          })}

          {/* метки времени */}
          {ticks.map((gi) => (
            <text
              key={`t${gi}`} x={xIdx(gi)} y={H - 8}
              fill="var(--c-4)" fontSize={10} textAnchor="middle"
            >
              {fmtTime(all[gi].t, withDate)}
            </text>
          ))}

          <rect
            x={PAD_L} y={PAD_T} width={plotW} height={plotH} fill="transparent"
            style={{ cursor: drag.current ? "grabbing" : "grab", touchAction: "pan-y" }}
            onPointerDown={onDown} onPointerMove={onMove}
            onPointerUp={onUp} onPointerCancel={onUp}
            onPointerLeave={() => setHover(null)}
          />
        </svg>

        {hc && (
          <div
            className="chart-tip"
            style={{
              left: `${(hoverX / W) * 100}%`,
              transform: hoverX > W * 0.6 ? "translateX(-104%)" : "translateX(4%)",
            }}
          >
            <b>{fmtTime(hc.t, true)}</b>
            <span>O {fmt(hc.o)}</span>
            <span>H {fmt(hc.h)}</span>
            <span>L {fmt(hc.l)}</span>
            <span>C {fmt(hc.c)}</span>
            <span className={(long ? hc.c >= entry : hc.c <= entry) ? "pos" : "neg"}>
              {fmtPct((long ? hc.c / entry - 1 : 1 - hc.c / entry) * 100)} от входа
            </span>
          </div>
        )}
      </div>

      <div className="chart-bar">
        <button className="btn sm icon" title="Листать назад"
          disabled={atStart && left <= 0}
          onClick={() => pan(-Math.round(bars / 3))}>←</button>
        <button className="btn sm icon" title="Листать вперёд"
          disabled={atEnd && right >= all.length}
          onClick={() => pan(Math.round(bars / 3))}>→</button>
        <button className="btn sm icon" title="Отдалить"
          disabled={bars >= MAX_BARS} onClick={() => zoom(1.4)}>−</button>
        <button className="btn sm icon" title="Приблизить"
          disabled={bars <= MIN_BARS} onClick={() => zoom(1 / 1.4)}>+</button>
        <button className="btn sm" onClick={reset}>К сделке</button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {shown} свечей {data.tf} · тяни мышью, колесо — масштаб
          {busy && " · подгружаю…"}
          {atStart && left <= 0 && " · дальше истории нет"}
        </span>
        {failed && <span className="error" style={{ fontSize: 12.5 }}>{failed}</span>}
      </div>
    </div>
  );
}
