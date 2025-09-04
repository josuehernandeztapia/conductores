#!/usr/bin/env bash
set -euo pipefail

echo "🚀 TESTING PRODUCTION BUILD LOCALLY"
echo "==================================="

# Project-relative dist path (adjust if different). Can be overridden by first arg
BUILD_DIR_DEFAULT="dist/conductores-pwa/browser"
BUILD_DIR="${1:-$BUILD_DIR_DEFAULT}"
PORT="4200"

if [ -d "$BUILD_DIR" ]; then
    echo "✅ Production build found"
    echo "📊 Build size: $(du -sh "$BUILD_DIR" | cut -f1)"
    echo "📁 Key files:"
    ls -1 "$BUILD_DIR"/*.js 2>/dev/null | head -3 || true
else
    echo "❌ No production build found at $BUILD_DIR"
    echo "🔧 Run: npm run build:prod"
    echo "💡 Tip: You can pass a custom directory, e.g.:"
    echo "    bash scripts/serve-prod.sh dist/your-app/browser"
    exit 1
fi

if ! command -v serve >/dev/null 2>&1; then
    echo "📦 Installing serve..."
    npm install -g serve >/dev/null 2>&1 || {
        echo "❌ Failed to install serve globally. Trying npx...";
    }
fi

echo ""
echo "🌐 Starting production server..."
echo "📍 URL: http://localhost:${PORT}"
echo "🎯 Mode: SPA (all routes work)"
echo "⚡ Build: Production optimized"
echo ""
echo "🧪 TEST THESE URLS:"
echo "- http://localhost:${PORT}"
echo "- http://localhost:${PORT}/dashboard"
echo "- http://localhost:${PORT}/avi-interview"
echo "- http://localhost:${PORT}/cotizador"
echo ""
echo "🔧 Stop with: Ctrl+C"
echo ""

# Serve production build with SPA support
if command -v serve >/dev/null 2>&1; then
  serve -s "$BUILD_DIR" -l "$PORT"
else
  npx --yes serve -s "$BUILD_DIR" -l "$PORT"
fi

