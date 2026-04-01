import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Mock Blog Publishing API
  app.post("/api/publish", (req, res) => {
    const { title, content, blogType } = req.body;
    console.log(`Publishing to ${blogType}:`, title);
    
    // In a real app, you would use Naver/Tistory API here
    // For now, we simulate success
    setTimeout(() => {
      res.json({ 
        success: true, 
        message: "Successfully published to blog!",
        url: "https://blog.example.com/post/123" 
      });
    }, 2000);
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
