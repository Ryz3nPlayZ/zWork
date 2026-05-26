# zWork Technical Roadmap

*This document focuses on implementation priorities and technical milestones. For product direction, see [ROADMAP.md](ROADMAP.md).*

---

## Shipped: Academic Research Pipeline (Q2 2026)

**Goal:** Enable end-to-end paper generation — from idea to finished draft — using AutoResearchClaw-inspired tooling.

### Research Tools (Completed)
- [x] `detect_hardware` — profile local GPU/CPU, VRAM, OS, Python version
- [x] `check_novelty` — semantic search via Semantic Scholar and arXiv APIs
- [x] `write_research_paper` — multi-stage section drafting (abstract → intro → methods → results → conclusion)
- [x] `review_paper` — quality audit for structure, citations, and completeness
- [x] `_diagnose_command_failure` — self-healing diagnostics in `run_command`

### Success criteria
- Agent can produce a full draft paper from a single research idea prompt
- Novelty check surfaces relevant prior work before drafting begins
- Review tool provides actionable feedback on draft quality

---

## Q2 2026: Artifact Foundation

**Goal:** Establish the storage and data model for persistent work artifacts.

### Week 1-2: Storage Layer
- [ ] SQLite artifact store with foreign-key relationships
- [ ] Content-addressed blob storage for file attachments
- [ ] Backup and export functionality
- [ ] Migration framework for schema evolution

### Week 3-4: Data Model
- [ ] Artifact types: document, spreadsheet, chart, task, note
- [ ] Version history with branching
- [ ] Tag and folder organization
- [ ] Search index integration

### Success criteria
- Can create, retrieve, update, and delete artifacts
- Artifacts survive app restart
- Export produces human-readable formats

---

## Q3 2026: Native Editors

**Goal:** Build inline editors for core artifact types.

### Document Editor
- [ ] Rich text with Markdown support
- [ ] Collaborative editing lock semantics
- [ ] Auto-save with conflict resolution
- [ ] Export to .docx and .pdf

### Spreadsheet Editor
- [ ] Formula evaluation engine
- [ ] Cell references and ranges
- [ ] Import/export .xlsx and .csv
- [ ] Chart generation from data

### Success criteria
- Create and edit docs without leaving the app
- Formulas calculate correctly
- Files work in Excel/Google Sheets

---

## Q4 2026: Agent Enhancements

**Goal:** Improve agent capabilities for artifact creation.

### Tool Expansion
- [x] Self-healing command failure diagnostics (`_diagnose_command_failure`)
- [ ] Web scraping with content extraction
- [ ] Email API integration (IMAP/SMTP)
- [ ] Calendar API integration
- [ ] Notion/Slack webhooks

### Quality Improvements
- [ ] Streaming tool call progress
- [ ] Automatic recovery from failures
- [ ] Context-aware retry policies
- [ ] Tool usage analytics

### Success criteria
- Agents complete multi-step tasks reliably
- Progress is visible throughout
- Failure recovery is automatic

---

## Q1 2027: Platform Features

**Goal:** Power-user features and enterprise readiness.

### Workflow Builder
- [ ] Visual workflow editor
- [ ] Template library
- [ ] Scheduled execution
- [ ] Webhook triggers

### Team Features
- [ ] Shared artifact spaces
- [ ] Role-based permissions
- [ ] Audit logging
- [ ] SSO integration

### Success criteria
- Teams can collaborate on artifacts
- Workflows run without supervision
- Enterprise compliance requirements met

---

## Technical Debt Track

Ongoing maintenance items prioritized alongside feature work.

### Performance
- [ ] Profile and optimize streaming latency
- [ ] Reduce memory footprint for large chats
- [ ] Index optimization for artifact search

### Reliability
- [ ] Comprehensive error boundaries
- [ ] Crash reporting integration
- [ ] E2E test coverage expansion
- [ ] Load testing for cloud API

### Security
- [ ] Secret rotation automation
- [ ] Dependency scanning
- [ ] Penetration testing
- [ ] Security audit completion

---

## Infrastructure Milestones

| Milestone | Target | Description |
|-----------|--------|-------------|
| Multi-region deployment | Q3 2026 | Cloud API deployed to 3+ regions |
| 99.9% uptime SLA | Q4 2026 | Formal uptime commitment with credits |
| SOC 2 compliance | Q2 2027 | Security audit and certification |
| Self-hosted option | Q3 2027 | On-prem deployment for enterprise |

---

*This roadmap is a living document. Priorities may shift based on user feedback and technical discovery.*
