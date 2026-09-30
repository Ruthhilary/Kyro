import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { CameraProvider } from "@/lib/CameraContext";
import { ReviewProvider } from "@/lib/ReviewContext";
import { SeatAlertProvider } from "@/lib/SeatAlertContext";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";
import { GlobalReviewOverlay } from "@/components/ui/GlobalReviewOverlay";
import { GlobalSeatAlertOverlay } from "@/components/ui/GlobalSeatAlertOverlay";
import { BackendStatusBanner } from "@/components/ui/BackendStatusBanner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Kyro — Live Attendance Intelligence",
  description: "AI-powered church attendance and smart seating dashboard",
  manifest: "/manifest.webmanifest",
  // iOS PWA: these are the tags Apple actually reads. They make "Add to
  // Home Screen" install the site as a standalone web app — a hard
  // prerequisite for iOS to deliver Web Push notifications when the app
  // is closed or the phone is locked (iOS 16.4+).
  appleWebApp: {
    capable: true,
    title: "Kyro",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// Explicit viewport so mobile browsers scale correctly instead of rendering
// the desktop layout zoomed out. themeColor lands in the phone/tablet's
// status bar when the app is installed.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)",  color: "#0d0f1a" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
} as const;

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
                {/* Backend-unreachable banner (only shown in Live mode) */}
                <BackendStatusBanner />
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
