import "dotenv/config";
import app from "./app";

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);

  // ── Keep-alive self-ping (Render free tier) ───────────────────────────
  // Render spins down free-tier services after 15 minutes of inactivity.
  // A self-ping every 5 minutes prevents that. Only runs in production so
  // local dev isn't polluted with periodic requests.
  if (process.env.NODE_ENV === "production") {
    const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${PORT}/api/health`);
        console.log(`[keep-alive] pinged /api/health → ${res.status}`);
      } catch (err) {
        console.warn("[keep-alive] self-ping failed:", err);
      }
    }, PING_INTERVAL_MS);

    console.log("[keep-alive] self-ping enabled (every 5 min)");
  }
});