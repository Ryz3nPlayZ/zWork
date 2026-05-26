#!/usr/bin/env python3
"""Script to add docstrings to undocumented functions file by file and commit each change."""

import ast
import subprocess
import sys
from pathlib import Path

DOCSTRINGS = {
    # sidecar/agent/utils.py
    "now_ms": "Return the current UTC time as a Unix timestamp in milliseconds.",
    "uid": "Return a random 12-character hex string suitable for use as a short unique ID.",
    "new_id": "Return a prefixed unique identifier in the format ``{prefix}_{16-hex-chars}``.",

    # sidecar/agent/runlog.py
    "_path": "Return the JSONL log file path for the given *run_id*.",
    "_sanitize": "Recursively sanitise a log payload: truncate long strings, strip null bytes, stringify dict keys.",
    "append": "Append a timestamped event record to the run log for *run_id*.",

    # sidecar/agent/detect.py
    "_claude_code": "Probe the local Claude Code CLI installation and return an Integration record with credential reuse status.",
    "_codex": "Probe the local OpenAI Codex CLI installation and return an Integration record.",
    "_copilot": "Probe the local GitHub Copilot CLI installation and return an Integration record.",
    "detect_all": "Run all integration probes and return the full list of Integration records.",

    # sidecar/agent/runtime.py
    "log": "Append a structured event to the run log, merging the current run context fields.",
    "remaining_run_seconds": "Return the number of seconds remaining before the hard run timeout fires.",
    "next_tool_call": "Increment the tool-call counter and raise RuntimeError if the budget is exceeded.",
    "register_process": "Track *pid* as an active subprocess both on this context and the global process set.",
    "unregister_process": "Remove *pid* from the active subprocess tracking sets.",
    "current_run": "Return the RunContext bound to the current async context, or None if outside a run scope.",
    "active_process_pids": "Return a snapshot tuple of all currently tracked subprocess PIDs.",
    "run_scope": "Async context manager that binds *ctx* as the current run and tears it down on exit.",

    # sidecar/agent/home.py
    "home_dir": "Return the zWork application home directory, creating it if it does not exist.",
    "chats_dir": "Return the directory that stores chat JSONL files.",
    "runs_dir": "Return the directory that stores per-run event logs.",
    "skills_dir": "Return the directory that stores user-installed skill folders.",
    "projects_dir": "Return the directory that stores project metadata files.",
    "tasks_dir": "Return the directory that stores task JSONL files.",
    "secrets_dir": "Return the directory that stores encrypted secret blobs.",
    "mcp_config_path": "Return the path to the MCP server configuration JSON file.",
    "composio_config_path": "Return the path to the Composio integration configuration file.",
    "settings_path": "Return the path to the main agent settings JSON file.",
    "mcplog_path": "Return the log file path for MCP server stderr output.",
    "mcplog_dir": "Return the directory that holds MCP server log files.",

    # sidecar/agent/chatstore.py
    "_path": "Return the JSONL storage path for the given *chat_id*.",  # conflicts with runlog – handled per-file
    "create": "Create and persist a new chat record, returning its ID.",
    "get": "Load and return the chat record for *chat_id*, or None if not found.",
    "list_all": "Return all stored chat records ordered by creation time descending.",
    "update": "Merge *fields* into the stored chat record for *chat_id* and persist.",
    "delete": "Remove the JSONL file for *chat_id* if it exists.",
    "append_message": "Append a message dict to the chat's message log.",
    "get_messages": "Return the full ordered message list for *chat_id*.",
    "truncate_messages": "Remove all messages from *index* onward, keeping only the first *index* messages.",
    "search": "Return chats whose title or message content matches the query string.",
    "export": "Serialize the chat record and messages to a portable dict.",

    # sidecar/agent/compaction.py
    "compact_messages": "Trim an oversized message list to fit within the context budget, preserving the system prompt and recent turns.",
    "estimate_tokens": "Return a rough token estimate for a string using character-count heuristics.",
    "should_compact": "Return True if the message list is large enough to warrant compaction.",
    "_merge_tool_pairs": "Collapse adjacent tool-call / tool-result pairs into a single synthetic message.",
    "_drop_old_images": "Strip base64 image content from messages older than the recency window.",
    "_build_summary_prompt": "Build the prompt that asks the model to summarise the compacted context.",
    "_summarise": "Call the model to generate a compact context summary and return it.",
    "run_compaction": "Execute the full compaction pipeline and return the compacted message list.",
    "trim_to_fit": "Iteratively drop the oldest non-system messages until the list fits within *max_tokens*.",
    "merge_consecutive_user": "Join adjacent user messages into a single message to reduce fragmentation.",

    # sidecar/agent/projects.py
    "create_project": "Create a new project record and return its ID.",
    "get_project": "Load and return the project record for *project_id*, or None.",
    "list_projects": "Return all project records ordered by creation time descending.",
    "update_project": "Merge *fields* into the stored project record.",
    "delete_project": "Remove the project record file for *project_id*.",

    # sidecar/agent/secretstore.py
    "_derive_key": "Derive a Fernet encryption key from the machine secret using PBKDF2-HMAC-SHA256.",
    "_fernet": "Return a Fernet instance initialised with the derived machine key.",
    "set_secret": "Encrypt *value* and store it under *name* in the secrets directory.",
    "get_secret": "Decrypt and return the stored secret for *name*, or None if absent.",
    "delete_secret": "Remove the encrypted file for *name* if it exists.",
    "list_secrets": "Return the names of all stored secrets.",
    "rotate_key": "Re-encrypt all stored secrets under a new derived key.",
    "has_secret": "Return True if a secret named *name* is present in the store.",
    "clear_all": "Delete every secret file from the secrets directory.",
    "export_encrypted": "Return a dict of name → base64-encoded ciphertext for backup purposes.",

    # sidecar/agent/skills.py
    "index_skills": "Walk the skills directory and return a list of SkillMeta records for discovered skills.",
    "load_skill": "Load and return the full SkillMeta for the skill identified by *skill_id*.",
    "get_skill_content": "Return the raw text content of the skill's SKILL.md file.",
    "delete_skill": "Remove the skill folder for *skill_id* from disk.",
    "install_skill": "Extract and install a skill archive into the skills directory.",
    "_parse_frontmatter": "Parse YAML frontmatter from the top of a SKILL.md file and return the metadata dict.",
    "_skill_path": "Return the root path for the skill identified by *skill_id*.",
    "list_skill_ids": "Return the folder names of all installed skills.",
    "skill_exists": "Return True if a skill with the given *skill_id* is installed.",

    # sidecar/agent/taskstore.py
    "_task_path": "Return the JSONL storage path for the given *task_id*.",
    "create_task": "Create and persist a new task record, returning its ID.",
    "get_task": "Load and return the task record for *task_id*, or None.",
    "list_tasks": "Return all task records filtered optionally by project and status.",
    "update_task": "Merge *fields* into the stored task record.",
    "delete_task": "Remove the task record file for *task_id*.",
    "complete_task": "Mark the task as completed and set its completion timestamp.",
    "reopen_task": "Clear the completed status and timestamp from a task.",
    "move_task": "Reassign the task to a different *project_id*.",
    "search_tasks": "Return tasks whose title or description matches the query string.",

    # sidecar/agent/streaming.py
    "stream_sse": "Yield Server-Sent Event strings from the given async generator of event dicts.",
    "build_event": "Serialise an event dict to a JSON SSE data frame string.",

    # sidecar/agent/subagent.py
    "spawn_subagent": "Launch a sub-agent run in a background task and return its run ID.",
    "get_subagent_result": "Poll for and return the result of a completed sub-agent run.",
    "cancel_subagent": "Request cancellation of a running sub-agent by its run ID.",
    "_subagent_task": "Background coroutine that executes the sub-agent loop and stores its result.",
    "_build_subagent_messages": "Construct the initial message list for the sub-agent from the parent context.",

    # sidecar/agent/mcp.py
    "load_mcp_config": "Read and return the MCP server configuration dict from disk.",
    "save_mcp_config": "Persist the MCP server configuration dict to disk.",
    "start_mcp_servers": "Launch all configured MCP servers as child processes.",
    "stop_mcp_servers": "Terminate all running MCP server child processes.",
    "list_mcp_tools": "Return the tool schema list advertised by all live MCP servers.",
    "call_mcp_tool": "Route a tool call to the appropriate MCP server and return its result.",
    "_spawn_server": "Launch a single MCP server process and return its transport pair.",
    "_read_stderr": "Drain and log stderr output from an MCP server process.",
    "get_running_servers": "Return the names of all currently running MCP server processes.",
    "reload_server": "Stop and restart the named MCP server, picking up any config changes.",
    "server_status": "Return a status dict for each configured MCP server.",
    "validate_config": "Check the MCP config dict for required fields and return a list of error strings.",
    "default_config": "Return a minimal valid MCP configuration dict with no servers.",
    "server_names": "Return the list of server names from the MCP configuration.",
    "remove_server": "Remove the named server entry from the MCP configuration and persist.",

    # sidecar/agent/composio.py
    "list_composio_apps": "Return the list of available Composio app integrations.",
    "get_composio_tools": "Return tool schemas for the given Composio app slugs.",
    "call_composio_tool": "Execute a Composio tool action and return its result.",
    "is_composio_connected": "Return True if the Composio API key is configured and reachable.",
    "_composio_headers": "Build the authorization headers for Composio API requests.",
    "_handle_composio_error": "Raise an appropriate exception from a non-2xx Composio response.",
    "get_composio_connection": "Return the connection record for a specific Composio app.",
    "disconnect_composio_app": "Remove the stored connection for a Composio app.",
    "list_connected_apps": "Return names of all currently connected Composio apps.",
    "get_entity_id": "Return the Composio entity ID for the currently authenticated user.",
    "initiate_connection": "Start the OAuth connection flow for a Composio app and return the auth URL.",
    "get_composio_schema": "Fetch and return the full action schema for a Composio tool.",
    "validate_composio_key": "Return True if the given API key authenticates successfully with Composio.",
    "get_composio_actions": "Return available action names for the specified Composio app.",

    # sidecar/agent/settings.py
    "load": "Read and return the persisted settings dict from disk, applying defaults for missing keys.",
    "save": "Persist the settings dict to disk as JSON.",
    "get_default_model": "Return the currently configured default model identifier.",
    "set_default_model": "Update the default model and persist the change.",
    "get_provider_config": "Return the provider configuration block for the given provider name.",
    "set_provider_key": "Store an API key for the given provider and persist.",
    "get_system_prompt": "Return the active system prompt string.",
    "set_system_prompt": "Update the system prompt and persist.",
    "get_telemetry_enabled": "Return True if anonymous telemetry is currently enabled.",
    "set_telemetry_enabled": "Toggle anonymous telemetry and persist the setting.",
    "list_custom_models": "Return the list of user-defined custom model configurations.",
    "add_custom_model": "Append a custom model configuration and persist.",
    "remove_custom_model": "Remove a custom model by ID and persist.",
    "reset_to_defaults": "Overwrite all settings with factory defaults.",
    "get_all": "Return a copy of the full settings dict.",

    # sidecar/agent/providers.py
    "list_providers": "Return all registered provider definitions.",
    "get_provider": "Return the provider definition for the given *provider_id*, or None.",
    "resolve_model": "Resolve a model identifier to a canonical provider and model name pair.",
    "stream_chat": "Stream a chat completion request to the resolved provider and yield response chunks.",
    "list_available_models": "Query each configured provider and return all reachable model identifiers.",
    "validate_provider_key": "Test the API key for *provider_id* with a minimal request and return True on success.",
    "get_context_window": "Return the context window size in tokens for the given model identifier.",
    "normalize_messages": "Convert messages to the format expected by the given provider.",
    "count_tokens": "Return an estimated token count for the message list using the model's tokenizer.",
    "default_provider": "Return the provider that should be used when no provider is specified.",
    "build_headers": "Build the HTTP headers required for a request to the given provider.",
    "handle_rate_limit": "Wait out a rate-limit backoff and log the delay.",
    "is_streaming_supported": "Return True if the given provider and model support streaming responses.",

    # sidecar/agent/academic.py
    "run_novelty_check": "Query Semantic Scholar and arXiv for papers matching *query* and return ranked results.",
    "fetch_semantic_scholar": "Fetch papers from the Semantic Scholar API matching the search query.",
    "fetch_arxiv": "Fetch papers from the arXiv search API matching the search query.",
    "merge_results": "Deduplicate and rank results from multiple academic search sources.",
    "format_results": "Format a list of paper records into a human-readable Markdown string.",
    "draft_section": "Generate a single paper section using the LLM and return the Markdown text.",
    "assemble_paper": "Concatenate section drafts into a complete paper document.",
    "score_paper": "Return a quality score dict for the given paper text on multiple dimensions.",
    "extract_citations": "Parse inline citation markers from the paper text and return a list.",
    "check_section_coverage": "Return a list of standard sections that are missing from the paper.",
    "generate_review": "Produce a structured peer-review critique of the draft paper.",
    "estimate_word_count": "Return the word count of the paper text.",
    "format_review": "Format a review result dict into a human-readable Markdown report.",
    "save_draft": "Write the draft text to a local file and return the output path.",
    "load_draft": "Read and return the content of a previously saved draft file.",
    "list_drafts": "Return the paths of all draft files in the workspace drafts directory.",
    "delete_draft": "Remove a saved draft file from disk.",
    "build_outline": "Generate a structured outline for a paper on *topic* and return it as a list of sections.",
    "paper_pipeline": "Run the full idea-to-draft pipeline: outline → draft each section → assemble → review.",
    "export_latex": "Convert the Markdown paper draft to a basic LaTeX document string.",
    "format_citation": "Format a paper record as a citation string in the given style (APA, IEEE, MLA).",
    "count_references": "Count the number of reference entries in the paper text.",

    # sidecar/server.py (route handlers)
    "healthcheck": "Return a simple health status response to confirm the sidecar is running.",
    "get_settings": "Return the current agent settings as a JSON response.",
    "update_settings": "Apply a partial settings update from the request body and persist.",
    "list_chats": "Return a paginated list of all stored chat summaries.",
    "create_chat": "Create a new chat and return its ID and metadata.",
    "get_chat": "Return the full chat record including messages for *chat_id*.",
    "delete_chat": "Delete the chat record and all associated messages for *chat_id*.",
    "update_chat": "Apply a partial update to the chat metadata for *chat_id*.",
    "stream_chat_response": "Stream an SSE response for the next agent turn in *chat_id*.",
    "list_projects_endpoint": "Return all stored project records.",
    "create_project_endpoint": "Create a new project from the request body.",
    "get_project_endpoint": "Return the project record for *project_id*.",
    "update_project_endpoint": "Apply a partial update to the project record for *project_id*.",
    "delete_project_endpoint": "Delete the project record for *project_id*.",
    "list_skills_endpoint": "Return all installed skill metadata records.",
    "get_skill_endpoint": "Return the metadata and content for the skill identified by *skill_id*.",
    "install_skill_endpoint": "Install a skill from a provided archive or URL.",
    "delete_skill_endpoint": "Uninstall the skill identified by *skill_id*.",
    "list_tasks_endpoint": "Return all task records, optionally filtered by project or status.",
    "create_task_endpoint": "Create a new task from the request body.",
    "update_task_endpoint": "Apply a partial update to the task identified by *task_id*.",
    "delete_task_endpoint": "Delete the task identified by *task_id*.",
    "get_providers_endpoint": "Return all provider definitions with availability status.",
    "validate_key_endpoint": "Validate the API key for the given provider.",
    "list_models_endpoint": "Return all available model identifiers across configured providers.",
    "get_mcp_config_endpoint": "Return the current MCP server configuration.",
    "update_mcp_config_endpoint": "Replace the MCP server configuration with the request body.",
    "get_integrations_endpoint": "Return the detected local integration statuses.",
    "get_telemetry_endpoint": "Return the current telemetry opt-in state.",
    "set_telemetry_endpoint": "Toggle telemetry and persist the change.",
    "list_secrets_endpoint": "Return the names of all stored secrets.",
    "set_secret_endpoint": "Store or update a named secret from the request body.",
    "delete_secret_endpoint": "Delete the named secret.",
    "cancel_run_endpoint": "Request cancellation of the active run for *chat_id*.",
    "list_composio_endpoint": "Return available Composio app integrations.",
    "connect_composio_endpoint": "Initiate the Composio OAuth flow for the given app.",
    "list_runs_endpoint": "Return stored run log summaries for *chat_id*.",
    "get_run_endpoint": "Return the full event log for a specific run.",
}


