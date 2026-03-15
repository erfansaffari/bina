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
          bg:           '#FAFBFF',
          surface:      'rgba(255,255,255,0.75)',
          border:       'rgba(148,163,184,0.25)',
          text:         '#1E1B4B',
          muted:        '#6B7280',
          accent:       '#6366F1',
          'accent-glow':'rgba(99,102,241,0.12)',
          green:        '#10B981',
          yellow:       '#F59E0B',
          red:          '#F43F5E',
          purple:       '#8B5CF6',
          cyan:         '#06B6D4',
          orange:       '#F97316',
          rose:         '#F43F5E',
          blue:         '#3B82F6',
          emerald:      '#10B981',
          violet:       '#7C3AED',
        },
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'fade-in':   'fadeIn 0.3s ease-out',
        'slide-up':  'slideUp 0.4s cubic-bezier(0.16,1,0.3,1)',
        'pulse-glow':'pulseGlow 2s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
        'orb-float': 'orbFloat 12s ease-in-out infinite',
        'orb-float-2':'orbFloat2 16s ease-in-out infinite',
        'orb-float-3':'orbFloat3 20s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%':   { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(99,102,241,0)' },
          '50%':      { boxShadow: '0 0 20px 4px rgba(99,102,241,0.2)' },
        },
        orbFloat: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '33%':      { transform: 'translate(30px, -40px) scale(1.05)' },
          '66%':      { transform: 'translate(-20px, 20px) scale(0.97)' },
        },
        orbFloat2: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '40%':      { transform: 'translate(-40px, 30px) scale(1.08)' },
          '70%':      { transform: 'translate(25px, -20px) scale(0.95)' },
        },
        orbFloat3: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '25%':      { transform: 'translate(20px, 40px) scale(1.04)' },
          '75%':      { transform: 'translate(-30px, -25px) scale(0.98)' },
        },
      },
    },
  },
  plugins: [],
}
