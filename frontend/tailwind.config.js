/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['"IBM Plex Sans"', 'Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        canvas: '#f7f8fb',
        surface: '#ffffff',
        ink: {
          DEFAULT: '#12202f',
          soft: '#33465c',
          muted: '#5b6a7e',
          faint: '#63718a',
        },
        line: {
          DEFAULT: '#e4e8ef',
          strong: '#cbd4df',
        },
        brand: {
          50: '#eef4fa',
          100: '#dce8f4',
          200: '#b9d1e8',
          300: '#8bb2d6',
          400: '#548bb8',
          500: '#2f6f9e',
          600: '#1e5782',
          700: '#164469',
          800: '#0f3454',
          900: '#0a2742',
          950: '#071b30',
        },
        confirmed: '#15803d',
        inferred: '#a16207',
        review: '#c2410c',
        critical: '#b91c1c',
        info: '#1d4ed8',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 34, 56, 0.05), 0 8px 24px -18px rgba(15, 34, 56, 0.35)',
        lift: '0 18px 40px -24px rgba(15, 34, 56, 0.45)',
        drawer: '-16px 0 40px -20px rgba(15, 34, 56, 0.4)',
      },
      borderRadius: {
        card: '12px',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { transform: 'translateX(24px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 180ms ease-out both',
        'slide-in': 'slide-in 220ms ease-out both',
      },
    },
  },
  plugins: [],
};