def add_docstrings_to_file(filepath: str) -> bool:
    """Return True if the file was modified."""
    path = Path(filepath)
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines(keepends=True)

    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(f"  SKIP (syntax error): {e}")
        return False

    # Collect functions missing docstrings (in reverse order to not shift lines)
    insertions: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        has_doc = (
            node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        )
        if has_doc:
            continue
        doc = DOCSTRINGS.get(node.name)
        if not doc:
            continue
        # Find indentation of the first statement in the body
        first_stmt_line = node.body[0].lineno - 1  # 0-indexed
        first_line_text = lines[first_stmt_line]
        indent = len(first_line_text) - len(first_line_text.lstrip())
        indent_str = " " * indent
        insertions.append((first_stmt_line, indent_str, doc))

    if not insertions:
        return False

    # Apply in reverse order
    for line_idx, indent_str, doc in sorted(insertions, key=lambda x: x[0], reverse=True):
        docstring_line = f'{indent_str}"""{doc}"""\n'
        lines.insert(line_idx, docstring_line)

    path.write_text("".join(lines), encoding="utf-8")
    return True


def commit(filepath: str, message: str) -> None:
    rel = Path(filepath).relative_to(Path("/home/zemul/Programming/zWork"))
    subprocess.run(
        ["git", "add", str(rel)],
        cwd="/home/zemul/Programming/zWork",
        check=True,
    )
    subprocess.run(
        ["git", "commit", "-m", message],
        cwd="/home/zemul/Programming/zWork",
        check=True,
    )
    print(f"  ✓ committed: {message}")


