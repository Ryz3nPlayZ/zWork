//! Provider + model catalog, backed by [models.dev](https://models.dev) — the
//! same registry opencode reads, so any provider either tool lists resolves
//! here too.
//!
//! models.dev describes each provider by the AI-SDK npm package that talks to
//! it. That package names a wire protocol, which maps onto one of our four
//! adapters ([`Api`]). A snapshot is embedded in the binary (offline / first
//! launch); [`refresh_if_stale`] swaps in a fresh copy at most once a day.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;

use crate::harness::types::{Api, InputType, Model, ModelCost};

const EMBEDDED: &str = include_str!("data/models.json");
const SOURCE_URL: &str = "https://models.dev/api.json";
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Defaults for models the catalog doesn't know (custom ids, local models).
const FALLBACK_CONTEXT: u64 = 128_000;
const FALLBACK_OUTPUT: u64 = 16_384;

#[derive(Debug, Clone, Serialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub images: bool,
    pub context: u64,
    pub output: u64,
    pub cost: ModelCost,
    /// Protocol + endpoint for this model; gateways mix protocols per model.
    pub api: Api,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    /// Env vars that carry the API key (first match wins).
    pub env: Vec<String>,
    /// Non-secret settings the base URL needs, e.g. `AZURE_RESOURCE_NAME`.
    pub vars: Vec<String>,
    pub doc: String,
    /// `None` when the provider needs an auth flow we don't speak (cloud IAM,
    /// device OAuth). Listed so the UI can say so instead of silently failing.
    pub api: Option<Api>,
    pub base_url: String,
    pub keyless: bool,
    pub models: Vec<CatalogModel>,
}

impl CatalogProvider {
    pub fn supported(&self) -> bool {
        self.api.is_some()
    }

    pub fn model(&self, id: &str) -> Option<&CatalogModel> {
        self.models.iter().find(|m| m.id == id)
    }
}

#[derive(Debug, Default)]
pub struct Catalog {
    providers: BTreeMap<String, CatalogProvider>,
}

// ---------------------------------------------------------------------------
// npm package → wire protocol
// ---------------------------------------------------------------------------

/// Protocol and default endpoint for an AI-SDK package. `None` = unsupported.
fn wire(npm: &str) -> Option<(Api, &'static str)> {
    use Api::*;
    Some(match npm {
        "@ai-sdk/openai-compatible" | "@openrouter/ai-sdk-provider" => (OpenAICompletions, ""),
        "@ai-sdk/openai" => (OpenAIResponses, "https://api.openai.com/v1"),
        "@ai-sdk/azure" => (OpenAIResponses, "https://${AZURE_RESOURCE_NAME}.openai.azure.com/openai/v1"),
        "@ai-sdk/anthropic" => (AnthropicMessages, "https://api.anthropic.com"),
        "@ai-sdk/google" => (GoogleGenerativeAI, "https://generativelanguage.googleapis.com/v1beta"),
        "@ai-sdk/xai" => (OpenAIResponses, "https://api.x.ai/v1"),
        "@ai-sdk/mistral" => (OpenAICompletions, "https://api.mistral.ai/v1"),
        "@ai-sdk/groq" => (OpenAICompletions, "https://api.groq.com/openai/v1"),
        "@ai-sdk/cerebras" => (OpenAICompletions, "https://api.cerebras.ai/v1"),
        "@ai-sdk/deepinfra" => (OpenAICompletions, "https://api.deepinfra.com/v1/openai"),
        "@ai-sdk/togetherai" => (OpenAICompletions, "https://api.together.xyz/v1"),
        "@ai-sdk/perplexity" => (OpenAICompletions, "https://api.perplexity.ai"),
        "@ai-sdk/cohere" => (OpenAICompletions, "https://api.cohere.ai/compatibility/v1"),
        "@ai-sdk/gateway" => (OpenAICompletions, "https://ai-gateway.vercel.sh/v1"),
        "@ai-sdk/vercel" => (OpenAICompletions, "https://api.v0.dev/v1"),
        "venice-ai-sdk-provider" => (OpenAICompletions, "https://api.venice.ai/api/v1"),
        "@aihubmix/ai-sdk-provider" => (OpenAICompletions, "https://aihubmix.com/v1"),
        _ => return None,
    })
}

/// Providers whose models.dev entry looks OpenAI-compatible but whose auth is
/// an OAuth/device flow, not a pasteable key.
const OAUTH_ONLY: &[&str] = &["github-copilot", "github-models"];

/// Legacy zWork credential ids → models.dev provider ids.
const ALIASES: &[(&str, &str)] = &[("together", "togetherai"), ("fireworks", "fireworks-ai"), ("google-gemini", "google")];

