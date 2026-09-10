#!/usr/bin/env python3
"""Fetch and digest one Server project Session's history for acceptance checks.

Usage:
  ./show-history.py --user U --project P [--port 3081] [--host 127.0.0.1]
                    [--tail N] [--grep STRING] [--absent STRING] [--raw]

Default output is one line per event: `seq type <data preview>`, which is what an
operator (human or AI) can assert on. Exit codes are mechanical:

  0  the request succeeded and every --grep matched, every --absent did not
  1  a --grep string was not found, or an --absent string was found
  2  the HTTP request or the response envelope failed

The Server returns a stable generic error to clients and logs details host-side,
so a 2 here means "look at the server log", not "the contract is broken".
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def fetch(base: str, user: str, project: str, timeout: float) -> dict:
    url = f'{base}/v1/users/{user}/projects/{project}/history'
    request = urllib.request.Request(url, method='GET')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            envelope = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        print(f'HTTP {error.code} from {url}', file=sys.stderr)
        raise SystemExit(2) from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        print(f'request failed for {url}: {error}', file=sys.stderr)
        raise SystemExit(2) from error
    if not isinstance(envelope, dict) or envelope.get('ok') is not True:
        print(f'history envelope not ok: {json.dumps(envelope)[:400]}', file=sys.stderr)
        raise SystemExit(2)
    value = envelope.get('value')
    if not isinstance(value, dict):
        print('history value is not an object', file=sys.stderr)
        raise SystemExit(2)
    return value


def digest(event: dict, preview: int) -> str:
    inner = event.get('event') if isinstance(event.get('event'), dict) else event
    seq = inner.get('seq')
    kind = inner.get('type')
    data = inner.get('data')
    text = json.dumps(data, ensure_ascii=False, sort_keys=True) if data is not None else ''
    if len(text) > preview:
        text = text[:preview] + f'...(+{len(text) - preview} chars)'
    return f'{seq} {kind} {text}'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--user', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=3081)
    parser.add_argument('--tail', type=int, default=0, help='show only the last N events (0 = all)')
    parser.add_argument('--preview', type=int, default=400, help='data characters per event line')
    parser.add_argument('--grep', action='append', default=[], help='string that MUST appear in some event')
    parser.add_argument('--absent', action='append', default=[], help='string that MUST NOT appear anywhere')
    parser.add_argument('--raw', action='store_true', help='print the whole envelope instead of a digest')
    parser.add_argument('--timeout', type=float, default=60.0)
    args = parser.parse_args()

    base = f'http://{args.host}:{args.port}'
    value = fetch(base, args.user, args.project, args.timeout)
    if args.raw:
        json.dump(value, sys.stdout, ensure_ascii=False, indent=1)
        print()
        return 0

    events = value.get('events')
    events = events if isinstance(events, list) else []
    shown = events[-args.tail:] if args.tail > 0 else events
    for event in shown:
        if isinstance(event, dict):
            print(digest(event, args.preview))

    projections = value.get('projections')
    if isinstance(projections, dict):
        values = projections.get('values')
        if isinstance(values, dict):
            keep = {key: values.get(key) for key in ('title', 'tokenUsage', 'contextBreakdown') if key in values}
            print(f'# projections {json.dumps(keep, ensure_ascii=False)}')

    blob = json.dumps(value, ensure_ascii=False)
    failed = False
    for needle in args.grep:
        if needle in blob:
            print(f'# grep ok      {needle!r}')
        else:
            print(f'# grep MISSING {needle!r}')
            failed = True
    for needle in args.absent:
        if needle in blob:
            print(f'# absent FOUND {needle!r} (must not be present)')
            failed = True
        else:
            print(f'# absent ok    {needle!r}')
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
