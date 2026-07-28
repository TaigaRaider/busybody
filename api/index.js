let app;
try {
  app = (await import("../server/src/index.js")).default;
} catch (e) {
  console.error("Init error:", e);
  app = (req, res) => {
    res.status(500).json({ error: "Init failed", message: e.message });
  };
}

export default app;
