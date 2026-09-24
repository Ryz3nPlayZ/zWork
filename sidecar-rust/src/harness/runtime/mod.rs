//! Port of pi `harness/runtime/` + `execution/` — the crash-safe operation
//! runtime (M4 of the parity plan; see `../SPEC.md` §runtime and the
//! vendored tool/assistant durability specs).
//!
//! Core idea: every repeatable external effect (provider request, tool
//! call) is wrapped in intent commit → effect → settlement commit. After
//! every durable transition the complete operation state is rewritten to
//! `pi.op.state`; recovery never replays a journal — it reads one total
//! state and jumps to the responsible procedure.

pub mod effect_gate;
pub mod types;
