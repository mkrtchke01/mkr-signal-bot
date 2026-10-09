import BotDashboard from "@/components/BotDashboard";

export default function TrendlineBreakBotPage() {
  return (
    <BotDashboard
      slug="trendline-break"
      title="📐 Пробой наклонки"
      intro={(
        <p className="hint">
          Пробой наклонки на 5m / 15m / 1h только по тренду старшего ТФ (EMA и свинги):
          перед линией — импульс, откат съел не больше 61.8%, у границы наторговка,
          треугольники в приоритете. Вход в момент пробоя на объёме, стоп за наторговку,
          цель — проекция импульса, минимум 1:3. До 3.7R вся позиция закрывается на 3R,
          дальше — половина на 3R, стоп в б/у, остаток до цели. Истории проверки нет.
        </p>
      )}
    />
  );
}
