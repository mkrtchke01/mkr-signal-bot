import { redirect } from "next/navigation";

// Старый адрес раздела — теперь бот живёт в списке кастомных ботов
export default function OldBotPage() {
  redirect("/bots/pullback-levels");
}
