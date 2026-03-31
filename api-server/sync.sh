#!/bin/bash
cd /var/www/web
git add -A
if git diff --cached --quiet; then
    exit 0
fi
git commit -m "自动同步 $(date '+%Y-%m-%d %H:%M')"
git push origin dynamic --force 2>&1
