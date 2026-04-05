<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/c3782a94-6dbe-45b8-93ba-ef413923b904

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Always-on Mobile Deployment (Recommended)

Use a container platform (Railway, Render, Fly.io) so your phone can access a stable HTTPS URL.

### Railway (Dockerfile in this repo)

1. Install and login Railway CLI.
2. In this project directory, run:
   `railway init` (or link existing project)
3. Deploy from local:
   `railway up`
4. Set environment variables in Railway:
   - `GEMINI_API_KEYS` (comma-separated key pool)
   - `NAVER_USERNAME`
   - `NAVER_PASSWORD`
   - `NAVER_BLOG_ID`
   - optional: `NAVER_LOGIN_MODE=hybrid`
   - recommended: `BROWSER_HEADLESS=true` (server container safety)
   - optional: `NAVER_TRACE_ENABLED=false` (reduce trace I/O in production)
5. Verify health:
   `GET /api/health`
6. Open the Railway-generated domain from your phone.

This project includes:
- `Dockerfile` for Linux + Chrome runtime
- `.dockerignore`
- production start script (`npm run start`)
