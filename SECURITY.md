# Security policy

English | [中文](SECURITY.zh.md)

AgentOps-DSH is a derivative of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), and it inherits that project's experimental status. Read [SAFETY.md](SAFETY.md) before you deploy it: the harness executes model-generated code and commands, loads third-party plugins, and reaches the network, processes, credentials, and files made available to it.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository. Do not open a public issue for a vulnerability.

Include the affected version or commit, the steps to reproduce, the expected and observed behaviour, and the impact you assessed. A proof of concept helps but is not required.

We aim to acknowledge a report within seven days and to share a remediation plan once the report is confirmed. We will credit you in the advisory unless you ask us not to.

Vulnerabilities in upstream DeepSeek Harness belong upstream. Report them in [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) instead.

## What to expect

This project is not under a paid security response SLA. It is maintained by a small team, and a report may take longer to resolve than the acknowledgement window above. We publish fixes in the repository's normal release flow.

## Secrets and credentials

AgentOps stores connector credentials in an encrypted local store under `$DSH_HOME`. Treat that directory as sensitive: it holds the key that seals stored secrets. Keep it out of version control and out of shared or backup locations you do not control.

Never commit a credential, API key, or `.env` file to this repository. If you do, rotate it — removing the commit later does not un-disclose it.
