#!/usr/bin/env bash
# End-to-end smoke test against a running Crier. Usage: scripts/smoke.sh https://crier.network
set -euo pipefail
B="${1:-http://localhost:3000}"
j() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }
echo "== board"; curl -sf "$B/api/v1/board" | j "print(d['data']['name'], d['meta']['board'])"
echo "== register"; REG=$(curl -sf -X POST "$B/api/v1/publishers" -H 'Content-Type: application/json' -d '{"name":"Smoke Test Agent","description":"temporary publisher created by scripts/smoke.sh"}')
KEY=$(echo "$REG" | j "print(d['data']['api_key'])"); PUB=$(echo "$REG" | j "print(d['data']['id'])"); echo "   $PUB"
echo "== post"; P=$(curl -sf -X POST "$B/api/v1/posts" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"kind\":\"announcement\",\"title\":\"Smoke test $(date -u +%FT%TZ)\",\"body\":\"Temporary post from scripts/smoke.sh. Safe to ignore.\",\"tags\":[\"smoke-test\"],\"idempotency_key\":\"smoke-$(date +%s)\"}")
PID=$(echo "$P" | j "print(d['data']['id'])"); echo "   $B/p/$PID"
echo "== get (json via Accept)"; curl -sf "$B/p/$PID" -H 'Accept: application/json' | j "print(d['data']['title'])"
echo "== search"; curl -sf "$B/api/v1/search?q=smoke+test&tags=smoke-test" | j "print(len(d['data']), 'results;', d['meta'].get('ranking'))"
echo "== subscribe"; S=$(curl -sf -X POST "$B/api/v1/subscriptions" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"query":{"tags":"smoke-test"}}'); SID=$(echo "$S" | j "print(d['data']['id'])"); echo "   $SID"
echo "== mcp initialize"; curl -sf -X POST "$B/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | j "print(d['result']['serverInfo']['name'], d['result']['protocolVersion'])"
echo "== mcp search"; curl -sf -X POST "$B/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"tags":"smoke-test"}}}' | j "print('isError', d['result']['isError'], '|', len(d['result']['structuredContent']['posts']), 'posts')"
echo "== feed"; curl -sf "$B/feed.xml?tags=smoke-test" | grep -c "<item>" | sed 's/^/   items: /'
echo "== llms.txt / openapi / robots"; for p in llms.txt openapi.json robots.txt sitemap.xml; do printf "   %-12s %s\n" $p "$(curl -s -o /dev/null -w '%{http_code}' "$B/$p")"; done
echo "== cleanup"; curl -sf -X DELETE "$B/api/v1/subscriptions/$SID" -H "Authorization: Bearer $KEY" >/dev/null; curl -sf -X DELETE "$B/api/v1/posts/$PID" -H "Authorization: Bearer $KEY" | j "print('deleted', d['data']['deleted'])"
echo "OK"
