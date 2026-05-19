# Voice Mode — Technical Specification

**Status:** Planned (future roadmap)
**Stack:** Groq Whisper (STT) + Kokoro TTS (local)

## Architecture

```
[User speaks]
    ↓
[Mic capture (Tauri frontend, Web Audio API)]
    ↓
[Voice Activity Detection (VAD) — detect speech start/stop]
    ↓
[Audio chunks (3-5s) → Groq Whisper API (whisper-large-v3-turbo)]
    ↓
[Transcribed text → Existing sidecar chat pipeline]
    ↓
[LLM response (streaming)]
    ↓
[Text split into sentences → Kokoro TTS (local, ONNX runtime)]
    ↓
[Audio chunks played sequentially → speaker output]
```

## STT: Groq Whisper

- **Model:** `whisper-large-v3-turbo`
- **Endpoint:** `POST https://api.groq.com/openai/v1/audio/transcriptions`
- **API Key:** Set via `GROQ_API_KEY` environment variable
- **Protocol:** OpenAI-compatible multipart form-data
- **Cost:** $0.04 per audio hour
- **Speed:** 216x real-time (1 hour audio → ~1.7s processing)
- **Rate limits:** 20 RPM, 7200 audio-sec/hour
- **Supported formats:** flac, mp3, mp4, m4a, ogg, wav, webm
- **Max file size:** 25 MB
- **No streaming:** Full audio → full transcript. Client-side chunking required for real-time feel.
- **Languages:** Multilingual. Set `language: "en"` for best speed/accuracy.

### Client-side audio pipeline

```
1. Capture mic audio via Web Audio API (16kHz mono)
2. Buffer into 3-5 second chunks with ~500ms overlap
3. Send each chunk to Groq Whisper API
4. Concatenate transcripts, detect sentence boundaries
5. When VAD detects silence (>1.5s), flush accumulated text as user message
```

## TTS: Kokoro (Local)

- **Model:** Kokoro 82M (StyleTTS 2 + ISTFTNet architecture)
- **Package:** `kokoro-onnx` (MIT license, ONNX runtime)
- **Model size:** ~80MB quantized, ~300MB full
- **Output:** 24kHz WAV audio
- **Latency:** Near real-time on modern CPU (M1+ or equivalent)
- **No streaming:** Split LLM output into sentences, generate audio per sentence, pipeline playback.
- **Default voice:** `af_heart` (Grade A, American English female)
- **54 voices** across 9 languages (EN, JP, ZH, ES, FR, HI, IT, PT)

### Installation

```bash
pip install kokoro-onnx soundfile
# Download model files:
# kokoro-v1.0.onnx (~300MB) or quantized (~80MB)
# voices-v1.0.bin
```

### Usage

```python
from kokoro_onnx import Kokoro
import soundfile as sf

kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
samples, sample_rate = kokoro.create(
    "Hello, this is zWork speaking.",
    voice="af_heart",
    speed=1.0,
    lang="en-us"
)
# samples: numpy array at 24000 Hz
```

## Implementation Plan

### Phase 1: Backend (sidecar)

1. Add `sidecar/agent/voice.py` — STT/TTS orchestration
2. Add endpoints to `sidecar/server.py`:
   - `POST /api/voice/stt` — accept audio blob, return transcript
   - `POST /api/voice/tts` — accept text, return audio WAV
   - `GET /api/voice/status` — check if voice mode is available
3. Add dependencies to `pyproject.toml`: `groq`, `kokoro-onnx`, `soundfile`
4. Store dedicated Groq API key in settings/env

### Phase 2: Frontend (app)

1. Mic permission handling (Tauri + browser APIs)
2. Push-to-talk button in chat UI
3. Audio capture and chunking pipeline (Web Audio API + AudioWorklet)
4. VAD (Voice Activity Detection) — use Web Audio API analyser node or `@ricky0123/vad`
5. Audio playback queue for TTS responses
6. Visual feedback: waveform animation, speaking indicator

### Phase 3: Integration

1. Wire STT output into existing chat/send pipeline
2. Wire LLM streaming output into TTS sentence pipeline
3. Handle interruptions (user starts speaking while AI is responding)
4. Add voice settings panel (voice selection, speed, language)

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| STT provider | Groq Whisper | Cheapest ($0.04/hr), fastest (216x RT), OpenAI-compatible |
| TTS provider | Kokoro (local) | Free, private, no latency from network, small model |
| Audio capture | Web Audio API | Works in Tauri webview, no native plugin needed |
| VAD | Client-side analyser | Detect silence to know when user stopped speaking |
| Streaming STT | Chunked batching | Groq doesn't support streaming, so send short overlapping chunks |
| Streaming TTS | Sentence pipelining | Generate audio per sentence while next sentence generates |

## Estimated Costs

- STT: ~$0.04/hour of user speech. Average user speaks ~30 min/day = ~$0.02/day = ~$0.60/month
- TTS: $0 (runs locally on user's machine)
- Total per user: under $1/month for STT
