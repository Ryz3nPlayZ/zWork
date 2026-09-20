//! Stateful agent wrapper around the loop.
//!
//! Port of pi-mono `packages/agent/src/agent.ts`: owns the transcript,
//! model, tools and queues; runs one prompt at a time; reduces every loop
//! event into `AgentState` before fanning it out to subscribers in order.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::sync::watch;

use super::agent_loop::{run_agent_loop, run_agent_loop_continue};
use super::agent_types::{
    AgentContext, AgentEvent, AgentEventSink, AgentHooks, AgentLoopConfig, AgentMessage, AgentState, DynTool,
    MessageSource, NoHooks, QueueMode, StreamFn, ToolExecutionMode,
};
use super::transcript::{create_initial_system_message, get_current_system_message};
use super::types::{
    now_ms, AbortSignal, AssistantContent, AssistantMessage, ImageContent, Message, Model, StopReason, StreamOptions,
    SystemMessage, TextContent, ThinkingLevel, Usage, UserContent, UserMessage, UserMessageContent,
};

const ALREADY_ACTIVE: &str = "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.";

/// Event listener: awaited in subscription order for every event, with the
/// active run's abort signal.
pub type AgentListener = Arc<dyn Fn(AgentEvent, AbortSignal) -> BoxFuture<'static, ()> + Send + Sync>;

/// Bounded message queue used for steering and follow-ups.
#[derive(Debug, Default)]
pub struct PendingMessageQueue {
    mode: QueueMode,
    items: Vec<AgentMessage>,
}

impl PendingMessageQueue {
    pub fn new(mode: QueueMode) -> Self {
        Self { mode, items: Vec::new() }
    }

    pub fn enqueue(&mut self, message: AgentMessage) {
        self.items.push(message);
    }

    pub fn has_items(&self) -> bool {
        !self.items.is_empty()
    }

    /// Take the next batch: everything in `All` mode, one message otherwise.
    pub fn drain(&mut self) -> Vec<AgentMessage> {
        if self.items.is_empty() {
            return Vec::new();
        }
        match self.mode {
            QueueMode::All => std::mem::take(&mut self.items),
            QueueMode::OneAtATime => vec![self.items.remove(0)],
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }
}

/// Initial state for a new agent.
#[derive(Clone, Default)]
pub struct InitialState {
    pub system_prompt: Option<String>,
    pub model: Option<Model>,
    pub thinking_level: Option<ThinkingLevel>,
    pub tools: Vec<DynTool>,
    pub messages: Vec<AgentMessage>,
}

/// Construction options (`AgentOptions`).
#[derive(Clone)]
pub struct AgentOptions {
    pub initial_state: InitialState,
    pub hooks: Arc<dyn AgentHooks>,
    /// Provider stream; defaults to the built-in provider dispatch.
    pub stream_fn: Option<StreamFn>,
    pub on_payload: Option<Arc<dyn Fn(&Value) + Send + Sync>>,
    pub steering_mode: QueueMode,
    pub follow_up_mode: QueueMode,
    pub session_id: Option<String>,
    pub max_retries: Option<u32>,
    pub max_retry_delay_ms: Option<u64>,
    pub tool_execution: ToolExecutionMode,
    /// Static API key; `AgentHooks::get_api_key` takes precedence per request.
    pub api_key: Option<String>,
    pub cache_retention: Option<String>,
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            initial_state: InitialState::default(),
            hooks: Arc::new(NoHooks),
            stream_fn: None,
            on_payload: None,
            steering_mode: QueueMode::OneAtATime,
            follow_up_mode: QueueMode::OneAtATime,
            session_id: None,
            max_retries: None,
            max_retry_delay_ms: None,
            tool_execution: ToolExecutionMode::Parallel,
            api_key: None,
            cache_retention: None,
        }
    }
}

