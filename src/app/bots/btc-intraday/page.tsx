import BotDashboard from "@/components/BotDashboard";

export default function BtcIntradayBotPage() {
  return (
    <BotDashboard
      slug="btc-intraday"
      title="₿ Bitcoin intraday"
      intro={(
        <p className="hint">
          Разворот от уровня на BTCUSDT 15m по тренду 1h (EMA): RSI(14) прокалывает 70
          или 30 у свинг-уровня за трое суток, вход по закрытию первой свечи
          противоположного цвета. Стоп ровно на экстремуме разворота, тейк 2R целиком,
          максимум сутки. Стоп узкий, поэтому комиссия заметно съедает результат;
          преимущество на истории не подтверждено.
        </p>
      )}
    />
  );
}
