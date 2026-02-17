import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KHInsider-DL",
  description: "An archive for game soundtracks.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Alegreya:ital,wght@0,400;0,700;1,400&family=Cinzel:wght@700&family=Cinzel+Decorative:wght@700;900&family=Marcellus+SC&family=Mate+SC&display=swap" rel="stylesheet" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body>{children}</body>
    </html>
  );
}