/// Placeholder model until the caller sets one (`DEFAULT_MODEL`).
pub fn default_model() -> Model {
    Model {
        id: "unknown".into(),
        name: "unknown".into(),
        api: super::types::Api::OpenAICompletions,
        provider: "unknown".into(),
        base_url: String::new(),
        reasoning: false,
        thinking_level_map: None,
        input: vec![super::types::InputType::Text],
        cost: Default::default(),
        prompt_cache: None,
        context_window: 128_000,
        max_tokens: 8192,
        headers: None,
        compat: None,
    }
}

/// Mutable configuration shared with the run.
struct Config {
    hooks: Arc<dyn AgentHooks>,
    stream_fn: StreamFn,
    on_payload: Option<Arc<dyn Fn(&Value) + Send + Sync>>,
    session_id: Option<String>,
    max_retries: Option<u32>,
    max_retry_delay_ms: Option<u64>,
    tool_execution: ToolExecutionMode,
    api_key: Option<String>,
    cache_retention: Option<String>,
}

pub struct Agent {
    state: Arc<Mutex<AgentState>>,
    config: Mutex<Config>,
    listeners: Arc<Mutex<Vec<(u64, AgentListener)>>>,
    next_listener_id: AtomicU64,
    steering: Arc<Mutex<PendingMessageQueue>>,
    follow_ups: Arc<Mutex<PendingMessageQueue>>,
    /// Abort signal of the active run, if any.
    active: Mutex<Option<AbortSignal>>,
    /// `true` while idle; `wait_for_idle` watches it.
    idle: watch::Sender<bool>,
    skip_initial_steering_poll: Arc<AtomicBool>,
}

impl Agent {
    pub fn new(options: AgentOptions) -> Self {
        let init = options.initial_state;
        let tools = init.tools;
        let mut messages = init.messages;
        let has_leading_system = messages.first().map_or(false, |m| m.is_system());
        if !has_leading_system {
            let decls: Vec<_> = tools.iter().map(|t| t.declaration()).collect();
            if let Some(sys) = create_initial_system_message(init.system_prompt.as_deref(), Some(&decls)) {
                messages.insert(0, sys.into());
            }
        }
        let state = AgentState {
            model: init.model.unwrap_or_else(default_model),
            thinking_level: init.thinking_level.unwrap_or(ThinkingLevel::Off),
            tools,
            messages,
            is_streaming: false,
            streaming_message: None,
            pending_tool_calls: HashSet::new(),
            error_message: None,
        };
        let (idle, _) = watch::channel(true);
        Self {
            state: Arc::new(Mutex::new(state)),
            config: Mutex::new(Config {
                hooks: options.hooks,
                stream_fn: options.stream_fn.unwrap_or_else(|| Arc::new(super::providers::stream)),
                on_payload: options.on_payload,
                session_id: options.session_id,
                max_retries: options.max_retries,
                max_retry_delay_ms: options.max_retry_delay_ms,
                tool_execution: options.tool_execution,
                api_key: options.api_key,
                cache_retention: options.cache_retention,
            }),
            listeners: Arc::new(Mutex::new(Vec::new())),
            next_listener_id: AtomicU64::new(1),
            steering: Arc::new(Mutex::new(PendingMessageQueue::new(options.steering_mode))),
            follow_ups: Arc::new(Mutex::new(PendingMessageQueue::new(options.follow_up_mode))),
            active: Mutex::new(None),
            idle,
            skip_initial_steering_poll: Arc::new(AtomicBool::new(false)),
        }
    }

    // ------------------------------------------------------------------
    // Subscriptions
    // ------------------------------------------------------------------

    /// Subscribe to events; returns an id for `unsubscribe`.
    pub fn subscribe(&self, listener: AgentListener) -> u64 {
        let id = self.next_listener_id.fetch_add(1, Ordering::SeqCst);
        self.listeners.lock().unwrap().push((id, listener));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.listeners.lock().unwrap().retain(|(i, _)| *i != id);
    }

    // ------------------------------------------------------------------
    // State access
    // ------------------------------------------------------------------

