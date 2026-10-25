export const API_URL = (process.env.NEXT_PUBLIC_API_URL
  ?? process.env.NEXT_PUBLIC_DONATION_API_URL
  ?? (process.env.NODE_ENV === "development" ? "http://localhost:3001" : "https://api.nutnovember.org")).replace(/\/$/, "");
