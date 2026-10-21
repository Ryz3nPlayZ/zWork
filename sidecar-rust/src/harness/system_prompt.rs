//! Project instruction files (ZWORK.md, AGENTS.md, ...) as a prompt block.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextFile {
    pub path: String,
    pub content: String,
}

pub fn build_project_context(files: &[ContextFile]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let blocks: Vec<String> = files
        .iter()
        .map(|f| format!("<project_instructions path=\"{}\">\n{}\n</project_instructions>", f.path, f.content))
        .collect();
    Some(format!("Project-specific instructions and guidelines:\n\n{}", blocks.join("\n\n")))
}
