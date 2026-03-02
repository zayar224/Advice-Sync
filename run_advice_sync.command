#!/bin/bash
set -euo pipefail

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to the project directory
cd "$SCRIPT_DIR"

echo "🚀 Starting Local Advice Sync..."
echo "Project directory: $SCRIPT_DIR"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
fi

# Optional: run headful if the first argument is 'headful'
if [ "${1-}" = "headful" ]; then
  export HEADLESS=false
fi

# Run via npm script so ts-node and dotenv are picked up
npm run sync

# Keep the terminal window open after completion
echo ""
echo "👋 Script completed! Press any key to close this window."
read -n 1 -s
