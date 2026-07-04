//! Per-turn orientation block ("turn-context"), ported from Goose's `moim`.
//!
//! Frontier harnesses inject a small, volatile block of operational facts
//! (current time, working directory, git state, remaining turn budget) into
//! the *latest user message* each turn, rather than into the cached system
//! prompt. This keeps the system prompt stable for prompt caching while still
//! giving the model fresh "where am I / how much runway is left" signal.
//!
//! The block is tagged so the model knows it's operational context, not part
//! of the user's request — and the turn-budget field doubles as a behavioral
//! lever: as the budget depletes, the directive (lives in the system prompt)
//! tells the model to become more direct and focus on finishing.

use chrono::Local;

/// Only surface the turn-budget once the agent is past the halfway mark.
/// Below that, the budget is generous and showing it just adds noise; above
/// it, "become more direct" is the useful signal.
fn turn_budget_line(turn: u32, max_turns: u32) -> Option<String> {
    if max_turns == 0 {
        return None;
    }
    if turn.saturating_mul(2) < max_turns {
        return None;
    }
    Some(format!("<turn-budget>{} / {} turns used</turn-budget>", turn, max_turns))
}

/// Best-effort `git status -sb` for the current working directory. Cached per
/// process; never blocks the turn if git is absent or the dir isn't a repo.
fn git_state_line(cwd: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["-C", cwd, "status", "-sb"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout);
    let branch = s
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("## "))
        .and_then(|l| l.split("...").next())
        .unwrap_or("(unknown)");
    // "dirty" if any tracked line beyond the branch header exists.
    let dirty = s.lines().skip(1).any(|l| !l.trim().is_empty());
    let state = if dirty { "dirty" } else { "clean" };
    Some(format!("<git>branch: {} ({})</git>", branch, state))
}

/// Build the full `<turn-context>` block to prepend to the latest user message.
///
/// - `turn`: 1-indexed current turn number.
/// - `max_turns`: hard runaway cap (0 = unbounded → no budget line shown).
/// - `cwd`: working directory (best-effort; "(unknown)" if unset).
pub fn turn_context_block(turn: u32, max_turns: u32, cwd: &str) -> String {
    let now = Local::now().format("%Y-%m-%d %H:%M:00").to_string();
    let cwd_line = format!(
        "<working-directory>{}</working-directory>",
        if cwd.is_empty() { "(unknown)" } else { cwd }
    );
    let git_line = git_state_line(cwd)
        .unwrap_or_else(|| "<git>not a git repository</git>".to_string());
    let budget_line = turn_budget_line(turn, max_turns);

    let mut block = String::from("<turn-context>\n");
    block.push_str(&format!("<current-time>{}</current-time>\n", now));
    block.push_str(&cwd_line);
    block.push('\n');
    block.push_str(&git_line);
    block.push('\n');
    if let Some(b) = budget_line {
        block.push_str(&b);
        block.push('\n');
    }
    block.push_str("</turn-context>");
    block
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_hidden_below_halfway() {
        assert!(turn_budget_line(1, 80).is_none());
        assert!(turn_budget_line(39, 80).is_none());
    }

    #[test]
    fn budget_shown_at_or_past_halfway() {
        assert_eq!(
            turn_budget_line(40, 80).as_deref(),
            Some("<turn-budget>40 / 80 turns used</turn-budget>")
        );
        assert_eq!(
            turn_budget_line(75, 80).as_deref(),
            Some("<turn-budget>75 / 80 turns used</turn-budget>")
        );
    }

    #[test]
    fn budget_never_shown_when_unbounded() {
        assert!(turn_budget_line(999, 0).is_none());
    }

    #[test]
    fn block_includes_core_fields() {
        let block = turn_context_block(50, 80, "/tmp");
        assert!(block.starts_with("<turn-context>"));
        assert!(block.contains("<current-time>"));
        assert!(block.contains("<working-directory>/tmp</working-directory>"));
        assert!(block.contains("<git>"));
        assert!(block.contains("<turn-budget>50 / 80 turns used</turn-budget>"));
        assert!(block.ends_with("</turn-context>"));
    }

    #[test]
    fn block_without_budget_when_early() {
        let block = turn_context_block(1, 80, "/tmp");
        assert!(!block.contains("<turn-budget>"));
    }
}
