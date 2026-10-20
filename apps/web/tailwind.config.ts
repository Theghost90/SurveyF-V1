import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';
import plugin from 'tailwindcss/plugin';

/**
 * Tokens lifted from the "SurveyFlow Hero & Pricing" design (Hero A / Pricing A):
 * ink #0B2B22 · canvas #F4F6F1 · brand #2BD46E · leaf #0F7A40 · amber #E9A23B · Bricolage Grotesque + Figtree.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1280px' } },
    extend: {
      colors: {
        ink: { DEFAULT: '#0B2B22', 2: '#12392E', 3: '#1B3F33', line: '#2E5547' },
        canvas: '#F4F6F1',
        mint: { DEFAULT: '#DDEFE3', 2: '#9FD9B4' },
        brand: { DEFAULT: '#2BD46E', 2: '#25C064', 3: '#7BE0A0', 4: '#4CC584' },
        leaf: '#0F7A40',
        amber: { DEFAULT: '#E9A23B', soft: '#FFF4E0', ink: '#6B4A10' },
        line: { DEFAULT: '#DCE4DE', 2: '#C9D3CC', 3: '#E3E9E5' },
        body: '#3F534A',
        muted: { DEFAULT: '#E9EEEA', foreground: '#4A5D55' },
        wa: { header: '#0F5E3A', bg: '#ECE5DA', out: '#D3F5DD' },
        // shadcn semantic tokens, mapped onto the palette via CSS variables (see globals.css)
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      fontFamily: {
        display: ["'Bricolage Grotesque Variable'", 'Bricolage Grotesque', 'system-ui', 'sans-serif'],
        sans: ["'Figtree Variable'", 'Figtree', 'system-ui', 'sans-serif'],
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      boxShadow: {
        card: '0 20px 50px -30px rgba(11,43,34,0.35)',
        float: '0 18px 40px -16px rgba(11,43,34,0.35)',
        phone: '0 30px 60px -20px rgba(11,43,34,0.45)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: { 'fade-up': 'fade-up 0.25s ease-out both' },
    },
  },
  plugins: [
    animate,
    // Landscape phones are wide but SHORT: `short:` applies below 480 px of height, whatever the width. (A variant, not a `screens` entry: a raw
    // screen would silently switch off every max-* variant.)
    plugin(({ addVariant }) => addVariant('short', '@media (max-height: 480px)')),
  ],
};
export default config;
