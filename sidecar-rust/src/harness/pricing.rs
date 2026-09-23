//! Per-model pricing for local cost accounting (`Usage::calculate_cost`).
//!
//! The zWork-hosted lineup mirrors the cloud API's `estimate_cost` table
//! exactly so dashboards agree. BYOK families carry their published list
//! prices (per 1M tokens) as a best-effort courtesy; anything unrecognized
//! stays zero-rated, which downstream surfaces as "cost unknown" rather
//! than "free".

use super::types::{ModelCost, ModelCostTier};

fn cost(input: f64, output: f64) -> ModelCost {
    ModelCost { input, output, ..Default::default() }
}

/// Anthropic-style cache economics: reads at 0.1× input, writes at 1.25×.
fn anthropic_cost(input: f64, output: f64) -> ModelCost {
    ModelCost {
        input,
        output,
        cache_read: input * 0.1,
        cache_write: input * 1.25,
        ..Default::default()
    }
}

/// Look up per-million pricing for a model id. Exact ids first, then family
/// keywords. Returns zero rates when pricing is unknown.
pub fn model_cost_for(model_id: &str) -> ModelCost {
    let id = model_id.to_ascii_lowercase();
    let bare = id.rsplit('/').next().unwrap_or(&id);

    // zWork-hosted lineup — keep in sync with cloud `estimate_cost`. The
    // OpenRouter-scoped ids carry their vendor prefix, so match those on the
    // full id before the bare DeepSeek-direct spellings.
    match id.as_str() {
        "deepseek/deepseek-v4-flash-0731" => return cost(0.04, 0.08),
        "deepseek/deepseek-v4.1-flash" => return cost(0.15, 0.60),
        "z-ai/glm-5.2" => return cost(1.25, 9.0),
        "z-ai/glm-5.3-flash" => return cost(0.09, 0.30),
        _ => {}
    }
    match bare {
        "deepseek-v4-pro" => return cost(1.74, 3.48),
        "deepseek-flash" | "deepseek-v4.1-flash" | "deepseek-v4-flash" => return cost(0.14, 0.28),
        _ => {}
    }

    // BYOK families, published list prices.
    if bare.contains("claude-opus") {
        anthropic_cost(15.0, 75.0)
    } else if bare.contains("claude-sonnet") {
        anthropic_cost(3.0, 15.0)
    } else if bare.contains("claude-haiku") {
        anthropic_cost(1.0, 5.0)
    } else if bare.starts_with("gpt-4.1-mini") {
        cost(0.4, 1.6)
    } else if bare.starts_with("gpt-4.1-nano") {
        cost(0.1, 0.4)
    } else if bare.starts_with("gpt-4.1") {
        cost(2.0, 8.0)
    } else if bare.starts_with("gpt-4o-mini") {
        cost(0.15, 0.6)
    } else if bare.starts_with("gpt-4o") {
        cost(2.5, 10.0)
    } else if bare.contains("o4-mini") {
        cost(1.1, 4.4)
    } else if bare == "o3" || bare.starts_with("o3-") {
        cost(2.0, 8.0)
    } else if bare.contains("deepseek-chat") || bare.contains("deepseek-v3") {
        // DeepSeek V3 list pricing includes cache-read at 0.07.
        ModelCost { input: 0.27, output: 1.10, cache_read: 0.07, ..Default::default() }
    } else if bare.contains("gemini-2.5-pro") {
        ModelCost {
            input: 1.25,
            output: 10.0,
            cache_read: 0.31,
            tiers: vec![ModelCostTier {
                input_tokens_above: 200_000,
                input: 2.50,
                output: 15.0,
                cache_read: 0.63,
                cache_write: 0.0,
            }],
            ..Default::default()
        }
    } else if bare.contains("gemini-2.5-flash") {
        ModelCost { input: 0.30, output: 2.50, cache_read: 0.075, ..Default::default() }
    } else if bare.contains("gemini-2.0-flash") {
        cost(0.10, 0.40)
    } else {
        ModelCost::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_lineup_matches_cloud_table() {
        assert_eq!(model_cost_for("deepseek-v4-pro").input, 1.74);
        assert_eq!(model_cost_for("deepseek-flash").output, 0.28);
        assert_eq!(model_cost_for("deepseek/deepseek-v4.1-flash").output, 0.60);
        // Bare legacy spelling stays on the DeepSeek-direct price.
        assert_eq!(model_cost_for("deepseek-v4.1-flash").output, 0.28);
        assert_eq!(model_cost_for("z-ai/glm-5.3-flash").output, 0.30);
        assert_eq!(model_cost_for("z-ai/glm-5.2").input, 1.25);
    }

    #[test]
    fn byok_families() {
        let opus = model_cost_for("claude-opus-4-5-20251101");
        assert_eq!((opus.input, opus.output), (15.0, 75.0));
        assert_eq!(opus.cache_read, 1.5);
        assert_eq!(opus.cache_write, 18.75);

        assert_eq!(model_cost_for("gpt-4.1-mini").output, 1.6);
        assert_eq!(model_cost_for("gpt-4o-mini").input, 0.15);
        let pro = model_cost_for("google/gemini-2.5-pro");
        assert_eq!(pro.tiers.len(), 1);
        assert_eq!(pro.tiers[0].input, 2.50);
    }

    #[test]
    fn unknown_models_are_zero_rated() {
        assert_eq!(model_cost_for("some-private-model"), ModelCost::default());
    }
}