/// A model's declared protocol ("shape" in Settings). Legacy values
/// `anthropic` / `openai` still parse; empty or `auto` defers to the catalog.
pub fn api_for_shape(shape: &str) -> Option<Api> {
    match shape.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "anthropic-messages" => Some(Api::AnthropicMessages),
        "openai" | "openai-completions" | "completions" => Some(Api::OpenAICompletions),
        "openai-responses" | "responses" => Some(Api::OpenAIResponses),
        "google" | "gemini" | "google-generative-ai" => Some(Api::GoogleGenerativeAI),
        _ => None,
    }
}

pub fn canonical_id(id: &str) -> &str {
    ALIASES.iter().find(|(a, _)| *a == id).map_or(id, |(_, c)| c)
}

fn is_secret_env(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    n.ends_with("_KEY") || n.ends_with("_TOKEN") || n.ends_with("_SECRET") || n.contains("API_KEY")
}

/// `${VAR}` placeholders in a URL template.
pub fn template_vars(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = url;
    while let Some(start) = rest.find("${") {
        let Some(end) = rest[start..].find('}') else { break };
        out.push(rest[start + 2..start + end].to_string());
        rest = &rest[start + end + 1..];
    }
    out
}

/// Fill `${VAR}` placeholders; unresolved ones are left in place.
pub fn interpolate(url: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut s = url.to_string();
    for var in template_vars(url) {
        if let Some(v) = lookup(&var).filter(|v| !v.is_empty()) {
            s = s.replace(&format!("${{{var}}}"), &v);
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn parse_cost(v: &Value) -> ModelCost {
    let f = |k: &str| v[k].as_f64().unwrap_or(0.0);
    ModelCost { input: f("input"), output: f("output"), cache_read: f("cache_read"), cache_write: f("cache_write"), tiers: Vec::new() }
}

fn parse_provider(pid: &str, p: &Value) -> CatalogProvider {
    let npm = p["npm"].as_str().unwrap_or("@ai-sdk/openai-compatible");
    let listed_api = p["api"].as_str().unwrap_or("").trim_end_matches('/').to_string();
    let provider_wire = wire(npm).filter(|_| !OAUTH_ONLY.contains(&pid));
    let base_url = if listed_api.is_empty() { provider_wire.map(|(_, b)| b.to_string()).unwrap_or_default() } else { listed_api };
    let api = provider_wire.map(|(a, _)| a).filter(|_| !base_url.is_empty());
    let env: Vec<String> = p["env"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(str::to_string)).collect();
    let (secret, config): (Vec<String>, Vec<String>) = env.into_iter().partition(|e| is_secret_env(e));

    let mut models: Vec<CatalogModel> = p["models"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, m)| m["tool_call"].as_bool() != Some(false) && m["status"].as_str() != Some("deprecated"))
        .filter_map(|(mid, m)| {
            // Gateways (opencode zen, zenmux, azure foundry…) route individual
            // models to a different protocol or endpoint.
            let over = &m["provider"];
            let (mapi, mbase) = match (over["npm"].as_str(), over["shape"].as_str()) {
                (_, Some("responses")) => (Some(Api::OpenAIResponses), None),
                (_, Some("completions")) => (Some(Api::OpenAICompletions), None),
                (Some(n), _) => match wire(n) {
                    Some((a, b)) => (Some(a), (!b.is_empty() && over["api"].is_null() && p["api"].is_null()).then(|| b.to_string())),
                    None => (None, None),
                },
                _ => (api, None),
            };
            let mapi = mapi?;
            let base = over["api"].as_str().map(|s| s.trim_end_matches('/').to_string()).or(mbase).unwrap_or_else(|| base_url.clone());
            let images = m["attachment"].as_bool().unwrap_or(false)
                && m["modalities"]["input"].as_array().map_or(true, |a| a.iter().any(|x| x == "image"));
            Some(CatalogModel {
                id: m["id"].as_str().unwrap_or(mid).to_string(),
                name: m["name"].as_str().unwrap_or(mid).to_string(),
                reasoning: m["reasoning"].as_bool().unwrap_or(false),
                images,
                context: m["limit"]["context"].as_u64().filter(|n| *n > 0).unwrap_or(FALLBACK_CONTEXT),
                output: m["limit"]["output"].as_u64().filter(|n| *n > 0).unwrap_or(FALLBACK_OUTPUT),
                cost: parse_cost(&m["cost"]),
                api: mapi,
                base_url: base,
            })
        })
        .collect();
    models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    CatalogProvider {
        id: pid.to_string(),
        name: p["name"].as_str().unwrap_or(pid).to_string(),
        keyless: secret.is_empty() && (base_url.contains("localhost") || base_url.contains("127.0.0.1")),
        env: secret,
        vars: config,
        doc: p["doc"].as_str().unwrap_or("").to_string(),
        api,
        base_url,
        models,
    }
}

/// Local Ollama isn't in models.dev (models are whatever the user pulled).
fn ollama() -> CatalogProvider {
    CatalogProvider {
        id: "ollama".into(),
        name: "Ollama (local)".into(),
        env: vec!["OLLAMA_API_KEY".into()],
        vars: Vec::new(),
        doc: "https://ollama.com".into(),
        api: Some(Api::OpenAICompletions),
        base_url: "http://localhost:11434/v1".into(),
        keyless: true,
        models: Vec::new(),
    }
}

impl Catalog {
    pub fn parse(json: &str) -> Option<Catalog> {
        let root: Value = serde_json::from_str(json).ok()?;
        let obj = root.as_object()?;
        let mut providers: BTreeMap<String, CatalogProvider> =
            obj.iter().map(|(id, p)| (id.clone(), parse_provider(id, p))).collect();
        providers.entry("ollama".into()).or_insert_with(ollama);
        // A truncated or error payload must not replace a good catalog.
        (providers.len() >= 20).then_some(Catalog { providers })
    }

    pub fn embedded() -> Catalog {
        Catalog::parse(EMBEDDED).expect("embedded models.dev snapshot parses")
    }

    pub fn providers(&self) -> impl Iterator<Item = &CatalogProvider> {
        self.providers.values()
    }

    pub fn provider(&self, id: &str) -> Option<&CatalogProvider> {
        self.providers.get(canonical_id(id))
    }

    /// Metadata for a model id served by some other provider — used to fill
    /// limits for ids a gateway doesn't list (`anthropic/claude-x` → `claude-x`).
    pub fn find_model(&self, id: &str) -> Option<&CatalogModel> {
        let bare = id.rsplit('/').next().unwrap_or(id);
        const FIRST_PARTY: &[&str] = &["anthropic", "openai", "google", "deepseek", "xai", "mistral", "moonshotai", "zai", "alibaba"];
        FIRST_PARTY
            .iter()
            .filter_map(|p| self.providers.get(*p))
            .chain(self.providers.values())
            .find_map(|p| p.model(id).or_else(|| p.model(bare)))
    }
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

/// What the caller already knows about where a model lives.
pub struct Target<'a> {
    pub provider: &'a str,
    pub model_id: &'a str,
    pub base_url: &'a str,
    /// Explicit protocol (user override or base-URL override); wins over the
    /// catalog because a proxy may only speak one dialect.
    pub api: Option<Api>,
}

/// Build a harness [`Model`] from the catalog, falling back to sane defaults
/// for ids it doesn't know.
pub fn build_model(cat: &Catalog, t: Target<'_>) -> Model {
    let provider = cat.provider(t.provider);
    let known = provider.and_then(|p| p.model(t.model_id));
    let meta = known.or_else(|| cat.find_model(t.model_id));
    let api = t.api.or(known.map(|m| m.api)).or(provider.and_then(|p| p.api)).unwrap_or(Api::OpenAICompletions);
    let base_url = if !t.base_url.is_empty() {
        t.base_url.to_string()
    } else {
        known.map(|m| m.base_url.clone()).or(provider.map(|p| p.base_url.clone())).unwrap_or_default()
    };
    let cost = meta
        .map(|m| m.cost.clone())
        .filter(|c| c.input > 0.0 || c.output > 0.0)
        .unwrap_or_else(|| crate::harness::pricing::model_cost_for(t.model_id));
    Model {
        id: t.model_id.to_string(),
        name: meta.map_or_else(|| t.model_id.to_string(), |m| m.name.clone()),
        api,
        provider: provider.map_or_else(|| t.provider.to_string(), |p| p.id.clone()),
        base_url: base_url.trim_end_matches('/').to_string(),
        reasoning: meta.map_or(false, |m| m.reasoning),
        thinking_level_map: None,
        input: if meta.map_or(true, |m| m.images) { vec![InputType::Text, InputType::Image] } else { vec![InputType::Text] },
        cost,
        prompt_cache: Some(true),
        context_window: meta.map_or(FALLBACK_CONTEXT, |m| m.context),
        max_tokens: meta.map_or(FALLBACK_OUTPUT, |m| m.output),
        headers: None,
        compat: None,
    }
}

// ---------------------------------------------------------------------------
// Global instance + refresh
// ---------------------------------------------------------------------------

static CACHE_PATH: OnceLock<PathBuf> = OnceLock::new();
static CURRENT: RwLock<Option<Arc<Catalog>>> = RwLock::new(None);

/// Where the refreshed copy is kept. Call once at startup; without it the
/// catalog stays on the embedded snapshot.
pub fn set_cache_path(path: PathBuf) {
    let _ = CACHE_PATH.set(path);
}

fn load_initial() -> Catalog {
    CACHE_PATH
        .get()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| Catalog::parse(&s))
        .unwrap_or_else(Catalog::embedded)
}

pub fn global() -> Arc<Catalog> {
    if let Some(c) = CURRENT.read().unwrap().as_ref() {
        return c.clone();
    }
    let mut w = CURRENT.write().unwrap();
    w.get_or_insert_with(|| Arc::new(load_initial())).clone()
}

fn is_stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| SystemTime::now().duration_since(t).unwrap_or_default() > MAX_AGE)
        .unwrap_or(true)
}

