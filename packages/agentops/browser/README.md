---
description: "Optional AgentOps profile bundle that mounts DSH browser-use with the Chrome DevTools MCP provider."
kind: "package-bundle"
---

# @agentops/dsh-browser

English | [中文](README.zh.md)

## Summary

Use this optional bundle when an AgentOps profile should expose DSH's native browser-use tools. It mounts the browser-use service and one Chrome DevTools MCP provider without adding AgentOps-specific browser operations. Keeping the layer separate lets AgentOps plugins ship without a hard dependency on one concrete browser provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

The install path is the profile's bundle list, because this package declares `dsh.bundle.patch` and carries no plugin of its own. Add `@agentops/dsh-browser` to a profile's `dsh.profile.bundles` after `@deepseek-ai/dsh-web-app` and before the AgentOps capability bundle.

```yaml
---
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-web-app'
      - '@agentops/dsh-browser'
      - '@agentops/dsh-bundle'
```

The reconcile step activates this layer only because `package.json` declares the patch. Without that declaration the profile resolves the package as a plain dependency and no browser provider is mounted.

### What you get

The default provider launches an isolated headless Chromium for each live Agent. Its MCP tools are named `mcp__chrome-devtools-mcp__*`. Provider selection and launch mode belong to the profile, not an AgentOps capability instance.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Responsibility |
|---|---|
| `cordis.patch.yml` | Mounts `@deepseek-ai/dsh-browser-use` and the Chrome DevTools MCP provider |

The browser provider requires the DSH Agents, tools, system-prompt, and working-directory services. It registers one provider for the process and creates one browser MCP connection for each live Agent. Session ownership, tool discovery, screenshot delivery, and cleanup remain owned by DSH.

The bundle is intentionally separate from `@agentops/dsh-bundle`: an AgentOps-only deployment can omit it, and a different provider can replace it without changing AgentOps capability code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`../bundle/`](../bundle/README.md) — the AgentOps distribution bundle that composes this optional layer.
- [`../../browser-use/browser-use/`](../../browser-use/browser-use/README.md) — the DSH browser-use service this bundle mounts.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools and screenshots

#### What the model sees

The AgentOps bundle mounts the DSH browser-use provider, which registers one MCP server per live Agent. Tools retain upstream descriptions and JSON schemas under `mcp__chrome-devtools-mcp__<tool>` names, and text and screenshots use the normal tool-result pipeline.

#### Token effect

The catalog, resource helpers, and server instructions add tool definitions and prompt text. Calls add arguments, text, and admitted images to Session history.

#### KV Cache effect

An unchanged provider catalog preserves the tool-definition prefix. Browser results append to Session history; changing the provider or its upstream catalog can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One provider per process** — DSH browser-use rejects a second provider registration.
- **Experimental upstream tools** — Chrome DevTools MCP tool schemas follow the pinned experimental dependency.
- **No capability-instance isolation** — provider configuration is profile-wide; AgentOps instances do not launch separate browser backends.
- **Browser state is not restored from history** — a new or resumed Session starts a fresh launched Chromium.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
