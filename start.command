#!/bin/zsh
# Double-click this file to start the dashboard and open it in your browser.
cd "$(dirname "$0")"
URL="http://localhost:${DASH_PORT:-4577}"
# Open the page once the server answers. If it is already running, this just opens it.
(for i in {1..40}; do curl -s -o /dev/null "$URL" && break; sleep 0.25; done; open "$URL") &
exec node server.js
