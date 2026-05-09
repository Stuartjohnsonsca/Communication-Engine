import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        paper: "#fafaf9",
        accent: "#1f3a5f",
      },
    },
  },
  plugins: [],
};

export default config;
