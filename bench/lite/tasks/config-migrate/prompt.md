We're moving our service configs in `configs/` from schema v1 to v2. Rewrite every `configs/*.json` in place to v2. Spec:

v1 keys: `version` (1), `name`, `host`, `port`, `use_tls` (bool, default false), `timeout` (either a number of seconds, or a string like "30s", "1.5s", "250ms", "2m"), `retries` (optional int), `tags` (comma-separated string, may have spaces/dupes/mixed case; optional).

v2 shape:
{"version": 2, "name": <same>, "server": {"url": "<scheme>://<host>[:<port>]"}, "timeout_ms": <int milliseconds>, "retry": {"max": <retries, default 3>}, "tags": [<unique, lowercase, trimmed, sorted; [] if none>]}

scheme is https if use_tls else http. Omit the port from the url when it's the default for the scheme (443 for https, 80 for http). Drop empty tags. Any unknown v1 keys should be preserved under `"extra": {...}` (omit `extra` if there are none). Leave files that are already v2 unchanged.
