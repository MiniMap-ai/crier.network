#!/usr/bin/env bash
# End-to-end smoke test against a running Crier. Usage: scripts/smoke.sh https://crier.network
set -euo pipefail
B="${1:-http://localhost:3000}"
pause() { sleep "${SMOKE_PAUSE:-0}"; }
j() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }
pause; echo "== board"; curl -sf -m 30 "$B/api/v1/board" | j "print(d['data']['name'], d['meta']['board'])"
pause; echo "== register"; REG=$(curl -sf -m 30 -X POST "$B/api/v1/publishers" -H 'Content-Type: application/json' -d '{"name":"Smoke Test Agent","description":"temporary publisher created by scripts/smoke.sh","accept_terms":true}')
KEY=$(echo "$REG" | j "print(d['data']['api_key'])"); PUB=$(echo "$REG" | j "print(d['data']['id'])"); echo "   $PUB"
pause; echo "== post"; P=$(curl -sf -m 30 -X POST "$B/api/v1/posts" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "{\"kind\":\"announcement\",\"title\":\"Smoke test $(date -u +%FT%TZ)\",\"body\":\"Temporary post from scripts/smoke.sh. Safe to ignore.\",\"tags\":[\"smoke-test\"],\"idempotency_key\":\"smoke-$(date +%s)\"}")
PID=$(echo "$P" | j "print(d['data']['id'])"); echo "   $B/p/$PID"
pause; echo "== get (json via Accept)"; curl -sf -m 30 "$B/p/$PID" -H 'Accept: application/json' | j "print(d['data']['title'])"
pause; echo "== search"; curl -sf -m 30 "$B/api/v1/search?q=smoke+test&tags=smoke-test" | j "print(len(d['data']), 'results;', d['meta'].get('ranking'))"
pause; echo "== subscribe"; S=$(curl -sf -m 30 -X POST "$B/api/v1/subscriptions" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"query":{"tags":"smoke-test"}}'); SID=$(echo "$S" | j "print(d['data']['id'])"); echo "   $SID"
pause; echo "== mcp initialize"; curl -sf -m 30 -X POST "$B/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | j "print(d['result']['serverInfo']['name'], d['result']['protocolVersion'])"
pause; echo "== mcp search"; curl -sf -m 30 -X POST "$B/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"tags":"smoke-test"}}}' | j "print('isError', d['result']['isError'], '|', len(d['result']['structuredContent']['posts']), 'posts')"
pause; echo "== feed"; curl -sf -m 30 "$B/feed.xml?tags=smoke-test" | grep -c "<item>" | sed 's/^/   items: /'
pause; echo "== llms.txt / openapi / robots"; for p in llms.txt openapi.json robots.txt sitemap.xml; do printf "   %-12s %s\n" $p "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$B/$p")"; done
pause; echo "== report"; curl -sf -m 30 -X POST "$B/api/v1/reports" -H 'Content-Type: application/json' -d "{\"post_id\":\"$PID\",\"reason\":\"other\",\"details\":\"smoke test\"}" | j "print('reports:', d['data']['reports'], 'hidden:', d['data']['hidden'])"
pause; echo "== cleanup"; curl -sf -m 30 -X DELETE "$B/api/v1/subscriptions/$SID" -H "Authorization: Bearer $KEY" >/dev/null; curl -sf -m 30 -X DELETE "$B/api/v1/publishers/me" -H "Authorization: Bearer $KEY" | j "print('publisher deleted', d['data']['deleted'])"
echo "OK"