    /// Snapshot of the current state.
    pub fn state(&self) -> AgentState {
        self.state.lock().unwrap().clone()
    }

    /// Read the state without cloning the transcript.
    pub fn with_state<R>(&self, f: impl FnOnce(&AgentState) -> R) -> R {
        f(&self.state.lock().unwrap())
    }

    pub fn is_streaming(&self) -> bool {
        self.state.lock().unwrap().is_streaming
    }

    pub fn system_prompt(&self) -> String {
        self.state.lock().unwrap().system_prompt()
    }

    /// Set the system prompt. Updates the leading system message when there
    /// is one, otherwise inserts one.
    pub fn set_system_prompt(&self, prompt: impl Into<String>) {
        let prompt = prompt.into();
        let mut st = self.state.lock().unwrap();
        match st.messages.first_mut() {
            Some(AgentMessage::Llm(Message::System(sys))) => sys.content = prompt,
            _ => {
                let sys = if st.messages.is_empty() {
                    let decls: Vec<_> = st.tools.iter().map(|t| t.declaration()).collect();
                    create_initial_system_message(Some(&prompt), Some(&decls))
                } else {
                    create_initial_system_message(Some(&prompt), None)
                };
                if let Some(sys) = sys {
                    st.messages.insert(0, sys.into());
                }
            }
        }
    }

    pub fn model(&self) -> Model {
        self.state.lock().unwrap().model.clone()
    }

    pub fn set_model(&self, model: Model) {
        self.state.lock().unwrap().model = model;
    }

    pub fn thinking_level(&self) -> ThinkingLevel {
        self.state.lock().unwrap().thinking_level
    }

    pub fn set_thinking_level(&self, level: ThinkingLevel) {
        self.state.lock().unwrap().thinking_level = level;
    }

    pub fn tools(&self) -> Vec<DynTool> {
        self.state.lock().unwrap().tools.clone()
    }

    /// Replace the executable tool set. Declarations reach the model on the
    /// next request via the loop's tool-change system message.
    pub fn set_tools(&self, tools: Vec<DynTool>) {
        self.state.lock().unwrap().tools = tools;
    }

    pub fn messages(&self) -> Vec<AgentMessage> {
        self.state.lock().unwrap().messages.clone()
    }

    pub fn append_message(&self, message: AgentMessage) {
        self.state.lock().unwrap().messages.push(message);
    }

    pub fn replace_messages(&self, messages: Vec<AgentMessage>) {
        self.state.lock().unwrap().messages = messages;
    }

    pub fn set_api_key(&self, api_key: Option<String>) {
        self.config.lock().unwrap().api_key = api_key;
    }

    pub fn set_hooks(&self, hooks: Arc<dyn AgentHooks>) {
        self.config.lock().unwrap().hooks = hooks;
    }

    pub fn set_stream_fn(&self, stream_fn: StreamFn) {
        self.config.lock().unwrap().stream_fn = stream_fn;
    }

    pub fn set_session_id(&self, session_id: Option<String>) {
        self.config.lock().unwrap().session_id = session_id;
    }

    // ------------------------------------------------------------------
    // Queues
    // ------------------------------------------------------------------

    /// Queue a message delivered after the current tool batch, before the
    /// next request.
    pub fn steer(&self, message: AgentMessage) {
        self.steering.lock().unwrap().enqueue(message);
    }

    /// Queue a message delivered once the agent would otherwise stop.
    pub fn follow_up(&self, message: AgentMessage) {
        self.follow_ups.lock().unwrap().enqueue(message);
    }

    pub fn clear_steering_queue(&self) {
        self.steering.lock().unwrap().clear();
    }

    pub fn clear_follow_up_queue(&self) {
        self.follow_ups.lock().unwrap().clear();
    }

    pub fn clear_all_queues(&self) {
        self.clear_steering_queue();
        self.clear_follow_up_queue();
    }

