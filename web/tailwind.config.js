/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'IBM Plex Sans Arabic', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'] },
      colors: {
        brand: { 50: '#eef4ff', 100: '#dbe6ff', 400: '#6b93ff', 500: '#4f7bff', 600: '#3a62f0', 700: '#2f4fd0' },
      },
      boxShadow: { card: '0 1px 2px rgb(0 0 0 / .04), 0 8px 24px -12px rgb(0 0 0 / .12)' },
      keyframes: {
        rise: { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } },
        shimmer: { from: { backgroundPosition: '-200% 0' }, to: { backgroundPosition: '200% 0' } },
      },
      animation: { rise: 'rise .25s ease-out both', shimmer: 'shimmer 1.4s linear infinite' },
    },
  },
  plugins: [],
};
