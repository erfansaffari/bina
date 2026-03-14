/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Helvetica Neue', 'sans-serif'],
        display: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'Helvetica Neue', 'sans-serif'],
        mono: ['SF Mono', 'JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        bina: {
          bg: '#0d0d0f',
          surface: '#161618',
          border: '#2a2a2e',
          text: '#f0f0f2',
          muted: '#6e6e80',
          accent: '#5e7ce6',
          'accent-glow': 'rgba(94,124,230,0.15)',
          green: '#30d158',
          yellow: '#ffd60a',
          red: '#ff453a',
          purple: '#bf5af2',
          cyan: '#32ade6',
          orange: '#ff9f0a',
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16,1,0.3,1)',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(94,124,230,0)' },
          '50%': { boxShadow: '0 0 20px 4px rgba(94,124,230,0.25)' },
        },
      },
    },
  },
  plugins: [],
}
