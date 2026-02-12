import type { Config } from 'tailwindcss'

const config: Config = {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            colors: {
                ink: '#101828',
                mist: '#f8fafc',
                sand: '#f8efe4',
                pine: '#1f5f4a',
                coral: '#e96a5a',
            },
            boxShadow: {
                card: '0 16px 40px -24px rgba(15, 23, 42, 0.4)',
            },
        },
    },
    plugins: [],
}

export default config
