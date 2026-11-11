import "./globals.css";
import { AuthProvider } from "../components/AuthProvider";
import { LanguageProvider } from "../components/LanguageProvider";

export const metadata = {
  title: "Workflow Studio",
  description: "AI video workflow platform",
  icons: {
    icon: "/brand/mark.svg",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <LanguageProvider>
          <AuthProvider>{children}</AuthProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
