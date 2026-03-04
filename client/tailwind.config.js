/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ocean: "#070B1A",
        lagoon: "#0B1F2A",
        neonCyan: "#4AF8FF",
        neonPurple: "#8F5BFF",
        sunsetOrange: "#FF9B54",
        sand: "#F7E7B7",
        danger: "#FF5B7E",
        success: "#32D39A",
      },
      fontFamily: {
        display: [
          "Impact",
          "Haettenschweiler",
          '"Arial Black"',
          '"Trebuchet MS"',
          "sans-serif",
        ],
        sans: ['"Trebuchet MS"', '"Segoe UI"', "system-ui", "sans-serif"],
      },
      backgroundImage: {
        "arcade-grid":
          "linear-gradient(rgba(74,248,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(74,248,255,0.05) 1px, transparent 1px)",
      },
      boxShadow: {
        card: "0 24px 70px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08)",
        "glow-cyan":
          "0 0 0 1px rgba(74, 248, 255, 0.18), 0 0 32px rgba(74, 248, 255, 0.2)",
        "glow-orange":
          "0 0 0 1px rgba(255, 155, 84, 0.22), 0 0 36px rgba(255, 155, 84, 0.2)",
        "glow-danger":
          "0 0 0 1px rgba(255, 91, 126, 0.22), 0 0 36px rgba(255, 91, 126, 0.24)",
      },
      keyframes: {
        "chip-pulse": {
          "0%, 100%": {
            transform: "translateY(0) scale(1)",
          },
          "50%": {
            transform: "translateY(-2px) scale(1.02)",
          },
        },
        "panel-pulse": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 1px rgba(74, 248, 255, 0.18), 0 0 34px rgba(74, 248, 255, 0.18)",
            filter: "saturate(1)",
          },
          "50%": {
            boxShadow:
              "0 0 0 1px rgba(74, 248, 255, 0.26), 0 0 46px rgba(74, 248, 255, 0.28)",
            filter: "saturate(1.08)",
          },
        },
        "pass-burst": {
          "0%": {
            transform: "translateY(0) scale(1)",
          },
          "35%": {
            transform: "translateY(-3px) scale(1.01)",
          },
          "100%": {
            transform: "translateY(0) scale(1)",
          },
        },
        "boom-flash": {
          "0%": {
            filter: "brightness(1)",
          },
          "35%": {
            filter: "brightness(1.16)",
          },
          "100%": {
            filter: "brightness(1)",
          },
        },
        "word-flash": {
          "0%": {
            transform: "scale(1)",
            boxShadow: "0 0 0 rgba(74, 248, 255, 0)",
          },
          "45%": {
            transform: "scale(1.02)",
            boxShadow: "0 0 24px rgba(74, 248, 255, 0.2)",
          },
          "100%": {
            transform: "scale(1)",
            boxShadow: "0 0 0 rgba(74, 248, 255, 0)",
          },
        },
        rumble: {
          "0%, 100%": {
            transform: "translate3d(0, 0, 0)",
          },
          "20%": {
            transform: "translate3d(-2px, 0, 0)",
          },
          "40%": {
            transform: "translate3d(2px, 1px, 0)",
          },
          "60%": {
            transform: "translate3d(-1px, -1px, 0)",
          },
          "80%": {
            transform: "translate3d(1px, 0, 0)",
          },
        },
        "shake-retro": {
          "0%, 100%": {
            transform: "translateX(0)",
          },
          "20%": {
            transform: "translateX(-4px)",
          },
          "40%": {
            transform: "translateX(4px)",
          },
          "60%": {
            transform: "translateX(-3px)",
          },
          "80%": {
            transform: "translateX(3px)",
          },
        },
      },
      animation: {
        "chip-pulse": "chip-pulse 1.3s ease-in-out infinite",
        "panel-pulse": "panel-pulse 1.6s ease-in-out infinite",
        "pass-burst": "pass-burst 420ms ease-out",
        "boom-flash": "boom-flash 520ms ease-out",
        "word-flash": "word-flash 320ms ease-out",
        rumble: "rumble 520ms ease-out",
        "shake-retro": "shake-retro 320ms ease-out",
      },
    },
  },
  plugins: [],
};