/// Fetch models.dev when the cached copy is older than a day. Failures keep
/// the current catalog. `ZWORK_DISABLE_MODELS_FETCH=1` pins the snapshot;
/// `ZWORK_MODELS_URL` points at a mirror.
pub async fn refresh_if_stale() {
    if std::env::var("ZWORK_DISABLE_MODELS_FETCH").map_or(false, |v| v == "1" || v == "true") {
        return;
    }
    let Some(path) = CACHE_PATH.get() else { return };
    if !is_stale(path) {
        return;
    }
    let url = std::env::var("ZWORK_MODELS_URL").unwrap_or_else(|_| SOURCE_URL.to_string());
    let body = async {
        let resp = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(super::transport::USER_AGENT)
            .build()
            .ok()?
            .get(&url)
            .send()
            .await
            .ok()?;
        resp.status().is_success().then_some(())?;
        resp.text().await.ok()
    }
    .await;
    let Some(body) = body else {
        tracing::debug!("models.dev refresh failed; keeping current catalog");
        return;
    };
    let Some(cat) = Catalog::parse(&body) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, &body);
    *CURRENT.write().unwrap() = Some(Arc::new(cat));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_snapshot_maps_core_providers() {
        let cat = Catalog::embedded();
        let api = |p: &str| cat.provider(p).and_then(|p| p.api);
        assert_eq!(api("anthropic"), Some(Api::AnthropicMessages));
        assert_eq!(api("openai"), Some(Api::OpenAIResponses));
        assert_eq!(api("google"), Some(Api::GoogleGenerativeAI));
        assert_eq!(api("openrouter"), Some(Api::OpenAICompletions));
        assert_eq!(api("groq"), Some(Api::OpenAICompletions));
        assert_eq!(api("amazon-bedrock"), None);
        assert_eq!(api("github-copilot"), None);
        assert_eq!(cat.provider("together").map(|p| p.id.as_str()), Some("togetherai"));
        assert!(cat.provider("ollama").unwrap().keyless);
        assert_eq!(cat.provider("azure").unwrap().vars, vec!["AZURE_RESOURCE_NAME".to_string()]);
        let supported = cat.providers().filter(|p| p.supported()).count();
        assert!(supported > 150, "only {supported} supported providers");
    }

    #[test]
    fn gateway_models_route_per_model() {
        let cat = Catalog::embedded();
        let zen = cat.provider("opencode").unwrap();
        let apis: std::collections::HashSet<Api> = zen.models.iter().map(|m| m.api).collect();
        assert!(apis.contains(&Api::AnthropicMessages) && apis.contains(&Api::OpenAIResponses));
        assert!(zen.models.iter().all(|m| m.base_url == "https://opencode.ai/zen/v1"));
    }

    #[test]
    fn build_model_uses_catalog_limits_and_falls_back() {
        let cat = Catalog::embedded();
        let anthropic = cat.provider("anthropic").unwrap();
        let known = anthropic.models.iter().find(|m| m.reasoning).unwrap();
        let m = build_model(&cat, Target { provider: "anthropic", model_id: &known.id, base_url: "", api: None });
        assert_eq!(m.api, Api::AnthropicMessages);
        assert_eq!(m.context_window, known.context);
        assert!(m.reasoning);
        assert_eq!(m.base_url, "https://api.anthropic.com");

        // Gateway id borrows first-party metadata.
        let routed = format!("anthropic/{}", known.id);
        let m = build_model(&cat, Target { provider: "some-proxy", model_id: &routed, base_url: "http://x/v1", api: None });
        assert_eq!(m.context_window, known.context);
        assert_eq!(m.api, Api::OpenAICompletions);

        let m = build_model(&cat, Target { provider: "ollama", model_id: "llama3.2", base_url: "", api: None });
        assert_eq!(m.base_url, "http://localhost:11434/v1");
        assert_eq!(m.context_window, FALLBACK_CONTEXT);
    }

    #[test]
    fn interpolation() {
        assert_eq!(template_vars("https://${A}.x/${B}"), vec!["A", "B"]);
        let s = interpolate("https://${A}.x/${B}", |v| (v == "A").then(|| "res".into()));
        assert_eq!(s, "https://res.x/${B}");
    }
}
