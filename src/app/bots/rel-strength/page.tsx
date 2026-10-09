import BotDashboard from "@/components/BotDashboard";

export default function RelStrengthBotPage() {
  return (
    <BotDashboard
      slug="rel-strength"
      title="⚡ Сила против BTC"
      intro={(
        <p className="hint">
          Импульсная стратегия на 15m: вход, когда монета за сутки обогнала биткоин
          больше чем на 3 п.п., а её тренд на 1h (EMA50 &gt; EMA200) это подтверждает; для
          шортов зеркально. Стоп 6×ATR, на 1.5R фиксируется половина и там же остаток
          подхватывает трейлинг 2×ATR, максимум неделя. Преимущество на истории не
          подтверждено: профит-фактор 1.00–1.09, итог сильно зависит от порогов.
        </p>
      )}
    />
  );
}
