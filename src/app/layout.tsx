import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Dog Behavior Analyzer | AI-Powered Pet Mood Analysis',
  description: 'Upload a video of your dog and get AI-powered behavioral analysis, mood detection, and health indicator insights.',
  keywords: ['dog behavior', 'pet analysis', 'AI', 'mood detection', 'animal behavior'],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
