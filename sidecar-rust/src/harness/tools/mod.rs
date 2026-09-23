//! Port of pi's core coding tools (`core/tools/*`): read, write, edit,
//! bash, grep, find, ls, plus the shared truncation / path / walking
//! infrastructure they build on. grep and find use a native walker
//! instead of shelling out to rg/fd so zWork ships no extra binaries.

pub mod bash;
pub mod edit;
pub mod edit_diff;
pub mod file_mutation_queue;
pub mod find;
pub mod grep;
pub mod image;
pub mod ls;
pub mod output_accumulator;
pub mod path_utils;
pub mod read;
pub mod truncate;
pub mod walk;
pub mod write;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use crate::harness::agent_types::DynTool;

pub use bash::BashTool;
pub use edit::EditTool;
pub use find::FindTool;
pub use grep::GrepTool;
pub use ls::LsTool;
pub use read::{ReadTool, SupportsImagesFn};
pub use write::WriteTool;

/// Build the default coding tool set for `cwd` in pi's canonical order.
pub fn create_coding_tools(cwd: &Path, supports_images: Option<SupportsImagesFn>) -> Vec<DynTool> {
    vec![
        Arc::new(ReadTool::new(cwd, supports_images)),
        Arc::new(BashTool::new(cwd)),
        Arc::new(EditTool::new(cwd)),
        Arc::new(WriteTool::new(cwd)),
        Arc::new(GrepTool::new(cwd)),
        Arc::new(FindTool::new(cwd)),
        Arc::new(LsTool::new(cwd)),
    ]
}

/// Collect `prompt_snippet` / `prompt_guidelines` from tools for
/// [`crate::harness::system_prompt::BuildSystemPromptOptions`].
pub fn collect_prompt_contributions(tools: &[DynTool]) -> (HashMap<String, String>, HashMap<String, Vec<String>>) {
    let mut snippets = HashMap::new();
    let mut guidelines = HashMap::new();
    for t in tools {
        if let Some(s) = t.prompt_snippet() {
            snippets.insert(t.name().to_string(), s.to_string());
        }
        let g = t.prompt_guidelines();
        if !g.is_empty() {
            guidelines.insert(t.name().to_string(), g);
        }
    }
    (snippets, guidelines)
}
