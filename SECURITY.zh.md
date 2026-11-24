# 安全策略

[English](SECURITY.md) | 中文

AgentOps-DSH 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的衍生项目，继承其实验性状态。部署前请先读 [SAFETY.zh.md](SAFETY.zh.md)：本 harness 会执行模型生成的代码与命令、加载第三方插件，并访问向其开放的网络、进程、凭据与文件。

## 报告漏洞

请通过本仓库的 GitHub[私密漏洞报告](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)私下报告疑似漏洞。漏洞不要开公开 issue。

请说明受影响的版本或提交、复现步骤、预期与实际行为，以及你评估出的影响。附上概念验证有帮助，但不是必需。

我们力争在七天内确认收到报告，并在确认漏洞后给出修复方案。除非你要求，我们会在公告中致谢。

上游 DeepSeek Harness 的漏洞请提交到上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

## 预期

本项目不提供付费的安全响应 SLA。它由一个小团队维护，报告的修复可能比上述确认窗口更久。修复通过仓库的常规发布流程发布。

## 密钥与凭据

AgentOps 把连接器凭据以加密形式存放在 `$DSH_HOME` 下的本地存储中。请把该目录当作敏感数据：其中包含用于封装已存密钥的密钥。不要把它提交进版本控制，也不要放进你不掌控的共享目录或备份位置。

不要把任何凭据、API key 或 `.env` 文件提交进本仓库。如果已经提交，请立即轮换——事后删除提交并不能收回已经泄露的内容。
