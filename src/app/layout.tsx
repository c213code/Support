import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ToastProvider } from "@/components/Toast";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "JUZ40 Support",
  description: "Внутренний инструмент для ведения ежедневных support-репортов",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {/* Провайдер тостов оборачивает всё дерево: children приходят из
            серверных компонентов и остаются серверными — клиентской здесь
            становится только сама обёртка с очередью уведомлений. */}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