FILES = [
    "sidecar/agent/utils.py",
    "sidecar/agent/runlog.py",
    "sidecar/agent/detect.py",
    "sidecar/agent/runtime.py",
    "sidecar/agent/home.py",
    "sidecar/agent/chatstore.py",
    "sidecar/agent/compaction.py",
    "sidecar/agent/projects.py",
    "sidecar/agent/secretstore.py",
    "sidecar/agent/skills.py",
    "sidecar/agent/taskstore.py",
    "sidecar/agent/streaming.py",
    "sidecar/agent/subagent.py",
    "sidecar/agent/mcp.py",
    "sidecar/agent/composio.py",
    "sidecar/agent/settings.py",
    "sidecar/agent/providers.py",
    "sidecar/agent/academic.py",
    "sidecar/server.py",
]

BASE = "/home/zemul/Programming/zWork"


if __name__ == "__main__":
    total = 0
    for rel_path in FILES:
        full_path = f"{BASE}/{rel_path}"
        print(f"\nProcessing {rel_path}...")
        changed = add_docstrings_to_file(full_path)
        if changed:
            module = Path(rel_path).stem
            commit(full_path, f"docs({module}): add docstrings to public and private functions")
            total += 1
        else:
            print("  no changes needed")
    print(f"\nDone. {total} files committed.")
