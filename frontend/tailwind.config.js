/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        priority: {
          1: '#dc2626', // P1 - red-600
          2: '#ea580c', // P2 - orange-600
          3: '#ca8a04', // P3 - yellow-600
          4: '#4b5563', // P4 - gray-600
          5: '#6b7280', // P5 - gray-500
        },
      },
    },
  },
  plugins: [],
};
