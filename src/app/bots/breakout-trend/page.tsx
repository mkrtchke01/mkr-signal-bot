import BotDashboard from "@/components/BotDashboard";

export default function BreakoutBotPage() {
  return (
    <BotDashboard
      slug="breakout-trend"
      title="🚀 Пробой по тренду"
      intro={(
        <p className="hint">
          Трендовая стратегия на 4h: вход по рынку через час после того, как закрытие
          обновило экстремум 20 свечей в сторону тренда монеты (EMA50 &gt; EMA200) и режима
          BTC. Стоп 2.5×ATR, на 1.5R фиксируется половина, с 5R остаток ведёт трейлинг
          3×ATR, максимум 30 дней. Бэктест 2022–2026 на Bybit: 368 сделок, профит-фактор
          1.42, все годы в плюсе — но параметры подобраны на тех же данных.
        </p>
      )}
    />
  );
}
