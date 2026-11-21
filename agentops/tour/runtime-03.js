/* AgentOps chapter 03 · source-evidence walkthrough.
   This page is a teaching simulation. It does not execute production health checks. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const EVIDENCE = {
    delegation: {
      kind: 'POLICY',
      title: '委派边界',
      sub: 'SupAgent 只编排，不执行',
      badge: 'ENFORCED',
      summary: [
        'SupAgent 的人设与权限配置同时限制职责：它通过 ',
        { text: 'subagent', code: true },
        ' 派发任务，只拿到 ',
        { text: 'subagentId', code: true },
        ' 句柄；业务工具在 ',
        { text: 'denied_tools', code: true },
        ' 中被拒绝，允许的 preset 白名单和 ',
        { text: 'maxDepth: 1', code: true },
        ' 共同约束委派范围。'
      ],
      rules: [
        {
          title: '工具最小化：',
          body: ['人设要求 SupAgent 只做意图识别、任务分解和动态编排；', { text: 'sql_query', code: true }, '、', { text: 'describe_database', code: true }, '、审批和运维写工具都不在它的可用工具里。']
        },
        {
          title: '目标白名单：',
          body: ['subagent 工具只接受配置中列出的业务 Agent preset；模型不能虚构 Agent 名称。']
        },
        {
          title: '一层委派：',
          body: ['SupAgent 失败时不替代业务 Agent 执行；它只汇报失败原因和下一步建议。']
        }
      ],
      paths: [
        'agentops/agents/manager.yaml:25-40  · subagent 派发协议与结果回投',
        'agentops/agents/manager.yaml:52-73  · allowed_tools / denied_tools',
        'packages/agentops/bundle/presets/agents.generated.patch.yml:138-149  · allowedAgentPresets / maxDepth'
      ],
      limit: '这里证明的是 SupAgent 的配置边界；具体子代理能做什么，仍要读取该 preset 自己的工具配置。'
    },
    ownership: {
      kind: 'OWNERSHIP',
      title: '工作流所有权',
      sub: 'smart_query 只能运行被钉定的 DAG',
      badge: 'PINNED',
      summary: [
        '智能问数 Agent 声明 ',
        { text: 'execution: workflow', code: true },
        '；preset 将 ',
        { text: 'ownedWorkflowId', code: true },
        ' 固定为 ',
        { text: 'smart-query', code: true },
        '，节点执行器强制复用所属 Agent 的 preset，并在节点层级拒绝再次启动工作流。'
      ],
      rules: [
        {
          title: '工作流钉定：',
          body: ['preset 只暴露 ', { text: 'dag_run', code: true }, ' 与 ', { text: 'list_runs', code: true }, '；模型传入 ', { text: 'workflowId', code: true }, ' 或 ', { text: 'yaml', code: true }, ' 不会改变固定工作流。']
        },
        {
          title: '节点权限继承：',
          body: ['DAG 节点使用 ', { text: 'ownerAgentPreset', code: true }, '，而不是调用方偶然携带的工具组合；缺省时失败关闭，不静默继承。']
        },
        {
          title: '禁止递归：',
          body: ['层级是 SupAgent 0 → smart_query 1 → node 2；', { text: 'delegationDepthOf(exec.agent) > 1', code: true }, ' 时拒绝 ', { text: 'dag_run', code: true }, '。']
        }
      ],
      paths: [
        'agentops/agents/smart_query.yaml:18-40  · 工作流型 Agent 的调用约束',
        'packages/agentops/bundle/presets/agents.generated.patch.yml:376-384  · ownedWorkflowId / ownerAgentPreset / only',
        'packages/agentops/dag/src/dsh.ts:202-243  · 节点复用 owner preset',
        'packages/agentops/dag/src/dsh.ts:675-704  · 固定 workflow 与 depth guard'
      ],
      limit: '固定的是 smart-query 的 preset 与运行入口；节点内部的业务步骤仍由工作流 YAML 和节点提示词决定。'
    },
    data: {
      kind: 'DATA GUARD',
      title: '只读取数护栏',
      sub: 'SQL 入口、数据源与输出共同限界',
      badge: 'READ ONLY',
      summary: [
        '查询先经 ',
        { text: 'guardSql', code: true },
        ' 拒绝多语句、非 SELECT、系统库、白名单外对象与 denied columns；缺 LIMIT 时自动注入，SQLite 打开连接时再声明 ',
        { text: 'readOnly: true', code: true },
        '。'
      ],
      rules: [
        {
          title: '语句入口：',
          body: ['只接受单语句 ', { text: 'SELECT', code: true }, ' 或 ', { text: 'WITH … SELECT', code: true }, '；写操作和危险关键字直接拒绝。']
        },
        {
          title: '数据范围：',
          body: ['schema、table 与 datasource 都受白名单限制；denied columns 在语句进入执行前被屏蔽，MySQL 也只连接列出的 datasource。']
        },
        {
          title: '截断分层：',
          body: ['工具文本最多渲染 50 行，数据源默认 ', { text: 'maxRows=1000', code: true }, '，run_sql 节点提示要求只保留前 50 行并标记 ', { text: 'truncated=true', code: true }, '。']
        }
      ],
      paths: [
        'packages/agentops/db/src/guard.ts:50-108  · SQL 语法、schema / table / column 与 LIMIT 校验',
        'packages/agentops/db/src/query.ts:87,151  · SQLite readOnly 连接',
        'packages/agentops/db/src/tools.ts:34  · 工具文本 MAX_RENDERED_ROWS = 50',
        'packages/agentops/db/src/datasources.ts:34-39  · 默认 maxRows = 1000',
        'agentops/workflows/smart-query.yaml:91-120  · run_sql 的截断与失败约束'
      ],
      limit: '50 行是 SQL 工具文本的渲染上限，不是全局固定结果行数；数据源上限和节点提示是另外两层约束。'
    },
    limits: {
      kind: 'RUN LIMITS',
      title: '真实运行限制',
      sub: '跳过、失败与恢复的精确语义',
      badge: 'KNOWN LIMITS',
      summary: [
        'skip_if 命中时节点仍以 ',
        { text: 'completed', code: true },
        ' 结算，只把 ', { text: 'outputs.skipped', code: true },
        ' 置为 true；下游阻断判断只看节点 status 的 ',
        { text: 'failed / skipped', code: true },
        '，引擎没有自动 DAG retry。'
      ],
      rules: [
        {
          title: '跳过不是 skipped 状态：',
          body: ['executeNode 直接返回 ', { text: '{ skipped: true, reason }', code: true }, '；调用方仍把它结算为 completed。']
        },
        {
          title: '失败语义：',
          body: ['节点异常结算为 failed；任一节点 failed 会让整次 run failed；present_result 可由 blockedByUpstream 变为 skipped。']
        },
        {
          title: '恢复边界：',
          body: ['恢复会重跑所有非 completed 节点；运行记录保存当前状态、输出、actor 与错误，但不保存历史 workflow YAML revision。']
        }
      ],
      paths: [
        'packages/agentops/dag/src/engine.ts:140-199  · 分层调度、节点结算、整次 run 状态',
        'packages/agentops/dag/src/engine.ts:210-214  · skip_if 返回 completed + outputs.skipped',
        'packages/agentops/dag/src/engine.ts:288-293  · 下游只检查 failed / skipped',
        'packages/agentops/dag/src/run-store.ts:13-40,189-243  · 运行记录与恢复边界'
      ],
      limit: '页面没有执行真实 DAG，也没有执行生产健康检查；以上是源码事实，动画状态仅是教学表达。'
    }
  };

  const CHECKS = [
    { key: 'delegation', evidence: 'delegation', label: '委派工具边界', verdict: 'TOOLS LOADED' },
    { key: 'ownership', evidence: 'ownership', label: '工作流钉定', verdict: 'PINNED LOADED' },
    { key: 'sql', evidence: 'data', label: 'SQL 只读护栏', verdict: 'GUARD LOADED' },
    { key: 'scope', evidence: 'data', label: '数据范围边界', verdict: 'SCOPE LOADED' },
    { key: 'skip', evidence: 'limits', label: '跳过状态语义', verdict: 'SEMANTICS LOADED' },
    { key: 'recovery', evidence: 'limits', label: '恢复边界', verdict: 'LIMITS LOADED' }
  ];

  const guardCards = Array.from(document.querySelectorAll('.guard-card'));
  const chainButtons = Array.from(document.querySelectorAll('.chain[data-jump]'));
  const checkButtons = Array.from(document.querySelectorAll('.check[data-check]'));
  const checkStates = CHECKS.map(() => 'idle');
  const timers = new Set();
  let activeEvidence = 'delegation';
  let runToken = 0;
  let allRunning = false;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendRich(parent, parts) {
    parts.forEach((part) => {
      if (typeof part === 'string') {
        parent.appendChild(document.createTextNode(part));
        return;
      }
      const tag = part.code ? 'code' : (part.bold ? 'b' : 'span');
      parent.appendChild(make(tag, part.className || '', part.text));
    });
  }

  function renderEvidence(key) {
    const ev = EVIDENCE[key];
    if (!ev) return;
    activeEvidence = key;
    $('evKind').textContent = ev.kind;
    $('evTitle').textContent = ev.title;
    $('evSub').textContent = ev.sub;
    $('evBadge').textContent = ev.badge;

    const summary = $('evSummary');
    summary.replaceChildren();
    appendRich(summary, ev.summary);

    const rules = $('evRules');
    rules.replaceChildren();
    ev.rules.forEach((rule, index) => {
      const row = make('div', 'ev-rule');
      row.appendChild(make('i', '', String(index + 1)));
      const body = make('span');
      body.appendChild(make('b', '', rule.title));
      appendRich(body, rule.body);
      row.appendChild(body);
      rules.appendChild(row);
    });

    const paths = $('evPaths');
    paths.replaceChildren();
    ev.paths.forEach((path) => paths.appendChild(make('code', '', path)));

    const limit = $('evLimit');
    limit.replaceChildren();
    limit.appendChild(make('b', '', 'LIMIT · '));
    limit.appendChild(document.createTextNode(ev.limit));

    guardCards.forEach((card) => {
      const on = card.dataset.key === key;
      card.classList.toggle('active', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    chainButtons.forEach((button) => button.classList.toggle('on', button.dataset.jump === key));
  }

  function renderCheck(index) {
    const button = checkButtons[index];
    if (!button) return;
    const state = checkStates[index];
    button.classList.toggle('running', state === 'running');
    button.classList.toggle('ok', state === 'ok');
    button.setAttribute('aria-pressed', state === 'ok' ? 'true' : 'false');
    const tick = button.querySelector('.tick');
    const verdict = button.querySelector('.verdict');
    if (tick) tick.textContent = state === 'ok' ? '✓' : (state === 'running' ? '◌' : '○');
    if (verdict) verdict.textContent = state === 'ok' ? CHECKS[index].verdict : (state === 'running' ? 'LOADING SOURCE…' : 'NOT RUN');
  }

  function renderGate() {
    const done = checkStates.filter((state) => state === 'ok').length;
    const percent = Math.round((done / CHECKS.length) * 100);
    const gauge = $('gauge');
    gauge.style.setProperty('--p', String(percent));
    $('gaugeN').textContent = String(done);

    const result = $('healthResult');
    result.classList.toggle('pass', done === CHECKS.length);
    const title = result.querySelector('b');
    const meta = $('healthMeta');
    if (done === CHECKS.length) {
      title.textContent = '6 / 6 SOURCE REFERENCES LOADED';
      $('healthTitle').textContent = '源码引用已全部展开';
      $('healthDesc').textContent = '六项教学核对均已完成。这只表示对应源码位置已经读取，不是生产健康检查。';
      meta.textContent = 'teaching simulation · not production health';
    } else if (done > 0) {
      title.textContent = 'EVIDENCE GATE · IN PROGRESS';
      $('healthTitle').textContent = done + ' / 6 项已展开';
      $('healthDesc').textContent = '继续核对剩余源码边界；动画不连接任何生产探针。';
      meta.textContent = done + ' / 6 checks loaded · teaching only';
    } else {
      title.textContent = 'EVIDENCE GATE · NOT RUN';
      $('healthTitle').textContent = '尚未核对';
      $('healthDesc').textContent = '逐项加载源码证据；动画与结论仅表示教学演示已展开，不代表生产系统检查。';
      meta.textContent = '0 / 6 checks loaded · teaching only';
    }
    $('healthRun').textContent = allRunning ? '核对中…' : (done === CHECKS.length ? '重新核对' : '全部核对');
    checkStates.forEach((_, index) => renderCheck(index));
  }

  function clearTimers() {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  }

  function later(callback, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  }

  function chooseEvidence(key) {
    if (EVIDENCE[key]) renderEvidence(key);
  }

  function runSingleCheck(index) {
    runToken += 1;
    const token = runToken;
    clearTimers();
    allRunning = false;
    $('healthRun').disabled = false;
    checkStates[index] = 'running';
    chooseEvidence(CHECKS[index].evidence);
    renderGate();
    later(() => {
      if (token !== runToken) return;
      checkStates[index] = 'ok';
      renderGate();
    }, 360);
  }

  function runAllChecks() {
    const token = ++runToken;
    clearTimers();
    allRunning = true;
    checkStates.fill('idle');
    $('healthRun').disabled = true;
    $('healthRun').textContent = '核对中…';
    renderGate();
    chooseEvidence(CHECKS[0].evidence);

    let cursor = 0;
    function advance() {
      if (token !== runToken) return;
      if (cursor > 0) checkStates[cursor - 1] = 'ok';
      if (cursor >= CHECKS.length) {
        allRunning = false;
        $('healthRun').disabled = false;
        renderGate();
        return;
      }
      checkStates[cursor] = 'running';
      chooseEvidence(CHECKS[cursor].evidence);
      renderGate();
      cursor += 1;
      later(advance, 320);
    }
    advance();
  }

  function resetChecks() {
    runToken += 1;
    clearTimers();
    allRunning = false;
    checkStates.fill('idle');
    $('healthRun').disabled = false;
    $('healthRun').textContent = '全部核对';
    renderGate();
    chooseEvidence('delegation');
  }

  guardCards.forEach((card) => {
    card.addEventListener('click', () => renderEvidence(card.dataset.key));
  });
  chainButtons.forEach((button) => {
    button.addEventListener('click', () => {
      renderEvidence(button.dataset.jump);
      const target = guardCards.find((card) => card.dataset.key === button.dataset.jump);
      if (target) target.focus({ preventScroll: true });
    });
  });
  checkButtons.forEach((button, index) => {
    button.addEventListener('click', () => runSingleCheck(index));
  });
  $('healthRun').addEventListener('click', runAllChecks);
  $('healthReset').addEventListener('click', resetChecks);

  const carry = window.VT && window.VT.carry;
  if (carry) {
    const runId = carry.runId || 'runId unavailable';
    const status = carry.status || 'status unavailable';
    const nodes = carry.nodes === undefined ? '5' : String(carry.nodes);
    $('receiptText').textContent = '来自第 2 章 · ' + runId + ' · ' + status + ' · ' + nodes + ' nodes';
    $('receipt').classList.add('show');
    $('receipt').title = [
      'workflow=' + (carry.workflow || 'unknown'),
      'subagentId=' + (carry.subagentId || 'unknown'),
      'evidence=' + (carry.evidence || 'unknown')
    ].join(' · ');
  }

  window.addEventListener('pagehide', clearTimers, { once: true });
  resetChecks();
})();
