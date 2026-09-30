import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { CameraProvider } from "@/lib/CameraContext";
import { ReviewProvider } from "@/lib/ReviewContext";
import { SeatAlertProvider } from "@/lib/SeatAlertContext";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";
import { GlobalReviewOverlay } from "@/components/ui/GlobalReviewOverlay";
import { GlobalSeatAlertOverlay } from "@/components/ui/GlobalSeatAlertOverlay";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Kyro — Live Attendance Intelligence",
  description: "AI-powered church attendance and smart seating dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme BEFORE React hydrates so we never flash the wrong colours. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={inter.className}>
        <ThemeProvider>
          <CameraProvider>
            <ReviewProvider>
              <SeatAlertProvider>
                {children}
                {/* Global AI question overlay — visible on every page */}
                <GlobalReviewOverlay />
                {/* Global "seat available" alert overlay — visible on every page */}
                <GlobalSeatAlertOverlay />
              </SeatAlertProvider>
            </ReviewProvider>
          </CameraProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
