#!/bin/zsh
# Double-click this file to start the dashboard and open it in your browser.
cd "$(dirname "$0")"
(sleep 1; open "http://localhost:4577") &
exec node server.js
