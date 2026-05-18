---
name: academic-research
description: Use this skill when the user asks to find academic papers, do a literature review, search scholarly sources, write a research paper, find scientific references, or cite academic work. Covers the full workflow: searching multiple academic databases, ranking and deduplicating results, formatting citations, and synthesizing findings into structured documents.
---

# Academic Research Guide

## Overview

This skill turns zWork into a capable research assistant. It covers:

1. Searching academic databases for papers
2. Presenting results clearly to the user
3. Formatting citations in APA/MLA/Chicago
4. Synthesizing findings into structured literature reviews

## When to use this skill

Load this skill whenever the user mentions:
- "find papers on...", "search the literature...", "what does the research say..."
- "literature review", "academic sources", "scholarly articles"
- "cite this", "format this as a citation", "references"
- "write a research paper", "summarize the research on..."
- Any request that involves scientific, medical, or academic knowledge beyond general web search

## Core workflow

### Step 1: Understand the research question

Before searching, clarify with the user (only if truly ambiguous):
- Any time period constraints? (e.g. "last 5 years")
- Any field/domain preference? (e.g. "computer science only")
- How many papers do they need?

Do NOT ask these unless the user's request is genuinely ambiguous. Default to recent papers (last 5 years) unless the user says otherwise.

### Step 2: Search

Call `search_papers` with the user's query. Use `year_min` to filter for recency.

```
search_papers(query="transformer attention mechanisms", max_results=10, year_min=2020)
```

The tool searches OpenAlex, arXiv, Crossref, and Semantic Scholar in parallel and returns ranked, deduplicated results.

### Step 3: Present results

Present papers as a numbered list with key information. For each paper include:
- Title (bold)
- Authors
- Year
- Citation count (if available)
- DOI link (if available)
- Brief abstract snippet (1-2 lines)
- PDF availability note

Format example:
```
Here are the top papers on transformer attention mechanisms:

1. **Attention Is All You Need**
   Vaswani et al. (2017) — 95,000+ citations
   https://doi.org/10.48550/arXiv.1706.03762
   *The dominant sequence transduction models are based on complex recurrent or
   convolutional neural networks...*
   📄 PDF available

2. ...
```

### Step 4: Let the user choose next steps

After presenting results, ask what they want to do:
- "Would you like me to dive deeper into any of these?"
- "Should I format citations for specific papers?"
- "Want me to write a structured literature review from these?"

### Step 5a: Format citations

When the user asks for citations, call `format_citation` for each paper:

```
format_citation(paper={...}, style="apa")
```

You can format multiple papers at once by calling the tool multiple times. Present all formatted citations together.

### Step 5b: Write a literature review

When the user asks for a literature review:

1. Call `search_papers` with a focused query and higher `max_results` (20-30)
2. Read through the abstracts and organize papers by theme
3. Write a structured review document using the sidebar artifact block:
   - **Introduction**: scope and research question
   - **Key Themes**: 2-4 thematic sections with paper summaries
   - **Gaps & Future Work**: what's missing
   - **References**: full APA-formatted citation list

Use the sidebar artifact for the review document:
```
[[ARTIFACT kind=doc title="Literature Review: ..."]]
# Literature Review: [Topic]

## Introduction
...

## Key Themes
### Theme 1: ...
- Paper A (Author, Year): summary...
- Paper B (Author, Year): summary...

## References
1. Formatted citation...
2. Formatted citation...
[[/ARTIFACT]]
```

### Step 5c: Save for later

If the user wants to keep the search results, save them to a markdown file in the workspace outputs directory. Use `write_file` to create a well-formatted reference document.

## Citation formatting rules

- Use APA 7th edition by default unless the user specifies MLA or Chicago
- Always include DOI links as clickable URLs
- For papers with no DOI, use the source URL instead
- For arXiv papers, include the arXiv ID: `arXiv:1706.03762`
- When authors are missing, use "Anonymous" for APA or omit for MLA

## Important constraints

- NEVER fabricate papers, authors, DOIs, or citation counts. Only report what the APIs return.
- NEVER claim a paper says something unless the abstract confirms it.
- If search returns poor results, try rephrasing the query rather than making up results.
- Semantic Scholar may be unavailable (rate limited). That's fine — OpenAlex, arXiv, and Crossref provide excellent coverage.
- Always note which source each paper came from when there are conflicts or the user asks.

## Multi-source coverage

The `search_papers` tool queries four sources in parallel. Understanding their strengths helps you interpret results:

| Source | Strength | Weakness |
|--------|----------|----------|
| OpenAlex | Medicine, public health, sociology, economics | Smaller CS/engineering coverage |
| arXiv | Physics, math, CS preprints | Preprints only, not peer-reviewed |
| Crossref | Broadest coverage, best journal metadata | Slower, less structured abstracts |
| Semantic Scholar | CS, ML, biomed | May be rate-limited |

If results seem thin, suggest the user narrow or broaden their query rather than concluding there's no research on the topic.
