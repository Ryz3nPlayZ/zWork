//! Scripted stream + model helpers shared by harness tests (extracted from
//! the retired agent loop's test bench).

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::sync::mpsc;

use crate::harness::agent_types::{
    AgentToolResult, AgentToolUpdateCallback, StreamFn, ToolExecutionMode, ToolFuture,
};
use crate::harness::types::{
    now_ms, AbortSignal, Api, AssistantContent, AssistantMessage,
    AssistantMessageEvent, InputType, Model, ModelCost, StopReason, TextContent, ToolCall, Usage,
};


    pub fn model() -> crate::harness::types::Model {
        crate::harness::types::Model {
            id: "m".into(),
            name: "m".into(),
            api: Api::OpenAICompletions,
            provider: "p".into(),
            base_url: "https://x".into(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![InputType::Text],
            cost: ModelCost::default(),
            prompt_cache: None,
            context_window: 100_000,
            max_tokens: 1000,
            headers: None,
            compat: None,
        }
    }

    /// One scripted assistant response.
    #[derive(Clone)]
    pub enum Script {
        Text(String),
        ToolCalls(Vec<(String, String, serde_json::Value)>),
        Error(String),
        /// Tool calls with a `length` stop.
        TruncatedToolCalls(Vec<(String, String, serde_json::Value)>),
    }

    fn assistant(model: &crate::harness::types::Model, content: Vec<AssistantContent>, stop: StopReason, err: Option<String>) -> AssistantMessage {
        AssistantMessage {
            content,
            api: model.api,
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: stop,
            error_message: err,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: now_ms(),
        }
    }

    /// Stream function that plays `scripts` in order, recording each request.
    pub fn scripted_stream(scripts: Vec<Script>, requests: Arc<Mutex<Vec<crate::harness::types::TranscriptContext>>>) -> StreamFn {
        let scripts = Arc::new(Mutex::new(scripts.into_iter()));
        Arc::new(move |model, ctx, _opts| {
            requests.lock().unwrap().push(ctx);
            let script = scripts.lock().unwrap().next().unwrap_or(Script::Error("script exhausted".into()));
            let (tx, rx) = mpsc::channel(64);
            tokio::spawn(async move {
                let pending = AssistantMessage::pending(&model);
                let _ = tx.send(AssistantMessageEvent::Start { partial: pending.clone() }).await;
                let truncated = matches!(script, Script::TruncatedToolCalls(_));
                match script {
                    Script::Text(t) => {
                        let mut p = pending.clone();
                        p.content.push(AssistantContent::Text(TextContent { text: String::new(), text_signature: None }));
                        let _ = tx.send(AssistantMessageEvent::TextStart { content_index: 0, partial: p.clone() }).await;
                        if let AssistantContent::Text(b) = &mut p.content[0] {
                            b.text = t.clone();
                        }
                        let _ = tx.send(AssistantMessageEvent::TextDelta { content_index: 0, delta: t.clone(), partial: p.clone() }).await;
                        let _ = tx.send(AssistantMessageEvent::TextEnd { content_index: 0, content: t, partial: p.clone() }).await;
                        let msg = assistant(&model, p.content, StopReason::Stop, None);
                        let _ = tx.send(AssistantMessageEvent::Done { reason: StopReason::Stop, message: msg }).await;
                    }
                    Script::ToolCalls(calls) | Script::TruncatedToolCalls(calls) => {
                        let stop = if truncated { StopReason::Length } else { StopReason::ToolUse };
                        let content = calls
                            .into_iter()
                            .map(|(id, name, args)| {
                                AssistantContent::ToolCall(ToolCall { id, name, arguments: args, thought_signature: None, namespace: None })
                            })
                            .collect();
                        let msg = assistant(&model, content, stop, None);
                        let _ = tx.send(AssistantMessageEvent::Done { reason: stop, message: msg }).await;
                    }
                    Script::Error(e) => {
                        let msg = assistant(&model, vec![], StopReason::Error, Some(e));
                        let _ = tx.send(AssistantMessageEvent::Error { reason: StopReason::Error, error: msg }).await;
                    }
                }
            });
            rx
        })
    }

    /// Echo tool: returns its `text` argument, streams one update first.
    pub struct EchoTool {
        pub mode: Option<ToolExecutionMode>,
        pub fail: bool,
    }

    impl crate::harness::agent_types::AgentTool for EchoTool {
        fn name(&self) -> &str {
            "echo"
        }
        fn description(&self) -> &str {
            "Echo text"
        }
        fn parameters(&self) -> serde_json::Value {
            json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"]})
        }
        fn execution_mode(&self) -> Option<ToolExecutionMode> {
            self.mode
        }
        fn execute<'a>(
            &'a self,
            _id: &'a str,
            params: serde_json::Value,
            _signal: Option<&'a AbortSignal>,
            on_update: AgentToolUpdateCallback,
        ) -> ToolFuture<'a> {
            let fail = self.fail;
            Box::pin(async move {
                on_update(AgentToolResult::text("working"));
                tokio::task::yield_now().await;
                if fail {
                    return Err("echo failed".into());
                }
                Ok(AgentToolResult::text(params["text"].as_str().unwrap_or("").to_string()))
            })
        }
    }

/// Minimal placeholder model (`harness::agent::default_model` successor).
pub fn default_model() -> Model {
    Model {
        id: "unknown".into(),
        name: "unknown".into(),
        api: Api::OpenAICompletions,
        provider: "unknown".into(),
        base_url: String::new(),
        reasoning: false,
        thinking_level_map: None,
        input: vec![],
        cost: ModelCost::default(),
        prompt_cache: None,
        context_window: 0,
        max_tokens: 0,
        headers: None,
        compat: None,
    }
}
