//! MCP server configuration: one schema, every dialect.
//!
//! zWork stores servers in `~/.zwork/mcp.json` using the Claude shape
//! (`{"mcpServers": {...}}`) so snippets from any README paste straight in,
//! but it reads every dialect the ecosystem uses:
//!
//! | dialect                           | root key      | notes                                       |
//! |-----------------------------------|---------------|---------------------------------------------|
//! | Claude Desktop / Code, Cursor     | `mcpServers`  | `command`+`args`, or `url` + `type`         |
//! | Windsurf, Gemini CLI              | `mcpServers`  | `serverUrl` / `httpUrl` for remote servers  |
//! | VS Code                           | `servers`     | `type: stdio \| http \| sse`                |
//! | opencode                          | `mcp`         | `type: local \| remote`, `command: [..]`    |
//! | Codex                             | `mcp_servers` | TOML tables in `~/.codex/config.toml`       |
//!
//! Placeholders (`${VAR}`, `${VAR:-default}`, `${env:VAR}`, `{env:VAR}`) are
//! kept verbatim on disk and expanded only when a server is launched, so
//! secrets can live in the environment instead of the file.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// How to reach a server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TransportSpec {
    /// A local process speaking JSON-RPC over stdin/stdout.
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Streamable HTTP (MCP 2025-03-26+), falling back to legacy SSE when
    /// `fallback_sse` and the server rejects the POST handshake.
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default)]
        fallback_sse: bool,
    },
    /// Legacy HTTP+SSE transport (MCP 2024-11-05).
    Sse {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

impl TransportSpec {
    pub fn kind(&self) -> &'static str {
        match self {
            TransportSpec::Stdio { .. } => "stdio",
            TransportSpec::Http { .. } => "http",
            TransportSpec::Sse { .. } => "sse",
        }
    }

    /// One-line description for the UI (`npx -y @x/server`, a URL).
    pub fn summary(&self) -> String {
        match self {
            TransportSpec::Stdio { command, args, .. } => {
                std::iter::once(command.as_str()).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
            }
            TransportSpec::Http { url, .. } | TransportSpec::Sse { url, .. } => url.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerSpec {
    pub name: String,
    #[serde(flatten)]
    pub transport: TransportSpec,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Per-request timeout override (opencode `timeout`, Gemini `timeout`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

fn default_true() -> bool {
    true
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/// Every server declared in a config document, whatever its dialect.
pub fn parse_document(doc: &Value) -> Vec<ServerSpec> {
    let mut out = Vec::new();
    for key in ["mcpServers", "servers", "mcp", "mcp_servers"] {
        if let Some(map) = doc.get(key).and_then(Value::as_object) {
            out.extend(map.iter().filter_map(|(name, entry)| parse_entry(name, entry)));
        }
    }
    // VS Code nests under `mcp.servers` in settings.json.
    if let Some(map) = doc.pointer("/mcp/servers").and_then(Value::as_object) {
        out.extend(map.iter().filter_map(|(name, entry)| parse_entry(name, entry)));
    }
    out
}

/// One server entry in any dialect. `None` for entries that name neither a
/// command nor a URL (or VS Code's `servers` object nested in `mcp`).
pub fn parse_entry(name: &str, entry: &Value) -> Option<ServerSpec> {
    let obj = entry.as_object()?;
    let s = |k: &str| obj.get(k).and_then(Value::as_str).map(str::to_string);
    let strings = |k: &str| -> Vec<String> {
        obj.get(k)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let string_map = |keys: &[&str]| -> BTreeMap<String, String> {
        keys.iter()
            .filter_map(|k| obj.get(*k).and_then(Value::as_object))
            .flat_map(|m| m.iter())
            .filter_map(|(k, v)| match v {
                Value::String(s) => Some((k.clone(), s.clone())),
                Value::Number(_) | Value::Bool(_) => Some((k.clone(), v.to_string())),
                _ => None,
            })
            .collect()
    };

    let kind = s("type").unwrap_or_default().to_ascii_lowercase();
    let url = s("url").or_else(|| s("serverUrl")).or_else(|| s("httpUrl"));
    let headers = string_map(&["headers", "http_headers"]);

    let transport = if let Some(url) = url.filter(|u| !u.trim().is_empty()) {
        match kind.as_str() {
            "sse" => TransportSpec::Sse { url, headers },
            "http" | "streamable-http" | "streamablehttp" | "streamable_http" => {
                TransportSpec::Http { url, headers, fallback_sse: false }
            }
            // Gemini's `httpUrl` is explicitly streamable; everything else
            // untyped gets opencode's streamable-then-SSE negotiation.
            _ => TransportSpec::Http { url, headers, fallback_sse: !obj.contains_key("httpUrl") },
        }
    } else {
        // opencode: `command: ["npx", "-y", "pkg"]`; everyone else: string + args.
        let (command, mut args) = match obj.get("command") {
            Some(Value::Array(parts)) => {
                let mut parts = parts.iter().filter_map(|v| v.as_str().map(str::to_string));
                (parts.next()?, parts.collect::<Vec<_>>())
            }
            Some(Value::String(c)) => (c.clone(), Vec::new()),
            _ => return None,
        };
        if command.trim().is_empty() {
            return None;
        }
        args.extend(strings("args"));
        TransportSpec::Stdio {
            command,
            args,
            env: string_map(&["env", "environment"]),
            cwd: s("cwd"),
        }
    };

    let disabled = obj.get("disabled").and_then(Value::as_bool).unwrap_or(false);
    let enabled = obj.get("enabled").and_then(Value::as_bool).unwrap_or(!disabled);
    let timeout_ms = obj
        .get("timeout_ms")
        .or_else(|| obj.get("timeout"))
        .and_then(Value::as_u64)
        .or_else(|| obj.get("tool_timeout_sec").and_then(Value::as_u64).map(|s| s * 1000));
    Some(ServerSpec { name: name.to_string(), transport, enabled, timeout_ms })
}

/// Claude-shape entry for persisting a spec (what zWork writes to disk).
pub fn to_entry(spec: &ServerSpec) -> Value {
    let mut entry = match &spec.transport {
        TransportSpec::Stdio { command, args, env, cwd } => {
            let mut m = json!({ "command": command, "args": args });
            if !env.is_empty() {
                m["env"] = json!(env);
            }
            if let Some(cwd) = cwd {
                m["cwd"] = json!(cwd);
            }
            m
        }
        TransportSpec::Http { url, headers, fallback_sse } => {
            // An untyped URL round-trips to the negotiating transport.
            let mut m = if *fallback_sse { json!({ "url": url }) } else { json!({ "type": "http", "url": url }) };
            if !headers.is_empty() {
                m["headers"] = json!(headers);
            }
            m
        }
        TransportSpec::Sse { url, headers } => {
            let mut m = json!({ "type": "sse", "url": url });
            if !headers.is_empty() {
                m["headers"] = json!(headers);
            }
            m
        }
    };
    if !spec.enabled {
        entry["enabled"] = json!(false);
    }
    if let Some(t) = spec.timeout_ms {
        entry["timeout_ms"] = json!(t);
    }
    entry
}

// ── Interpolation ───────────────────────────────────────────────────────────

/// Expand `${VAR}`, `${VAR:-default}`, `${env:VAR}` and `{env:VAR}`.
/// Unknown variables expand to the empty string (Claude Code semantics).
pub fn interpolate(input: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('{') {
        let dollar = start > 0 && rest.as_bytes()[start - 1] == b'$';
        let Some(len) = rest[start..].find('}') else { break };
        let inner = &rest[start + 1..start + len];
        let (name, default) = match inner.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        let name = name.strip_prefix("env:").map(|n| (n, true)).unwrap_or((name, false));
        let valid = !name.0.is_empty() && name.0.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        // `{env:X}` is opencode's form; bare `{X}` without `$` is literal text.
        if valid && (dollar || name.1) {
            out.push_str(&rest[..if dollar { start - 1 } else { start }]);
            let value = lookup(name.0).filter(|v| !v.is_empty());
            out.push_str(&value.or_else(|| default.map(str::to_string)).unwrap_or_default());
        } else {
            out.push_str(&rest[..start + len + 1]);
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out
}

/// A copy of `spec` with every placeholder expanded against the process env.
pub fn resolved(spec: &ServerSpec) -> ServerSpec {
    let env = |k: &str| std::env::var(k).ok();
    let x = |s: &String| interpolate(s, &env);
    let map = |m: &BTreeMap<String, String>| m.iter().map(|(k, v)| (k.clone(), x(v))).collect();
    let transport = match &spec.transport {
        TransportSpec::Stdio { command, args, env: vars, cwd } => TransportSpec::Stdio {
            command: expand_home(&x(command)),
            args: args.iter().map(x).collect(),
            env: map(vars),
            cwd: cwd.as_ref().map(|c| expand_home(&x(c))),
        },
        TransportSpec::Http { url, headers, fallback_sse } => {
            TransportSpec::Http { url: x(url), headers: map(headers), fallback_sse: *fallback_sse }
        }
        TransportSpec::Sse { url, headers } => TransportSpec::Sse { url: x(url), headers: map(headers) },
    };
    ServerSpec { transport, ..spec.clone() }
}

fn expand_home(p: &str) -> String {
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => p.to_string(),
    }
}

// ── JSONC ───────────────────────────────────────────────────────────────────

/// Strip `//` and `/* */` comments and trailing commas so opencode's
/// `opencode.jsonc` and VS Code's settings parse as JSON.
pub fn strip_jsonc(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match c {
                '\\' => out.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                while chars.peek().is_some_and(|&n| n != '\n') {
                    chars.next();
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            (',', _) => {
                // Drop the comma when only whitespace/comments precede a closer.
                let lookahead: String = chars.clone().collect();
                let next = strip_jsonc_lead(&lookahead);
                if !matches!(next.chars().next(), Some('}') | Some(']')) {
                    out.push(c);
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn strip_jsonc_lead(s: &str) -> &str {
    let mut s = s.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("//") {
            s = rest.find('\n').map_or("", |i| &rest[i..]).trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.find("*/").map_or("", |i| &rest[i + 2..]).trim_start();
        } else {
            return s;
        }
    }
}

// ── zWork's own config file ─────────────────────────────────────────────────

pub fn config_path() -> PathBuf {
    crate::paths::home_dir().join("mcp.json")
}

/// Servers from `~/.zwork/mcp.json`, in file order. Missing or malformed
/// files yield nothing rather than failing the agent turn.
pub fn load() -> Vec<ServerSpec> {
    read_document(&config_path()).map(|doc| parse_document(&doc)).unwrap_or_default()
}

/// Persist `servers` in the Claude shape, preserving unrelated top-level
/// keys a user may have added.
pub fn save(servers: &[ServerSpec]) -> std::io::Result<()> {
    let path = config_path();
    let mut doc = read_document(&path).and_then(|d| d.as_object().cloned()).unwrap_or_default();
    for key in ["servers", "mcp", "mcp_servers"] {
        doc.remove(key);
    }
    let entries: Map<String, Value> = servers.iter().map(|s| (s.name.clone(), to_entry(s))).collect();
    doc.insert("mcpServers".into(), Value::Object(entries));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&Value::Object(doc))?)?;
    std::fs::rename(tmp, path)
}

fn read_document(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    if path.extension().is_some_and(|e| e == "toml") {
        return parse_codex_toml(&raw);
    }
    serde_json::from_str(&raw).or_else(|_| serde_json::from_str(&strip_jsonc(&raw))).ok()
}

// ── Discovery (import from other tools) ─────────────────────────────────────

/// A tool whose MCP config zWork knows how to import.
pub struct Source {
    pub id: &'static str,
    pub label: &'static str,
    pub paths: Vec<PathBuf>,
}

pub fn sources() -> Vec<Source> {
    let home = dirs::home_dir().unwrap_or_default();
    let config = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
    let xdg = home.join(".config");
    vec![
        Source { id: "claude-desktop", label: "Claude Desktop", paths: vec![config.join("Claude/claude_desktop_config.json")] },
        Source { id: "claude-code", label: "Claude Code", paths: vec![home.join(".claude.json")] },
        Source { id: "cursor", label: "Cursor", paths: vec![home.join(".cursor/mcp.json")] },
        Source {
            id: "vscode",
            label: "VS Code",
            paths: vec![config.join("Code/User/mcp.json"), config.join("Code/User/settings.json")],
        },
        Source { id: "windsurf", label: "Windsurf", paths: vec![home.join(".codeium/windsurf/mcp_config.json")] },
        Source {
            id: "opencode",
            label: "opencode",
            paths: vec![xdg.join("opencode/opencode.json"), xdg.join("opencode/opencode.jsonc"), xdg.join("opencode/config.json")],
        },
        Source { id: "gemini", label: "Gemini CLI", paths: vec![home.join(".gemini/settings.json")] },
        Source { id: "codex", label: "Codex", paths: vec![home.join(".codex/config.toml")] },
    ]
}

/// Servers another tool has configured, per source that has any.
pub fn discover() -> Vec<(&'static Source, Vec<ServerSpec>)> {
    // Leak once: sources are static data and discovery is rare.
    let sources: &'static [Source] = Box::leak(sources().into_boxed_slice());
    sources
        .iter()
        .filter_map(|src| {
            let mut found: Vec<ServerSpec> = Vec::new();
            for spec in src.paths.iter().filter_map(|p| read_document(p)).flat_map(|d| parse_document(&d)) {
                if !found.iter().any(|f| f.name == spec.name) {
                    found.push(spec);
                }
            }
            (!found.is_empty()).then_some((src, found))
        })
        .collect()
}

/// Minimal reader for Codex's `[mcp_servers.<name>]` tables — just the keys
/// MCP needs (`command`, `args`, `env`, `url`, `enabled`), not general TOML.
fn parse_codex_toml(raw: &str) -> Option<Value> {
    let mut servers = Map::new();
    let mut current: Option<(String, Option<String>)> = None; // (server, subtable)
    for line in raw.lines() {
        let line = line.split(" #").next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = header.strip_prefix("mcp_servers.").map(|rest| {
                let mut parts = rest.splitn(2, '.');
                let name = parts.next().unwrap_or("").trim_matches('"').to_string();
                (name, parts.next().map(str::to_string))
            });
            continue;
        }
        let Some((server, sub)) = &current else { continue };
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().trim_matches('"');
        let value = toml_value(value.trim())?;
        let entry = servers.entry(server.clone()).or_insert_with(|| json!({}));
        match sub.as_deref() {
            None => entry[key] = value,
            Some(table) => {
                if entry.get(table).is_none() {
                    entry[table] = json!({});
                }
                entry[table][key] = value;
            }
        }
    }
    Some(json!({ "mcp_servers": servers }))
}

fn toml_value(v: &str) -> Option<Value> {
    if v.starts_with('{') {
        // Inline table: `{ KEY = "v", OTHER = "w" }`.
        let body = v.trim_start_matches('{').trim_end_matches('}');
        let mut m = Map::new();
        for pair in body.split(',') {
            if let Some((k, val)) = pair.split_once('=') {
                m.insert(k.trim().trim_matches('"').to_string(), toml_value(val.trim())?);
            }
        }
        return Some(Value::Object(m));
    }
    // Strings, arrays of strings, numbers and booleans are valid JSON once
    // single quotes become double quotes.
    serde_json::from_str(&v.replace('\'', "\"")).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_dialect() {
        let claude = json!({ "mcpServers": {
            "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"], "env": { "A": "1" } },
            "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" } },
            "old": { "type": "sse", "url": "https://example.com/sse", "disabled": true },
            "wind": { "serverUrl": "https://w.example/mcp" }
        }});
        let specs = parse_document(&claude);
        assert_eq!(specs.len(), 4);
        assert!(matches!(&specs[0].transport, TransportSpec::Stdio { args, env, .. } if args.len() == 3 && env["A"] == "1"));
        assert!(matches!(&specs[1].transport, TransportSpec::Http { fallback_sse: false, headers, .. } if headers.contains_key("Authorization")));
        assert!(matches!(specs[2].transport, TransportSpec::Sse { .. }) && !specs[2].enabled);
        assert!(matches!(specs[3].transport, TransportSpec::Http { fallback_sse: true, .. }));

        let opencode = json!({ "mcp": {
            "local": { "type": "local", "command": ["bun", "x", "my-mcp"], "environment": { "K": "v" }, "enabled": false, "timeout": 9000 },
            "remote": { "type": "remote", "url": "https://mcp.context7.com/mcp" }
        }});
        let specs = parse_document(&opencode);
        let TransportSpec::Stdio { command, args, env, .. } = &specs[0].transport else { panic!() };
        assert_eq!((command.as_str(), args.len(), env["K"].as_str()), ("bun", 2, "v"));
        assert!(!specs[0].enabled);
        assert_eq!(specs[0].timeout_ms, Some(9000));
        assert!(matches!(specs[1].transport, TransportSpec::Http { .. }));

        let vscode = json!({ "servers": { "gh": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" } } });
        assert_eq!(parse_document(&vscode).len(), 1);
        let vscode_settings = json!({ "mcp": { "servers": { "gh": { "type": "stdio", "command": "gh-mcp" } } } });
        assert_eq!(parse_document(&vscode_settings).len(), 1);
    }

    #[test]
    fn round_trips_through_claude_shape() {
        let doc = json!({ "mcpServers": {
            "a": { "command": "uvx", "args": ["mcp-server-time"] },
            "b": { "url": "https://x/mcp", "headers": { "H": "v" }, "enabled": false },
            "c": { "type": "sse", "url": "https://y/sse" }
        }});
        let specs = parse_document(&doc);
        let entries: Map<String, Value> = specs.iter().map(|s| (s.name.clone(), to_entry(s))).collect();
        assert_eq!(parse_document(&json!({ "mcpServers": entries })), specs);
    }

    #[test]
    fn interpolates_all_placeholder_forms() {
        let env = |k: &str| match k {
            "TOKEN" => Some("abc".to_string()),
            _ => None,
        };
        assert_eq!(interpolate("Bearer ${TOKEN}", &env), "Bearer abc");
        assert_eq!(interpolate("${env:TOKEN}/{env:TOKEN}", &env), "abc/abc");
        assert_eq!(interpolate("${MISSING:-fallback}", &env), "fallback");
        assert_eq!(interpolate("${MISSING}x", &env), "x");
        assert_eq!(interpolate("{\"json\": {literal}}", &env), "{\"json\": {literal}}");
    }

    #[test]
    fn jsonc_and_codex_toml() {
        let src = "{\n // comment\n \"mcp\": { \"a\": { \"type\": \"remote\", \"url\": \"https://x//y\" /* c */, }, },\n}";
        let doc: Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(doc["mcp"]["a"]["url"], "https://x//y");

        let toml = "model = \"o3\"\n\n[mcp_servers.docs]\ncommand = \"npx\"\nargs = [\"-y\", \"docs-mcp\"]\nenv = { \"API_KEY\" = \"k\" }\n\n[mcp_servers.remote]\nurl = \"https://r/mcp\"\n[mcp_servers.remote.http_headers]\nX = \"1\"\n";
        let specs = parse_document(&parse_codex_toml(toml).unwrap());
        assert_eq!(specs.len(), 2);
        assert!(matches!(&specs[0].transport, TransportSpec::Stdio { env, .. } if env["API_KEY"] == "k"));
        assert!(matches!(&specs[1].transport, TransportSpec::Http { headers, .. } if headers["X"] == "1"));
    }
}
