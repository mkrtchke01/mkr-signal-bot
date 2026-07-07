import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "MKR Signal Bot",
  description: "Конструктор торговых стратегий и сигналов",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <div className="container">
          <header className="topbar">
            <Link href="/" className="logo">⚡ MKR Signal Bot</Link>
            <nav>
              <Link href="/">Трейдеры</Link>
              <Link href="/bots">Кастомные боты</Link>
              <Link href="/new">+ Создать</Link>
              <Link href="/channels">Каналы</Link>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
