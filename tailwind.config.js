/** @type {import('tailwindcss').Config} */
const config = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                background: 'var(--bg)',
                card: 'rgba(13, 17, 28, 0.7)',
                border: 'var(--border)',
                green: {
                    DEFAULT: '#10b981',
                    dim: 'rgba(16, 185, 129, 0.12)',
                    glow: 'rgba(16, 185, 129, 0.18)'
                },
                rose: {
                    DEFAULT: '#f43f5e',
                    dim: 'rgba(244, 63, 94, 0.12)',
                    glow: 'rgba(244, 63, 94, 0.18)'
                },
                indigo: {
                    DEFAULT: '#6366f1',
                    2: '#818cf8',
                    dim: 'rgba(99, 102, 241, 0.1)',
                    glow: 'rgba(99, 102, 241, 0.22)'
                },
                cyan: {
                    DEFAULT: '#22d3ee',
                    dim: 'rgba(34, 211, 238, 0.12)',
                    glow: 'rgba(34, 211, 238, 0.18)'
                },
                amber: {
                    DEFAULT: '#f59e0b',
                    dim: 'rgba(245, 158, 11, 0.12)',
                    glow: 'rgba(245, 158, 11, 0.18)'
                },
                violet: {
                    DEFAULT: '#8b5cf6',
                    dim: 'rgba(139, 92, 246, 0.12)'
                }
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
                mono: ['"JetBrains Mono"', 'monospace'],
            }
        },
    },
    plugins: [],
};

export default config;
