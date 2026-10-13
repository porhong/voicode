# Security policy

VoiceCode Agent lets paired devices drive Claude Code and the desktop mouse on the
machine it runs on, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://github.com/porhong/voicode/security/advisories/new)
with steps to reproduce and the affected version (`voicecode-agent --version`).
You should get a response within a week.

## Scope

In scope: anything that lets an unpaired device or a website reach the agent's API,
WebSocket or control channel; ways to run a Claude tool without an explicit approval;
escaping the project allow-list; weaknesses in pairing, credentials or the local CA;
and memory-safety bugs in the native helpers.

Out of scope: attacks that need code execution as the user running the agent (it is
that user's own machine), and exposing the agent to the internet against the README's
advice.

The design and its mitigations are described in the README's
[Security model](README.md#security-model) section.
