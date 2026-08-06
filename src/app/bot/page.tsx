import { redirect } from "next/navigation";

// Старый адрес раздела — теперь боты живут в списке кастомных ботов
export default function OldBotPage() {
  redirect("/bots");
}
