"use client";

// График одной сделки: свечи вокруг неё, зоны риска и цели, лесенка стопа
// и метки событий (вход, TP1, включение трейлинга, выход).
//
// Рисуем руками в SVG, без библиотеки: нужен один конкретный график, а не
// универсальный движок, зато он тянет цвета из темы и весит ноль килобайт.

import { useMemo, useRef, useState } from "react";
import { fmtPct } from "@/lib/format";
import type { ChartCandle, ChartLevel, TradeChart as Data } from "@/lib/tradeChart";
import type { TradeEvent } from "@/lib/replay";

const W = 1000;
const H = 430;
const PAD_L = 10;
const PAD_R = 74;  // справа шкала цен
const PAD_T = 48;  // сверху две строки под метки событий
const PAD_B = 26;

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

function fmtTime(ms: number, withDate: boolean): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!withDate) return hm;
  return `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

export default function TradeChart({
  data, fmt, long,
}: {
  data: Data;
  fmt: (p: number | null | undefined) => string;
  long: boolean; // направление сделки: от него зависит, где «в плюс»
}) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { candles, levels, events, stops } = data;

  const geo = useMemo(() => {
    if (!candles.length) return null;
    const prices: number[] = [];
    for (const c of candles) prices.push(c.h, c.l);
    for (const l of levels) prices.push(l.price);
    for (const s of stops) prices.push(s.stop);
    for (const e of events) prices.push(e.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const padY = (hi - lo) * 0.07 || Math.abs(hi) * 0.01 || 1;
    const top = hi + padY;
    const bottom = lo - padY;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const t0 = candles[0].t;
    const t1 = candles[candles.length - 1].t;
    const cw = plotW / candles.length;
    const y = (v: number) => PAD_T + ((top - v) / (top - bottom)) * plotH;
    // Время → X по позиции свечи: сетка равномерная, дырок в свечах не бывает
    const step = candles.length > 1 ? (t1 - t0) / (candles.length - 1) : 60_000;
    const x = (ms: number) => {
      const i = (ms - t0) / step;
      return PAD_L + Math.max(-1, Math.min(candles.length, i)) * cw + cw / 2;
    };
    return { lo, hi, top, bottom, plotW, plotH, cw, t0, t1, step, x, y };
  }, [candles, levels, events, stops]);

  if (!geo) {
    return <p className="muted">Биржа не отдала свечи за это время — график построить не из чего.</p>;
  }

  const { top, bottom, plotH, cw, x, y } = geo;
  const spanDays = (geo.t1 - geo.t0) / 86_400_000;
  const withDate = spanDays > 1;

  const entryX = x(data.entryMs);
  const exitX = data.exitMs === null ? PAD_L + geo.plotW : x(data.exitMs);
  const entry = levels.find((l) => l.tone === "entry")?.price ?? 0;
  const stopLv = levels.find((l) => l.tone === "stop")?.price ?? 0;
  const tpLv = levels.find((l) => l.tone === "tp")?.price ?? 0;

  // Горизонтальная сетка: пять линий с ценой справа
  const grid = [0, 1, 2, 3, 4].map((k) => bottom + ((top - bottom) * k) / 4);

  // Метки времени: шесть штук, реже — по краям окна
  const ticks: number[] = [];
  const tickStep = Math.max(1, Math.floor(candles.length / 6));
  for (let i = 0; i < candles.length; i += tickStep) ticks.push(i);

  // Лесенка стопа: горизонталь до следующей ступени, вертикаль на подъёме
  const stopPath = (() => {
    if (stops.length === 0) return "";
    const pts: string[] = [];
    stops.forEach((s, i) => {
      const xs = Math.max(entryX, x(s.time));
      const xe = i + 1 < stops.length ? Math.max(entryX, x(stops[i + 1].time)) : exitX;
      if (i === 0) pts.push(`M ${xs.toFixed(1)} ${y(s.stop).toFixed(1)}`);
      else pts.push(`L ${xs.toFixed(1)} ${y(s.stop).toFixed(1)}`);
      pts.push(`L ${xe.toFixed(1)} ${y(s.stop).toFixed(1)}`);
    });
    return pts.join(" ");
  })();

  // Метки событий расходятся по двум строкам: TP1 и включение трейлинга
  // часто приходятся на одну свечу и иначе печатались бы друг на друге
  const eventRows: number[] = [];
  const rowLastX = [-999, -999];
  for (const e of events) {
    const ex = x(e.time);
    const row = Math.abs(ex - rowLastX[0]) >= 70 ? 0 : 1;
    rowLastX[row] = ex;
    eventRows.push(row);
  }

  const hc: ChartCandle | null = hover === null ? null : candles[hover] ?? null;

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * geo!.plotW;
    const i = Math.floor(rel / cw);
    setHover(i >= 0 && i < candles.length ? i : null);
  }

  const zone = (a: number, b: number, fill: string, stroke: string) => (
    <rect
      x={entryX} y={Math.min(y(a), y(b))}
      width={Math.max(exitX - entryX, 2)}
      height={Math.max(Math.abs(y(a) - y(b)), 1)}
      fill={fill} stroke={stroke} strokeWidth={1} strokeDasharray="4 4" opacity={0.55}
    />
  );

  return (
    <div className="chart-box" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} className="trade-chart">
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

        {/* зоны риска и цели — только на времени жизни сделки */}
        {stopLv > 0 && zone(entry, stopLv, "var(--red-soft)", "var(--red)")}
        {tpLv > 0 && zone(entry, tpLv, "var(--green-soft)", "var(--green)")}

        {/* свечи */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const col = up ? "var(--green)" : "var(--red)";
          const cx = PAD_L + i * cw + cw / 2;
          const bodyTop = y(Math.max(c.o, c.c));
          const bodyH = Math.max(1, Math.abs(y(c.c) - y(c.o)));
          return (
            <g key={c.t} opacity={hover === null || hover === i ? 1 : 0.72}>
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

        {/* уровни сетапа: подпись слева на самой линии, чтобы не спорить
            со шкалой цен справа. Обводка цветом фона — «дырка» под текстом,
            иначе он теряется в свечах */}
        {levels.map((l: ChartLevel, i) => (
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
        ))}

        {/* события: вертикаль до цены + точка. Метки идут в две строки —
            TP1 и включение трейлинга часто попадают на одну свечу */}
        {events.map((e, i) => {
          const ex = x(e.time);
          const ey = y(e.price);
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

        {/* метки времени */}
        {ticks.map((i) => (
          <text
            key={`t${i}`} x={PAD_L + i * cw + cw / 2} y={H - 8}
            fill="var(--c-4)" fontSize={10} textAnchor="middle"
          >
            {fmtTime(candles[i].t, withDate)}
          </text>
        ))}

        {/* курсор */}
        {hc && (
          <line
            x1={PAD_L + hover! * cw + cw / 2} y1={PAD_T}
            x2={PAD_L + hover! * cw + cw / 2} y2={PAD_T + plotH}
            stroke="var(--c-4)" strokeWidth={1} strokeDasharray="2 3"
          />
        )}

        <rect
          x={PAD_L} y={PAD_T} width={geo.plotW} height={plotH} fill="transparent"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        />
      </svg>

      {hc && (
        <div
          className="chart-tip"
          style={{
            left: `${((PAD_L + hover! * cw + cw / 2) / W) * 100}%`,
            transform: hover! > candles.length * 0.6 ? "translateX(-104%)" : "translateX(4%)",
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
  );
}