    pub fn has_queued_messages(&self) -> bool {
        self.steering.lock().unwrap().has_items() || self.follow_ups.lock().unwrap().has_items()
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /// Abort signal of the active run, if any.
    pub fn signal(&self) -> Option<AbortSignal> {
        self.active.lock().unwrap().clone()
    }

    /// Abort the active run. No-op when idle.
    pub fn abort(&self) {
        if let Some(sig) = self.active.lock().unwrap().as_ref() {
            sig.abort();
        }
    }

    /// Resolve once no run is active.
    pub async fn wait_for_idle(&self) {
        let mut rx = self.idle.subscribe();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// Clear the transcript down to a single system message replaying the
    /// current prompt and tool declarations. Errors while a run is active.
    pub fn reset(&self) -> Result<(), String> {
        if self.active.lock().unwrap().is_some() {
            return Err("Cannot reset while a prompt is being processed. Call abort() first.".into());
        }
        let mut st = self.state.lock().unwrap();
        let llm: Vec<Message> = st.messages.iter().filter_map(|m| m.as_llm().cloned()).collect();
        st.messages = get_current_system_message(&llm).map(|s| vec![s.into()]).unwrap_or_default();
        st.streaming_message = None;
        st.pending_tool_calls.clear();
        st.error_message = None;
        drop(st);
        self.clear_all_queues();
        Ok(())
    }

    /// Send a prompt and run until the agent stops. Errors immediately if a
    /// run is active; otherwise resolves when the run finishes.
    pub async fn prompt(&self, input: impl Into<PromptInput>) -> Result<(), String> {
        let messages = input.into().into_messages();
        self.run_prompt_messages(messages, false).await
    }

    /// Continue from the current transcript without a new prompt. Used to
    /// retry after an error or abort. Queued messages are run as prompts.
    pub async fn continue_run(&self) -> Result<(), String> {
        if self.active.lock().unwrap().is_some() {
            return Err(ALREADY_ACTIVE.into());
        }
        let last_is_assistant = self.state.lock().unwrap().messages.last().map_or(false, |m| m.is_assistant());
        if last_is_assistant {
            let steering = self.steering.lock().unwrap().drain();
            if !steering.is_empty() {
                return self.run_prompt_messages(steering, true).await;
            }
            let follow_ups = self.follow_ups.lock().unwrap().drain();
            if !follow_ups.is_empty() {
                return self.run_prompt_messages(follow_ups, false).await;
            }
            return Err("Cannot continue from message role: assistant".into());
        }
        self.run_with_lifecycle(|ctx, cfg, emit, sig, sf| {
            Box::pin(async move { run_agent_loop_continue(ctx, cfg, emit, Some(sig), sf).await.map(|_| ()) })
        })
        .await
    }

    async fn run_prompt_messages(&self, messages: Vec<AgentMessage>, skip_initial_steering_poll: bool) -> Result<(), String> {
        if self.active.lock().unwrap().is_some() {
            return Err(ALREADY_ACTIVE.into());
        }
        self.skip_initial_steering_poll.store(skip_initial_steering_poll, Ordering::SeqCst);
        self.run_with_lifecycle(move |ctx, cfg, emit, sig, sf| {
            Box::pin(async move {
                run_agent_loop(messages, ctx, cfg, emit, Some(sig), sf).await;
                Ok(())
            })
        })
        .await
    }

    /// Build the loop config from the current state and options.
    fn create_loop_config(&self) -> AgentLoopConfig {
        let cfg = self.config.lock().unwrap();
        let st = self.state.lock().unwrap();
        let mut stream_options = StreamOptions {
            api_key: cfg.api_key.clone(),
            reasoning: if st.thinking_level == ThinkingLevel::Off { None } else { Some(st.thinking_level) },
            session_id: cfg.session_id.clone(),
            cache_retention: cfg.cache_retention.clone(),
            on_payload: cfg.on_payload.clone(),
            ..StreamOptions::default()
        };
        if let Some(r) = cfg.max_retries {
            stream_options.max_retries = r;
        }
        if let Some(d) = cfg.max_retry_delay_ms {
            stream_options.max_retry_delay_ms = Some(d);
        }

        let steering = self.steering.clone();
        let skip = self.skip_initial_steering_poll.clone();
        let get_steering: MessageSource = Arc::new(move || {
            // The first poll after `continue()` drained steering already.
            if skip.swap(false, Ordering::SeqCst) {
                return Box::pin(async { Vec::new() });
            }
            let drained = steering.lock().unwrap().drain();
            Box::pin(async move { drained })
        });
        let follow_ups = self.follow_ups.clone();
        let get_follow_ups: MessageSource = Arc::new(move || {
            let drained = follow_ups.lock().unwrap().drain();
            Box::pin(async move { drained })
        });

        AgentLoopConfig {
            model: st.model.clone(),
            stream_options,
            tool_execution: cfg.tool_execution,
            hooks: cfg.hooks.clone(),
            get_steering_messages: Some(get_steering),
            get_follow_up_messages: Some(get_follow_ups),
        }
    }

    async fn run_with_lifecycle<F>(&self, runner: F) -> Result<(), String>
    where
        F: FnOnce(AgentContext, AgentLoopConfig, AgentEventSink, AbortSignal, StreamFn) -> BoxFuture<'static, Result<(), String>>,
    {
        let signal = AbortSignal::new();
        {
            let mut active = self.active.lock().unwrap();
            if active.is_some() {
                return Err(ALREADY_ACTIVE.into());
            }
            *active = Some(signal.clone());
        }
        let _ = self.idle.send(false);
        {
            let mut st = self.state.lock().unwrap();
            st.is_streaming = true;
            st.streaming_message = None;
            st.error_message = None;
        }

        let context = {
            let st = self.state.lock().unwrap();
            AgentContext { messages: st.messages.clone(), tools: st.tools.clone() }
        };
        let config = self.create_loop_config();
        let stream_fn = self.config.lock().unwrap().stream_fn.clone();
        let emit = self.event_sink(signal.clone());

        let result = runner(context, config, emit.clone(), signal.clone(), stream_fn).await;
        if let Err(e) = &result {
            self.handle_run_failure(e, &signal, &emit).await;
        }
        self.finish_run();
        result
    }

    /// Synthesize a terminal assistant message so the transcript ends in a
    /// consistent state after a run that failed outside the loop.
    async fn handle_run_failure(&self, error: &str, signal: &AbortSignal, emit: &AgentEventSink) {
        let model = self.state.lock().unwrap().model.clone();
        let aborted = signal.is_aborted();
        let message = AssistantMessage {
            content: vec![AssistantContent::Text(TextContent { text: String::new(), text_signature: None })],
            api: model.api,
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: if aborted { StopReason::Aborted } else { StopReason::Error },
            error_message: Some(if aborted { "Request was aborted".to_string() } else { error.to_string() }),
            raw_stop_reason: None,
            end_turn: None,
            timestamp: now_ms(),
        };
        let am: AgentMessage = message.into();
        emit(AgentEvent::MessageStart { message: am.clone() }).await;
        emit(AgentEvent::MessageEnd { message: am.clone() }).await;
        emit(AgentEvent::TurnEnd { message: am, tool_results: Vec::new() }).await;
        let messages = self.state.lock().unwrap().messages.clone();
        emit(AgentEvent::AgentEnd { messages }).await;
    }

    fn finish_run(&self) {
        {
            let mut st = self.state.lock().unwrap();
            st.is_streaming = false;
            st.streaming_message = None;
            st.pending_tool_calls.clear();
        }
        *self.active.lock().unwrap() = None;
        let _ = self.idle.send(true);
    }

    /// Sink that reduces each event into state, then awaits listeners.
    fn event_sink(&self, signal: AbortSignal) -> AgentEventSink {
        let state = self.state.clone();
        let listeners = self.listeners.clone();
        Arc::new(move |event: AgentEvent| {
            let state = state.clone();
            let listeners = listeners.clone();
            let signal = signal.clone();
            Box::pin(async move {
                {
                    let mut st = state.lock().unwrap();
                    apply_event(&mut st, &event);
                }
                let snapshot: Vec<AgentListener> = listeners.lock().unwrap().iter().map(|(_, l)| l.clone()).collect();
                for l in snapshot {
                    l(event.clone(), signal.clone()).await;
                }
            })
        })
    }
}

/// Reduce one event into state (`processEvents`).
fn apply_event(st: &mut AgentState, event: &AgentEvent) {
    match event {
        AgentEvent::MessageStart { message } | AgentEvent::MessageUpdate { message, .. } => {
            st.streaming_message = Some(message.clone());
        }
        AgentEvent::MessageEnd { message } => {
            st.streaming_message = None;
            st.messages.push(message.clone());
        }
        AgentEvent::ToolExecutionStart { tool_call_id, .. } => {
            st.pending_tool_calls.insert(tool_call_id.clone());
        }
        AgentEvent::ToolExecutionEnd { tool_call_id, .. } => {
            st.pending_tool_calls.remove(tool_call_id);
        }
        AgentEvent::TurnEnd { message, .. } => {
            st.error_message = message.as_assistant().and_then(|a| a.error_message.clone());
        }
        AgentEvent::AgentEnd { .. } => {
            st.streaming_message = None;
        }
        _ => {}
    }
}

/// Accepted inputs for `prompt`.
pub enum PromptInput {
    Text(String),
    TextWithImages(String, Vec<ImageContent>),
    Message(AgentMessage),
    Messages(Vec<AgentMessage>),
}

impl PromptInput {
    fn into_messages(self) -> Vec<AgentMessage> {
        match self {
            PromptInput::Text(text) => vec![AgentMessage::user_text(text)],
            PromptInput::TextWithImages(text, images) => {
                if images.is_empty() {
                    return vec![AgentMessage::user_text(text)];
                }
                let mut blocks = vec![UserContent::text(text)];
                blocks.extend(images.into_iter().map(UserContent::Image));
                vec![Message::User(UserMessage { content: UserMessageContent::Blocks(blocks), timestamp: now_ms() }).into()]
            }
            PromptInput::Message(m) => vec![m],
            PromptInput::Messages(ms) => ms,
        }
    }
}

impl From<&str> for PromptInput {
    fn from(s: &str) -> Self {
        PromptInput::Text(s.to_string())
    }
}

impl From<String> for PromptInput {
    fn from(s: String) -> Self {
        PromptInput::Text(s)
    }
}

impl From<AgentMessage> for PromptInput {
    fn from(m: AgentMessage) -> Self {
        PromptInput::Message(m)
    }
}

impl From<Vec<AgentMessage>> for PromptInput {
    fn from(ms: Vec<AgentMessage>) -> Self {
        PromptInput::Messages(ms)
    }
}

impl From<SystemMessage> for PromptInput {
    fn from(s: SystemMessage) -> Self {
        PromptInput::Message(s.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::agent_loop::test_support::{model, scripted_stream, EchoTool, Script};
    use crate::harness::agent_types::AgentTool;
    use serde_json::json;

    fn agent(scripts: Vec<Script>, tools: Vec<DynTool>) -> (Agent, Arc<Mutex<Vec<crate::harness::types::TranscriptContext>>>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let a = Agent::new(AgentOptions {
            initial_state: InitialState {
                system_prompt: Some("You are helpful.".into()),
                model: Some(model()),
                tools,
                ..Default::default()
            },
            stream_fn: Some(scripted_stream(scripts, requests.clone())),
            ..Default::default()
        });
        (a, requests)
    }

    #[tokio::test]
    async fn initial_system_message_declares_tools() {
        let (a, _) = agent(vec![], vec![Arc::new(EchoTool { mode: None, fail: false })]);
        let msgs = a.messages();
        assert_eq!(msgs.len(), 1);
        let sys = msgs[0].as_system().unwrap();
        assert_eq!(sys.content, "You are helpful.");
        assert_eq!(sys.tools_added.as_ref().unwrap()[0].name, "echo");
        assert_eq!(a.system_prompt(), "You are helpful.");
    }

    #[tokio::test]
    async fn prompt_runs_and_updates_state() {
        let (a, requests) = agent(vec![Script::Text("hi there".into())], vec![]);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        a.subscribe(Arc::new(move |ev, _sig| {
            s2.lock().unwrap().push(ev.kind());
            Box::pin(async {})
        }));
        a.prompt("hello").await.unwrap();
        let st = a.state();
        assert!(!st.is_streaming);
        assert!(st.streaming_message.is_none());
        assert_eq!(st.messages.len(), 3); // system, user, assistant
        assert_eq!(st.messages[2].as_assistant().unwrap().text(), "hi there");
        assert_eq!(st.error_message, None);
        assert_eq!(seen.lock().unwrap().first().copied(), Some("agent_start"));
        assert_eq!(seen.lock().unwrap().last().copied(), Some("agent_end"));
        // System prompt reached the provider.
        let req = &requests.lock().unwrap()[0];
        assert!(matches!(&req.messages[0], Message::System(s) if s.content == "You are helpful."));
    }

    #[tokio::test]
    async fn prompt_rejects_while_active() {
        let (a, _) = agent(vec![Script::Text("a".into())], vec![]);
        let a = Arc::new(a);
        // Gate the run inside a listener so it is observably active.
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let rx = Arc::new(Mutex::new(Some(rx)));
        a.subscribe(Arc::new(move |ev, _| {
            let rx = rx.clone();
            Box::pin(async move {
                if matches!(ev, AgentEvent::AgentStart) {
                    let taken = rx.lock().unwrap().take();
                    if let Some(rx) = taken {
                        let _ = rx.await;
                    }
                }
            })
        }));
        let a2 = a.clone();
        let run = tokio::spawn(async move { a2.prompt("x").await });
        tokio::task::yield_now().await;
        while !a.is_streaming() {
            tokio::task::yield_now().await;
        }
        let err = a.prompt("y").await.unwrap_err();
        assert!(err.contains("already processing"));
        assert!(a.reset().is_err());
        let _ = tx.send(());
        run.await.unwrap().unwrap();
        a.wait_for_idle().await;
        assert!(!a.is_streaming());
    }

    #[tokio::test]
    async fn steering_is_delivered_after_tool_batch() {
        let (a, requests) = agent(
            vec![
                Script::ToolCalls(vec![("a".into(), "echo".into(), json!({"text":"x"}))]),
                Script::Text("ok".into()),
            ],
            vec![Arc::new(EchoTool { mode: None, fail: false })],
        );
        a.steer(AgentMessage::user_text("steer me"));
        a.prompt("go").await.unwrap();
        // Steering queued before the run is picked up on the first poll.
        let first = &requests.lock().unwrap()[0];
        assert!(first.messages.iter().any(|m| matches!(m, Message::User(u) if u.content.text() == "steer me")));
        assert!(!a.has_queued_messages());
    }

    #[tokio::test]
    async fn follow_up_runs_after_stop() {
        let (a, requests) = agent(vec![Script::Text("a".into()), Script::Text("b".into())], vec![]);
        a.follow_up(AgentMessage::user_text("and then"));
        a.prompt("go").await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        assert_eq!(a.messages().len(), 5);
    }

    #[tokio::test]
    async fn error_run_records_error_message() {
        let (a, _) = agent(vec![Script::Error("boom".into())], vec![]);
        a.prompt("go").await.unwrap();
        assert_eq!(a.state().error_message.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn continue_after_assistant_without_queue_errors() {
        let (a, _) = agent(vec![Script::Text("a".into())], vec![]);
        a.prompt("go").await.unwrap();
        let err = a.continue_run().await.unwrap_err();
        assert!(err.contains("assistant"));
    }

    #[tokio::test]
    async fn continue_after_assistant_drains_follow_up() {
        let (a, requests) = agent(vec![Script::Text("a".into()), Script::Text("b".into())], vec![]);
        a.prompt("go").await.unwrap();
        a.follow_up(AgentMessage::user_text("again"));
        a.continue_run().await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn continue_from_user_tail() {
        let (a, requests) = agent(vec![Script::Text("a".into())], vec![]);
        a.append_message(AgentMessage::user_text("hello"));
        a.continue_run().await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(a.messages().len(), 3);
    }

    #[tokio::test]
    async fn reset_keeps_collapsed_system_message() {
        let (a, _) = agent(vec![Script::Text("a".into())], vec![Arc::new(EchoTool { mode: None, fail: false })]);
        a.prompt("go").await.unwrap();
        assert_eq!(a.messages().len(), 3);
        a.reset().unwrap();
        let msgs = a.messages();
        assert_eq!(msgs.len(), 1);
        let sys = msgs[0].as_system().unwrap();
        assert_eq!(sys.content, "You are helpful.");
        assert_eq!(sys.tools_added.as_ref().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn set_tools_declares_change_on_next_request() {
        let (a, requests) = agent(vec![Script::Text("a".into())], vec![]);
        a.set_tools(vec![Arc::new(EchoTool { mode: None, fail: false })]);
        a.prompt("go").await.unwrap();
        let req = &requests.lock().unwrap()[0];
        let tools = crate::harness::transcript::get_current_tools(&req.messages);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, EchoTool { mode: None, fail: false }.declaration().name);
    }

    #[tokio::test]
    async fn set_system_prompt_updates_leading_message() {
        let (a, _) = agent(vec![], vec![]);
        a.set_system_prompt("New prompt");
        assert_eq!(a.system_prompt(), "New prompt");
        let fresh = Agent::new(AgentOptions { stream_fn: Some(scripted_stream(vec![], Default::default())), ..Default::default() });
        assert!(fresh.messages().is_empty());
        fresh.set_system_prompt("Hi");
        assert_eq!(fresh.messages().len(), 1);
        assert_eq!(fresh.system_prompt(), "Hi");
    }

    #[tokio::test]
    async fn abort_marks_run_aborted() {
        // Stream that never finishes until aborted.
        let stream: StreamFn = Arc::new(|model, _ctx, opts| {
            let (tx, rx) = tokio::sync::mpsc::channel(8);
            tokio::spawn(async move {
                let pending = AssistantMessage::pending(&model);
                let _ = tx.send(crate::harness::types::AssistantMessageEvent::Start { partial: pending.clone() }).await;
                if let Some(sig) = opts.signal {
                    sig.cancelled().await;
                }
                let mut m = pending;
                m.stop_reason = StopReason::Aborted;
                m.error_message = Some("Request was aborted".into());
                let _ = tx
                    .send(crate::harness::types::AssistantMessageEvent::Error { reason: StopReason::Aborted, error: m })
                    .await;
            });
            rx
        });
        let a = Arc::new(Agent::new(AgentOptions {
            initial_state: InitialState { model: Some(model()), ..Default::default() },
            stream_fn: Some(stream),
            ..Default::default()
        }));
        let a2 = a.clone();
        let run = tokio::spawn(async move { a2.prompt("x").await });
        while a.state().streaming_message.is_none() {
            tokio::task::yield_now().await;
        }
        a.abort();
        run.await.unwrap().unwrap();
        let st = a.state();
        assert_eq!(st.messages.last().unwrap().as_assistant().unwrap().stop_reason, StopReason::Aborted);
        assert_eq!(st.error_message.as_deref(), Some("Request was aborted"));
        assert!(a.signal().is_none());
    }
}
