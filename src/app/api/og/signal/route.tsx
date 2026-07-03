import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { getSignal } from "@/lib/db";
import { exitLabel, fmtPct, fmtPrice, ruleLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

// Подгружаем шрифт с кириллицей под конкретный текст карточки.
// Если Google Fonts недоступен — рендерим дефолтным шрифтом, вычистив не-латиницу.
async function loadFont(text: string): Promise<ArrayBuffer | null> {
  try {
    const url = `https://fonts.googleapis.com/css2?family=Inter:wght@700&text=${encodeURIComponent(text)}`;
    const css = await (await fetch(url)).text();
    const m = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/);
    if (!m) return null;
    const res = await fetch(m[1]);
    if (!res.ok) return null;
    return res.arrayBuffer();
  } catch {
    return null;
  }
}

const latinize = (s: string) => s.replace(/[^\x20-\x7E№₽]/g, "?");

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const state = req.nextUrl.searchParams.get("state") === "closed" ? "closed" : "open";
  const s = await getSignal(id);
  if (!s) return new Response("not found", { status: 404 });

  const c = s.config;
  const long = s.direction === "LONG";
  const accent = long ? "#16c784" : "#ea3943";
  const closed = state === "closed" && s.status !== "OPEN";
  const win = s.status === "TP";

  let rules = c.rules.map(ruleLabel);
  let name = c.name;
  let takeText = s.takePrice !== null ? fmtPrice(s.takePrice) : exitLabel(c.takeProfit);
  let stopText = s.stopPrice !== null ? fmtPrice(s.stopPrice) : exitLabel(c.stopLoss);
  let resultTitle = closed ? (win ? "ТЕЙК СРАБОТАЛ" : "СТОП СРАБОТАЛ") : "";
  let labels = {
    trader: "Трейдер", entry: "Вход", take: "Тейк", stop: "Стоп",
    rules: "Правила входа", exit: "Выход", result: "Результат", tf: "Базовый ТФ",
  };

  const allText = [
    s.symbol, s.direction, `x${s.leverage}`, name, ...rules, takeText, stopText,
    resultTitle, ...Object.values(labels), fmtPrice(s.entryPrice),
    fmtPrice(s.exitPrice), fmtPct(s.profitPct), c.timeframe,
    "0123456789.,+-%≤≥@×#→ ",
  ].join(" ");

  const font = await loadFont(allText);
  if (!font) {
    rules = rules.map(latinize);
    name = latinize(name);
    takeText = latinize(takeText);
    stopText = latinize(stopText);
    resultTitle = closed ? (win ? "TAKE PROFIT HIT" : "STOP LOSS HIT") : "";
    labels = {
      trader: "Trader", entry: "Entry", take: "Take", stop: "Stop",
      rules: "Entry rules", exit: "Exit", result: "Result", tf: "Base TF",
    };
  }

  const row = (label: string, value: string, color = "#e8eaed") => (
    <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
      <span style={{ color: "#9aa0a6", fontSize: 28 }}>{label}</span>
      <span style={{ color, fontSize: 30 }}>{value}</span>
    </div>
  );

  return new ImageResponse(
    (
      <div style={{
        width: "100%", height: "100%", display: "flex", flexDirection: "column",
        background: "linear-gradient(135deg, #0b0e14 0%, #131a26 100%)",
        padding: 48, fontFamily: "Inter", color: "#e8eaed",
      }}>
        {/* Шапка */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{
            display: "flex", background: accent, color: "#0b0e14",
            borderRadius: 12, padding: "6px 20px", fontSize: 36,
          }}>
            {s.direction}
          </div>
          <div style={{ display: "flex", fontSize: 44 }}>#{s.symbol}</div>
          <div style={{ display: "flex", fontSize: 36, color: "#f0b90b" }}>×{s.leverage}</div>
          <div style={{ display: "flex", flexGrow: 1 }} />
          <div style={{ display: "flex", fontSize: 26, color: "#9aa0a6" }}>
            {labels.trader}: {name}
          </div>
        </div>

        {closed ? (
          <div style={{
            display: "flex", flexDirection: "column", gap: 18, marginTop: 40,
            background: "rgba(255,255,255,0.04)", borderRadius: 16, padding: 32,
            borderLeft: `10px solid ${win ? "#16c784" : "#ea3943"}`,
          }}>
            <div style={{ display: "flex", fontSize: 44, color: win ? "#16c784" : "#ea3943" }}>
              {resultTitle}
            </div>
            {row(labels.entry, fmtPrice(s.entryPrice))}
            {row(labels.exit, fmtPrice(s.exitPrice))}
            {row(labels.result, fmtPct(s.profitPct), win ? "#16c784" : "#ea3943")}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 24, marginTop: 40 }}>
            <div style={{
              display: "flex", flexDirection: "column", gap: 18, flexGrow: 1,
              background: "rgba(255,255,255,0.04)", borderRadius: 16, padding: 32,
            }}>
              {row(labels.entry, fmtPrice(s.entryPrice), "#ffffff")}
              {row(labels.take, takeText, "#16c784")}
              {row(labels.stop, stopText, "#ea3943")}
              {row(labels.tf, c.timeframe)}
            </div>
          </div>
        )}

        {/* Правила */}
        <div style={{
          display: "flex", flexDirection: "column", gap: 10, marginTop: 28,
          background: "rgba(255,255,255,0.04)", borderRadius: 16, padding: 28,
        }}>
          <div style={{ display: "flex", fontSize: 24, color: "#9aa0a6" }}>{labels.rules}</div>
          {rules.slice(0, 5).map((r, i) => (
            <div key={i} style={{ display: "flex", fontSize: 26 }}>• {r}</div>
          ))}
        </div>

        <div style={{ display: "flex", flexGrow: 1 }} />
        <div style={{ display: "flex", justifyContent: "space-between", color: "#5f6368", fontSize: 22 }}>
          <span>mkr-signal-bot</span>
          <span>{new Date(closed && s.exitTime ? s.exitTime : s.entryTime)
            .toISOString().replace("T", " ").slice(0, 16)} UTC</span>
        </div>
      </div>
    ),
    {
      width: 1000,
      height: 640,
      fonts: font ? [{ name: "Inter", data: font, weight: 700 as const }] : undefined,
    },
  );
}
