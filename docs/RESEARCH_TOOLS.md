# Research Tools Reference

zWork ships a suite of academic research tools that enable the agent to go from a raw research idea to a finished paper draft in a single session.

All tools are defined in [`sidecar/agent/tools.py`](../sidecar/agent/tools.py) and follow the standard generator-based tool handler pattern (yielding `status`, `activity`, and `tool_result` events).

---

## `detect_hardware`

**Purpose:** Profile the local compute environment so the agent can reason about what experiments are feasible.

**Schema:**

```json
{
  "name": "detect_hardware",
  "description": "Detect and report on local hardware capabilities...",
  "input_schema": {
    "type": "object",
    "properties": {}
  }
}
```

**Returns:** A structured report including:

| Field | Description |
|-------|-------------|
| `platform` | OS name and version |
| `cpu` | CPU model and core count |
| `ram_gb` | Total system RAM in GB |
| `gpu` | GPU name (if detected) or `"No GPU detected"` |
| `vram_gb` | GPU VRAM in GB (if available) |
| `python_version` | Running Python interpreter version |
| `cuda_available` | Whether CUDA is available via PyTorch |
| `cuda_version` | CUDA runtime version (if available) |

**Usage note:** This tool does not require any arguments. It runs synchronously using `platform`, `subprocess`, and optional `torch` introspection.

---

## `check_novelty`

**Purpose:** Validate a research idea against existing academic literature before drafting begins.

**Schema:**

```json
{
  "name": "check_novelty",
  "description": "Search academic databases for papers related to a research idea...",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Research idea or hypothesis to check" },
      "max_results": { "type": "integer", "description": "Max papers to return (default 5)" }
    },
    "required": ["query"]
  }
}
```

**Data sources:** Queries [Semantic Scholar](https://api.semanticscholar.org/) and [arXiv](https://arxiv.org/search/) in parallel.

**Returns:** A list of the top matching papers, each with:

| Field | Description |
|-------|-------------|
| `title` | Paper title |
| `authors` | Author list |
| `year` | Publication year |
| `abstract` | Paper abstract excerpt |
| `url` | Link to the paper |

**Failure mode:** If external APIs are unavailable the tool returns an empty results list and a warning message rather than raising an error.

---

## `write_research_paper`

**Purpose:** Draft a complete academic paper section by section, from abstract through conclusion.

**Schema:**

```json
{
  "name": "write_research_paper",
  "description": "Write a complete academic research paper from an idea...",
  "input_schema": {
    "type": "object",
    "properties": {
      "topic": { "type": "string", "description": "Research topic or thesis" },
      "sections": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional list of sections to include"
      },
      "style": { "type": "string", "description": "Writing style: 'academic', 'technical', 'survey'" },
      "word_count": { "type": "integer", "description": "Target word count per section" }
    },
    "required": ["topic"]
  }
}
```

**Pipeline stages:**

1. Outline generation
2. Section-by-section drafting (Abstract → Introduction → Related Work → Methodology → Results → Conclusion)
3. Assembly into a single coherent Markdown document

**Default sections:** `abstract`, `introduction`, `related_work`, `methodology`, `results`, `conclusion`

**Default style:** `academic`

**Output:** A complete Markdown paper saved to a local artifact. The tool streams progress events for each section as it is drafted.

---

## `review_paper`

**Purpose:** Audit a paper draft for quality, citation coverage, structural completeness, and writing clarity.

**Schema:**

```json
{
  "name": "review_paper",
  "description": "Review and critique a research paper draft...",
  "input_schema": {
    "type": "object",
    "properties": {
      "paper_content": { "type": "string", "description": "The paper text to review" },
      "review_type": { "type": "string", "description": "Type of review: 'peer_review', 'technical', 'editorial'" }
    },
    "required": ["paper_content"]
  }
}
```

**Review dimensions:**

| Dimension | What is checked |
|-----------|----------------|
| Structure | Presence and ordering of standard sections |
| Citations | Placeholder detection; citation density estimate |
| Clarity | Sentence complexity, passive voice ratio |
| Completeness | Whether all requested sections were produced |
| Length | Word count vs. typical conference paper targets |

**Default review type:** `peer_review`

**Output:** A structured feedback report in Markdown with an overall quality score (0–10), a findings list, and actionable recommendations.

---

## Self-healing command diagnostics

The `run_command` tool incorporates `_diagnose_command_failure` to automatically classify and explain command errors. When a command exits non-zero:

1. The exit code and stderr are captured.
2. `_diagnose_command_failure` is called to identify the failure category (`permission_denied`, `not_found`, `oom`, `timeout`, `generic`).
3. A human-readable diagnosis is appended to the tool result so the agent can propose a corrective action without user intervention.

---

## Integration pattern

Research tools follow the standard zWork generator pattern:

```python
async def _handle_research_tool(tool_input: dict, ...) -> AsyncGenerator:
    yield {"type": "status", "status": "running", "message": "..."}
    yield {"type": "activity", "activity": {...}}
    # ... do work ...
    yield {"type": "tool_result", "content": result}
```

All tools are registered in `TOOL_SCHEMAS` and dispatched through `execute_tool` in `sidecar/agent/tools.py`.
