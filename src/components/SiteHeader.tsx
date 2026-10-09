"use client";

// Шапка сайта: логотип, меню с подсветкой активного раздела и переключатель
// темы. Тема хранится в localStorage, а на <html> её выставляет инлайн-скрипт
// из layout.tsx — до первой отрисовки, чтобы страница не мигала белым.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// short — подпись для узкого экрана: на 375px четыре полных названия
// в строку не влезают, а прятать их в горизонтальный скролл незачем
const NAV = [
  { href: "/", label: "Трейдеры", short: "Трейдеры" },
  { href: "/bots", label: "Кастомные боты", short: "Боты" },
  { href: "/new", label: "Создать", short: "Создать" },
  { href: "/channels", label: "Каналы", short: "Каналы" },
];

type Theme = "light" | "dark";

interface AccountInfo { balance: number; start: number; usedMargin: number; free: number }

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z" />
    </svg>
  );
}

export default function SiteHeader() {
  const pathname = usePathname();
  const [theme, setTheme] = useState<Theme | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);

  // Баланс счёта ботов: обновляем раз в минуту — сделки закрываются кроном
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/account");
        if (!res.ok) return;
        const j = await res.json();
        if (alive) setAccount(j);
      } catch {
        /* шапка без баланса — не повод ломать страницу */
      }
    }
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [pathname]);

  // Читаем тему только на клиенте: на сервере её знать неоткуда,
  // а до чтения иконку не рисуем, чтобы не мигала неверной
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("mkr-theme", next);
    } catch {
      /* приватный режим — тема просто не запомнится */
    }
    setTheme(next);
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="logo" aria-label="MKR Signal Bot">
          <span className="logo-mark" aria-hidden="true">⚡</span>
          <span className="logo-name" aria-hidden="true">
            MKR<span className="logo-text"> Signal Bot</span>
          </span>
        </Link>

        <nav className="topnav">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={
                item.href === "/"
                  ? pathname === "/" ? "page" : undefined
                  : pathname.startsWith(item.href) ? "page" : undefined
              }
            >
              <span className="nav-full">{item.label}</span>
              <span className="nav-short">{item.short}</span>
            </Link>
          ))}
        </nav>

        {account && (
          <span
            className="balance"
            title={`Старт ${usd(account.start)} · в марже ${usd(account.usedMargin)} · `
              + `свободно ${usd(account.free)}`}
          >
            <span className="balance-k">Баланс</span>
            <span className={`balance-v ${account.balance >= account.start ? "pos" : "neg"}`}>
              {usd(account.balance)}
            </span>
            <span className="balance-free">свободно {usd(account.free)}</span>
          </span>
        )}

        <button
          type="button"
          className="theme-toggle"
          onClick={toggle}
          aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        >
          {theme === null ? null : theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}
