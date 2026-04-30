# zWork Use Cases

This is the framing the product should ship against.

Users do not buy “tool calling,” “OCR,” or “workflow engines.” They buy an outcome.

## The baseline use-case bar

Every promoted workflow should satisfy:

- easy to explain in one sentence
- easy to test on a fresh install
- clearly better than using ChatGPT in a browser tab
- produces a concrete output on the user’s machine

## Near-term sellable use cases

## 1. Competitor research pack

Prompt:

```text
Research the top 5 AI meeting note tools and create a comparison sheet with pricing, strengths, and weak points.
```

Why it sells:

- combines browsing, summarization, and spreadsheet output
- easy to demo
- obvious time savings

## 2. Folder cleanup and naming

Prompt:

```text
Organize my Downloads folder into clear subfolders and rename ambiguous files based on what they contain.
```

Why it sells:

- desktop-native value
- not just text generation
- demonstrates trust and useful action

## 3. Meeting notes to follow-up draft

Prompt:

```text
Turn these meeting notes into a short summary, action list, and follow-up email draft.
```

Why it sells:

- frequent everyday pain point
- produces immediate artifacts
- easy for non-technical users to understand

## 4. Prospect research brief

Prompt:

```text
Research these 20 companies and prepare one-paragraph notes plus a CSV I can use for outreach.
```

Why it sells:

- clear business value
- repeatable workflow
- naturally leads to templates later

## 5. Repo review and PR plan

Prompt:

```text
Analyze this repository and produce a concrete implementation plan for issue #123 with risks and affected files.
```

Why it sells:

- strong fit for technical buyers
- differentiates from generic chat
- pairs well with local file and command access

## Product packaging rule

When deciding what to ship next, ask:

1. what job gets done?
2. what proof do we have it works?
3. what output artifact does the user keep?
4. how will we measure success in telemetry?

If the answer is just “it adds a capability,” it is not yet packaged well enough.

## Metrics to track per use case

- install-to-first-task conversion
- sign-in completion
- first successful artifact creation
- time-to-first-useful-output
- managed mode activation
- update adoption after release
