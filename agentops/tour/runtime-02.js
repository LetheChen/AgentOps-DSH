/* AgentOps chapter 02 · classroom simulation. All IDs, values and times are simulated. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const nodeMeta = {
    route_intent: {
      role: '意图分类员',
      hint: '只判断问题是否属于数据查询/统计/报表/状态/审批类，不生成 SQL。',
      evidence: ['agentops/workflows/smart-query.yaml:27-47', 'packages/agentops/dag/src/engine.ts:154-199']
    },
    refuse_intent: {
      role: '接待员',
      hint: 'skip_if=route_intent.intent。命中时不启动节点 subagent，节点以 completed 结算并输出 skipped。',
      evidence: ['agentops/workflows/smart-query.yaml:42-57', 'packages/agentops/dag/src/engine.ts:210-214']
    },
    plan_sql: {
      role: 'SQL 工程师',
      hint: '先核对业务口径和真实字段，再生成一条只读 SELECT；本节点不执行 SQL。',
      evidence: ['agentops/workflows/smart-query.yaml:59-89', 'packages/agentops/db/src/guard.ts:50-108']
    },
    run_sql: {
      role: '数据执行员',
      hint: '通过 sql_query 执行上游 SQL。可自修错误最多最小改写并重试一次；DAG 引擎本身没有自动节点重试。',
      evidence: ['agentops/workflows/smart-query.yaml:91-120', 'packages/agentops/dag/src/engine.ts:183-197']
    },
    present_result: {
      role: '结果讲解员',
      hint: '把 result 翻译为用户回答；失败时如实回显，不能编造数据或改用 sql_query 绕开工作流。',
      evidence: ['agentops/workflows/smart-query.yaml:122-139', 'agentops/agents/smart_query.yaml:29-40']
    }
  };

  const SCENARIOS = {
    normal: {
      label: '正常问数',
      question: '本月审批通过率是多少？',
      note: '正常路径实际执行 route_intent → plan_sql → run_sql → present_result',
      runStatus: 'completed',
      subagentState: 'completed',
      finalTitle: '查数完成 · answer 已回投',
      finalDesc: '4 个节点 subagent 执行；refuse_intent 命中 skip_if，未派生子代理。',
      warning: '<b>正常路径：</b><code>refuse_intent</code> 的 <code>skip_if</code> 命中时，节点仍结算为 <code>completed</code>，并在 outputs 中记录 <code>{skipped:true, reason}</code>；其余四个角色继续执行。',
      nodes: {
        route_intent: {state:'completed', input:{question:'本月审批通过率是多少？'}, output:{intent:true,reason:'问题要求统计审批通过率'}},
        refuse_intent: {state:'skip', input:{skippedBy:'skip_if: {{route_intent.intent}}'}, output:{skipped:true,reason:'{{route_intent.intent}}'}},
        plan_sql: {state:'completed', input:{question:'本月审批通过率是多少？',database:'audit_reader'}, output:{sql:'SELECT /* 教学模拟，非实跑 */ ... FROM audit_example.<table> WHERE receive_time >= 本月起点'}},
        run_sql: {state:'completed', input:{database:'audit_reader',sql:'SELECT /* 教学模拟 */ ...'}, output:{ok:true,columns:['total','approved','approval_rate'],rows:[{total:128,approved:109,approval_rate:85.16}],row_count:1,truncated:false}},
        present_result: {state:'completed', input:{question:'本月审批通过率是多少？',result:'run_sql.result'}, output:{answer:'本月审批通过率约为 85.16%（109 / 128）。这是教学模拟值，并非生产数据。'}}
      },
      timeline: [
        {stage:0,type:'request',message:'用户提交原话；SupAgent 收到完整问题。',actor:['user','completed']},
        {stage:1,type:'manager',message:'SupAgent 识别为智能问数任务，准备调用 subagent。',actor:['manager','running']},
        {stage:1,type:'delegate',message:'subagent 立即返回句柄；SupAgent 不等待阻塞，也不持有 sql_query。',actor:['manager','running'],dispatch:true},
        {stage:2,type:'agent',message:'smart_query 在自身轮次启动；它只被允许运行 smart-query。',actor:['smart_query','running']},
        {stage:3,type:'dag',message:'dag_run 创建教学 runId；固定工作流共有 5 个 agent 节点声明。',dag:true},
        {stage:3,type:'node',message:'route_intent 节点 subagent 开始判定意图。',node:['route_intent','running']},
        {stage:3,type:'node',message:'route_intent 输出 intent=true；上游数据进入下一层。',node:['route_intent','completed']},
        {stage:3,type:'skip',message:'refuse_intent 命中 skip_if；节点结算为 completed，outputs.skipped=true，未启动 subagent。',node:['refuse_intent','skip']},
        {stage:3,type:'node',message:'plan_sql 节点 subagent 生成一条只读 SELECT，不执行查询。',node:['plan_sql','running']},
        {stage:3,type:'node',message:'plan_sql 交付 sql 端口；DAG 继续调度下游。',node:['plan_sql','completed']},
        {stage:3,type:'node',message:'run_sql 节点 subagent 经 sql_query 执行；教学输出返回 1 行。',node:['run_sql','running']},
        {stage:3,type:'node',message:'run_sql 交付 result 端口，truncated=false。',node:['run_sql','completed']},
        {stage:4,type:'node',message:'present_result 节点 subagent 生成最终 answer。',node:['present_result','running']},
        {stage:4,type:'result',message:'present_result 交付 answer；DAG 整体 status=completed。',node:['present_result','completed']},
        {stage:5,type:'manager',message:'结果自动回到 smart_query，再回投 SupAgent；SupAgent 汇总并回复用户。',actor:['smart_query','completed'],managerFinal:true}
      ]
    },
    limitation: {
      label: 'skip_if 限制',
      question: '你好，帮我总结一下今天的工作',
      note: 'intent=false：plan_sql 输出 skipped 但状态 completed，run_sql 与 present_result 仍被调度',
      runStatus: 'completed',
      subagentState: 'completed',
      finalTitle: 'run completed · 但下游未按业务意图停止',
      finalDesc: '这展示真实引擎限制：outputs.skipped 不会进入 blockedByUpstream 的阻断条件。',
      warning: '<b>真实限制：</b><code>plan_sql</code> 命中 <code>skip_if</code> 后是 <code>completed + outputs.skipped</code>，不是 <code>skipped</code> 状态。引擎的 <code>blockedByUpstream</code> 只看 failed/skipped，所以 <code>run_sql</code> 与 <code>present_result</code> 仍会执行。',
      nodes: {
        route_intent: {state:'completed', input:{question:'你好，帮我总结一下今天的工作'}, output:{intent:false,reason:'属于开放问答，不是业务数据查询'}},
        refuse_intent: {state:'completed', input:{question:'你好，帮我总结一下今天的工作'}, output:{answer:'本链路只回答业务数据类问题。总结工作可交给智能分析 Agent。'}},
        plan_sql: {state:'skip', input:{skippedBy:'skip_if: {{not route_intent.intent}}'}, output:{skipped:true,reason:'{{not route_intent.intent}}'}},
        run_sql: {state:'completed', input:{database:'audit_reader',sql:null,note:'节点仍被调度，但上游没有 sql 端口'}, output:{ok:false,error:'教学模拟：上游 plan_sql 被跳过，未提供可执行 SQL',attempts:0}},
        present_result: {state:'completed', input:{question:'你好，帮我总结一下今天的工作',result:'run_sql.result'}, output:{answer:'本次查询未执行：上游 SQL 生成节点被跳过，没有可执行 SQL。'}}
      },
      timeline: [
        {stage:0,type:'request',message:'用户提交非问数请求；SupAgent 根据职责判断需交给业务 Agent。',actor:['user','completed']},
        {stage:1,type:'manager',message:'SupAgent 发起 subagent 委派；它不感知工作流内部。',actor:['manager','running']},
        {stage:1,type:'delegate',message:'subagent 立即返回句柄；后续结果自动回投。',actor:['manager','running'],dispatch:true},
        {stage:2,type:'agent',message:'smart_query 接收任务并调用被钉定的 dag_run。',actor:['smart_query','running']},
        {stage:3,type:'dag',message:'固定 smart-query 工作流启动，5 个节点进入调度。',dag:true},
        {stage:3,type:'node',message:'route_intent 开始分类，节点 subagent 已启动。',node:['route_intent','running']},
        {stage:3,type:'node',message:'route_intent 输出 intent=false。',node:['route_intent','completed']},
        {stage:3,type:'node',message:'refuse_intent 因 skip_if 为 false 而真实执行，给出引导回答。',node:['refuse_intent','running']},
        {stage:3,type:'node',message:'refuse_intent 输出 answer；该节点本身 completed。',node:['refuse_intent','completed']},
        {stage:3,type:'skip',message:'plan_sql 命中 {{not route_intent.intent}}；completed + outputs.skipped，未启动 subagent。',node:['plan_sql','skip']},
        {stage:3,type:'node',message:'run_sql 仍被调度；缺少 sql 输入，节点以失败结果完成自身执行。',node:['run_sql','running']},
        {stage:3,type:'node',message:'run_sql 输出 ok=false；注意它的节点状态仍是 completed。',node:['run_sql','completed']},
        {stage:4,type:'node',message:'present_result 仍被调度并解释上游缺少 SQL。',node:['present_result','running']},
        {stage:4,type:'result',message:'present_result 输出 answer；任一点失败均未发生，整次 run=completed。',node:['present_result','completed']},
        {stage:5,type:'manager',message:'smart_query 与 SupAgent 逐层回投；最终回答仍是“无法查询”。',actor:['smart_query','completed'],managerFinal:true}
      ]
    },
    failure: {
      label: '执行失败',
      question: '统计本月各审批节点的平均处理时长',
      note: 'run_sql failed → present_result 被 blockedByUpstream 跳过 → 整次 run failed',
      runStatus: 'failed',
      subagentState: 'failed',
      finalTitle: 'run failed · 失败被如实回投',
      finalDesc: 'run_sql 失败；present_result 被跳过；SupAgent 不替代执行，也不改用 sql_query。',
      warning: '<b>失败边界：</b><code>run_sql</code> 节点异常结算为 <code>failed</code>。依赖它的 <code>present_result</code> 被 <code>blockedByUpstream</code> 标为 <code>skipped</code>，整次 run=failed。DAG 引擎没有自动节点 retry。',
      nodes: {
        route_intent: {state:'completed', input:{question:'统计本月各审批节点的平均处理时长'}, output:{intent:true,reason:'属于审批业务统计'}},
        refuse_intent: {state:'skip', input:{skippedBy:'skip_if: {{route_intent.intent}}'}, output:{skipped:true,reason:'{{route_intent.intent}}'}},
        plan_sql: {state:'completed', input:{question:'统计本月各审批节点的平均处理时长',database:'audit_reader'}, output:{sql:'SELECT /* 教学模拟 */ node_name, AVG(duration) ... GROUP BY node_name'}},
        run_sql: {state:'failed', input:{database:'audit_reader',sql:'SELECT /* 教学模拟 */ node_name, AVG(duration) ...'}, output:null,error:'教学模拟：SQL 执行连接超时（不可自修错误）'},
        present_result: {state:'skipped', input:null, output:null,error:'blockedByUpstream: run_sql status=failed'}
      },
      timeline: [
        {stage:0,type:'request',message:'用户提交审批数据分析请求。',actor:['user','completed']},
        {stage:1,type:'manager',message:'SupAgent 选择 smart_query preset 并派发自包含任务。',actor:['manager','running']},
        {stage:1,type:'delegate',message:'subagent 立即返回句柄；SupAgent 等待结果自动回投。',actor:['manager','running'],dispatch:true},
        {stage:2,type:'agent',message:'smart_query 启动固定工作流，不自行写 SQL 取数。',actor:['smart_query','running']},
        {stage:3,type:'dag',message:'dag_run 启动 run；各节点按依赖层调度。',dag:true},
        {stage:3,type:'node',message:'route_intent 判定 intent=true。',node:['route_intent','running']},
        {stage:3,type:'node',message:'route_intent 完成。',node:['route_intent','completed']},
        {stage:3,type:'skip',message:'refuse_intent 命中 skip_if，以 completed + skipped 结算。',node:['refuse_intent','skip']},
        {stage:3,type:'node',message:'plan_sql 启动并生成查询计划。',node:['plan_sql','running']},
        {stage:3,type:'node',message:'plan_sql 交付 sql。',node:['plan_sql','completed']},
        {stage:3,type:'node',message:'run_sql 启动；工具返回不可自修错误。',node:['run_sql','running']},
        {stage:3,type:'error',message:'run_sql 执行异常 → status=failed。DAG 不会自动重试该节点。',node:['run_sql','failed'],stageState:'error'},
        {stage:3,type:'error',message:'present_result 依赖失败节点 → blockedByUpstream → status=skipped，未启动 subagent。',node:['present_result','skipped']},
        {stage:4,type:'agent',message:'DAG 整体 status=failed；smart_query 收到失败节点与 error。',actor:['smart_query','failed'],stageState:'error'},
        {stage:5,type:'manager',message:'SupAgent 收到失败回执，如实告知用户；不绕开工作流替代执行。',actor:['manager','completed'],managerFinal:true}
      ]
    }
  };

  const state = {
    scenario: 'normal', action: -1, playing: false, paused: false, finished: false,
    timer: 0, runId: '', subagentId: '', dispatchAt: -1, spawned: new Set(),
    nodeStates: {}, actorStates: {}, stageStates: ['pending','pending','pending','pending','pending','pending'],
    selectedNode: 'route_intent', selectedActor: '', finalStatus: ''
  };
  const current = () => SCENARIOS[state.scenario];
  const timeline = () => current().timeline;
  const fmt = (value) => JSON.stringify(value, null, 2);
  const nodeButton = (id) => document.querySelector('.node-card[data-node="' + id + '"]');
  const nodeStateLabel = (value) => ({
    pending:'pending', running:'running', completed:'completed', skip:'completed/skip',
    skipped:'skipped', failed:'failed'
  }[value] || value);

  function clock() {
    return new Date().toLocaleTimeString('zh-CN', { hour12:false });
  }

  function newSimId(prefix) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(8, 14);
    return prefix + '_sim_' + stamp;
  }

  function addEvent(type, message, tone) {
    const list = $('events');
    const placeholder = list.querySelector('.event .ev-type');
    if (placeholder && placeholder.textContent === 'sim') list.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'event ' + (tone || '');
    const time = document.createElement('time');
    const kind = document.createElement('span');
    const text = document.createElement('p');
    time.textContent = clock();
    kind.className = 'ev-type';
    kind.textContent = type;
    text.textContent = message;
    row.append(time, kind, text);
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
    $('eventCount').textContent = list.querySelectorAll('.event').length + ' EVENTS';
  }

  function clearEvents() {
    $('events').innerHTML = '<div class="event"><time>--:--:--</time><span class="ev-type">sim</span><p>等待运行。所有 ID、时间和输出均为教学模拟。</p></div>';
    $('eventCount').textContent = '0 EVENTS';
  }

  function setActor(actor, value) {
    state.actorStates[actor] = value;
    const map = { user:'userCard', manager:'managerCard', smart_query:'smartCard' };
    const el = $(map[actor]);
    if (el) el.dataset.state = value;
  }

  function setNode(id, value) {
    state.nodeStates[id] = value;
    if (value === 'running') state.spawned.add(id);
    const el = nodeButton(id);
    if (!el) return;
    el.dataset.state = value;
    el.querySelector('.node-state').textContent = nodeStateLabel(value);
    el.classList.toggle('flow-active', value === 'running' || value === 'completed');
  }

  function markStages(upTo, forced) {
    for (let i = 0; i <= upTo; i += 1) {
      if (state.stageStates[i] === 'error') continue;
      if (i === upTo && forced === 'error') state.stageStates[i] = 'error';
      else if (i === upTo && state.playing && !forced) state.stageStates[i] = 'active';
      else if (!forced) state.stageStates[i] = 'done';
      else state.stageStates[i] = 'done';
    }
  }

  function renderPipeline() {
    const active = state.action >= 0 && !state.finished ? timeline()[state.action].stage : -1;
    document.querySelectorAll('.step').forEach((el) => {
      const i = Number(el.dataset.step);
      el.classList.remove('active','done','error','blocked');
      if (state.stageStates[i] === 'error') el.classList.add('error');
      else if (i === active) el.classList.add('active');
      else if (state.stageStates[i] === 'done') el.classList.add('done');
    });
  }

  function renderMetrics() {
    const nodeValues = Object.values(state.nodeStates);
    const settled = nodeValues.filter((v) => v !== 'pending' && v !== 'running').length;
    const skipped = nodeValues.filter((v) => v === 'skip' || v === 'skipped').length;
    const failed = nodeValues.filter((v) => v === 'failed').length;
    const activations = (state.dispatchAt >= 0 ? 1 : 0) + state.spawned.size;
    $('mSubagent').textContent = activations + ' / 6';
    $('mNodes').textContent = settled + ' / 5';
    $('mRun').textContent = state.finished ? (state.finalStatus || 'IDLE').toUpperCase() : (state.playing ? 'RUNNING' : (state.action >= 0 ? 'PAUSED' : 'IDLE'));
    $('mFlags').textContent = skipped + ' / ' + failed;
  }

  function setStatus(text, tone) {
    const el = $('simStatus');
    el.textContent = text;
    el.classList.remove('warn','red');
    if (tone) el.classList.add(tone);
  }

  function renderButtons() {
    const run = $('runBtn');
    if (state.playing) run.childNodes[run.childNodes.length - 1].nodeValue = '暂停运行';
    else if (state.paused && !state.finished) run.childNodes[run.childNodes.length - 1].nodeValue = '继续运行';
    else if (state.finished) run.childNodes[run.childNodes.length - 1].nodeValue = '重新运行';
    else run.childNodes[run.childNodes.length - 1].nodeValue = '运行这次流程';
  }

  function renderInspector() {
    if (state.selectedActor) {
      const actor = state.selectedActor;
      const data = {
        user: {
          title: '业务用户', sub: '请求入口 · natural language',
          input: { question: current().question },
          output: { delegated: 'SupAgent receives the request' },
          hint: '用户只提交业务问题；不会直接接触 DAG、SQL 或节点权限。',
          evidence: ['agentops/agents/manager.yaml:15-40']
        },
        manager: {
          title: 'SupAgent · 入口 Agent', sub: 'depth 0 · 只负责识别、派发与汇总',
          input: { message: current().question, mode: 'task dispatch' },
          output: state.dispatchAt >= 0 ? { subagentId: state.subagentId, status: 'started' } : { pending: true },
          hint: 'SupAgent 持有 subagent 等编排工具，但 denied_tools 明确禁止 sql_query、describe_database 等业务工具。',
          evidence: ['agentops/agents/manager.yaml:25-40,52-73', 'packages/agentops/bundle/presets/agents.generated.patch.yml:138-149']
        },
        smart_query: {
          title: '智能问数 · smart_query', sub: 'depth 1 · workflow-owning Agent',
          input: { question: current().question, database: 'audit_reader' },
          output: state.runId ? { runId: state.runId, workflow: 'smart-query', status: state.finalStatus || 'running' } : { pending: true },
          hint: '第一动作必须是 dag_run。workflowId/yaml 不由模型决定；preset 钉定 ownedWorkflowId=smart-query。',
          evidence: ['agentops/agents/smart_query.yaml:18-40', 'packages/agentops/bundle/presets/agents.generated.patch.yml:376-384']
        }
      }[actor];
      $('insTitle').textContent = data.title;
      $('insSub').textContent = data.sub;
      $('insInput').textContent = fmt(data.input);
      $('insOutput').textContent = fmt(data.output);
      $('insHint').textContent = data.hint;
      $('insEvidence').innerHTML = data.evidence.map((x) => '<code>' + x + '</code>').join('');
    } else {
      const id = state.selectedNode;
      const meta = nodeMeta[id];
      const result = current().nodes[id];
      const now = state.nodeStates[id] || 'pending';
      $('insTitle').textContent = id + ' · ' + meta.role;
      $('insSub').textContent = 'node subagent · preset=smart_query · ' + nodeStateLabel(now);
      $('insInput').textContent = fmt(result.input);
      if (now === 'pending') $('insOutput').textContent = 'null  // 尚未结算';
      else if (now === 'running') $('insOutput').textContent = '{ "status": "running" }';
      else if (result.error) $('insOutput').textContent = fmt(result.output || { error: result.error });
      else $('insOutput').textContent = fmt(result.output);
      $('insHint').textContent = meta.hint + (result.error ? ' 运行时错误：' + result.error : '');
      $('insEvidence').innerHTML = meta.evidence.map((x) => '<code>' + x + '</code>').join('');
    }

    const checked = state.selectedActor
      ? (state.actorStates[state.selectedActor] || 'pending')
      : (state.nodeStates[state.selectedNode] || 'pending');
    const pill = $('insState');
    pill.className = 'state-pill';
    pill.textContent = nodeStateLabel(checked).toUpperCase();
    if (checked === 'running') pill.classList.add('run');
    else if (checked === 'completed' || checked === 'skip') pill.classList.add('ok');
    else if (checked === 'failed' || checked === 'skipped') pill.classList.add('err');
    document.querySelectorAll('.node-card').forEach((el) => el.classList.toggle('selected', !state.selectedActor && el.dataset.node === state.selectedNode));
    document.querySelectorAll('.actor-card').forEach((el) => el.classList.toggle('selected', state.selectedActor === el.dataset.actor));
  }

  function renderDagState() {
    const chip = $('dagChip');
    chip.classList.remove('on','green','red');
    if (!state.runId) { chip.textContent = 'DAG IDLE'; return; }
    if (state.finished && state.finalStatus === 'failed') { chip.textContent = 'DAG FAILED'; chip.classList.add('red'); }
    else if (state.finished) { chip.textContent = 'DAG COMPLETED'; chip.classList.add('green'); }
    else { chip.textContent = 'DAG RUNNING'; chip.classList.add('on'); }
  }

  function renderAll() {
    renderPipeline();
    renderMetrics();
    renderButtons();
    renderInspector();
    renderDagState();
  }

  function resetRun(keepScenario) {
    clearTimeout(state.timer);
    state.timer = 0;
    state.action = -1;
    state.playing = false;
    state.paused = false;
    state.finished = false;
    state.runId = '';
    state.subagentId = '';
    state.dispatchAt = -1;
    state.spawned = new Set();
    state.nodeStates = {};
    state.actorStates = {};
    state.stageStates = ['pending','pending','pending','pending','pending','pending'];
    state.finalStatus = '';
    state.selectedActor = '';
    state.selectedNode = 'route_intent';
    if (!keepScenario) state.scenario = 'normal';
    const s = current();
    $('questionText').textContent = s.question;
    $('scenarioNote').textContent = s.note;
    $('flowWarning').innerHTML = s.warning;
    $('subagentId').textContent = '—';
    $('subagentState').textContent = '尚未派发';
    $('runId').textContent = '—';
    $('depthChip').textContent = 'DEPTH 0 → 1 → 2';
    $('receiptBar').classList.remove('show');
    $('handoffBtn').disabled = true;
    setStatus('SIM READY');
    document.querySelectorAll('.node-card').forEach((el) => {
      el.dataset.state = 'pending';
      el.classList.remove('selected','flow-active');
      el.querySelector('.node-state').textContent = 'pending';
    });
    document.querySelectorAll('.actor-card').forEach((el) => { el.dataset.state = ''; el.classList.remove('selected'); });
    document.querySelectorAll('.scenario').forEach((el) => el.classList.toggle('active', el.dataset.scenario === state.scenario));
    $('userCard').dataset.state = 'pending';
    $('managerCard').dataset.state = 'pending';
    $('smartCard').dataset.state = 'pending';
    clearEvents();
    renderAll();
  }

  function finishRun() {
    const s = current();
    state.playing = false;
    state.paused = false;
    state.finished = true;
    state.finalStatus = s.runStatus;
    if (state.actorStates.manager !== undefined) setActor('manager', 'completed');
    if (s.runStatus === 'failed') setStatus('SIM RUN FAILED', 'red');
    else setStatus('SIM RUN COMPLETED');
    $('subagentState').textContent = s.subagentState === 'failed' ? 'failed · 已回投' : 'completed · 已回投';
    const skipped = Object.values(state.nodeStates).filter((v) => v === 'skip' || v === 'skipped').length;
    const failed = Object.values(state.nodeStates).filter((v) => v === 'failed').length;
    $('receiptTitle').textContent = 'smart_query · ' + s.runStatus;
    $('receiptDesc').textContent = state.runId + ' · 5 node declarations · ' + failed + ' failed / ' + skipped + ' skipped';
    $('receiptBar').classList.add('show');
    $('handoffBtn').disabled = false;
    $('depthChip').textContent = 'DEPTH 2 MAX';
    renderAll();
  }

  function performNext() {
    if (state.finished) return;
    const index = state.action + 1;
    const list = timeline();
    if (index >= list.length) { finishRun(); return; }
    state.action = index;
    const item = list[index];
    if (item.actor) setActor(item.actor[0], item.actor[1]);
    if (item.dispatch) {
      state.dispatchAt = index;
      state.subagentId = newSimId('sa');
      $('subagentId').textContent = state.subagentId;
      $('subagentState').textContent = 'running · 句柄已返回';
      $('userToSupAgent').classList.add('active');
      document.querySelector('.delegate-link')?.classList.add('active');
    }
    if (item.dag) {
      state.runId = 'smart-query@' + newSimId('run');
      $('runId').textContent = state.runId;
      $('dagChip').textContent = 'DAG RUNNING';
      $('dagChip').classList.remove('green','red');
      $('dagChip').classList.add('on');
      $('smartToDag').classList.add('active');
    }
    if (item.node) setNode(item.node[0], item.node[1]);
    if (item.managerFinal) setActor('manager', 'completed');
    markStages(item.stage, item.stageState === 'error' ? 'error' : undefined);
    const tone = item.stageState === 'error' ? 'err' : (item.type === 'skip' ? 'warn' : (item.type === 'result' ? 'ok' : ''));
    addEvent(item.type, item.message, tone);
    renderAll();
    if (index >= list.length - 1) finishRun();
  }

  function scheduleNext() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!state.playing) return;
      performNext();
      if (!state.finished && state.playing) scheduleNext();
    }, 310);
  }

  function startOrResume() {
    if (state.finished || state.action < 0) resetRun(true);
    state.playing = true;
    state.paused = false;
    setStatus('SIM RUNNING', 'warn');
    renderButtons();
    scheduleNext();
  }

  function pauseRun() {
    clearTimeout(state.timer);
    state.timer = 0;
    state.playing = false;
    state.paused = true;
    setStatus('SIM PAUSED · STEP ' + Math.max(0, state.action + 1) + '/' + timeline().length, 'warn');
    renderAll();
  }

  function stepRun() {
    clearTimeout(state.timer);
    state.timer = 0;
    state.playing = false;
    if (state.finished || state.action < 0) resetRun(true);
    state.paused = true;
    performNext();
    if (!state.finished) {
      setStatus('SIM PAUSED · STEP ' + (state.action + 1) + '/' + timeline().length, 'warn');
      renderAll();
    }
  }

  $('runBtn').addEventListener('click', () => {
    if (state.playing) pauseRun();
    else startOrResume();
  });
  $('stepBtn').addEventListener('click', stepRun);
  $('resetBtn').addEventListener('click', () => resetRun(true));

  document.querySelectorAll('.scenario').forEach((button) => {
    button.addEventListener('click', () => {
      state.scenario = button.dataset.scenario;
      resetRun(true);
    });
  });

  document.querySelectorAll('.node-card').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedActor = '';
      state.selectedNode = button.dataset.node;
      renderInspector();
    });
  });

  document.querySelectorAll('.actor-card').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedActor = button.dataset.actor;
      renderInspector();
    });
  });

  $('handoffBtn').addEventListener('click', function () {
    const s = current();
    const result = s.nodes.present_result.output || { error: s.nodes.present_result.error || s.nodes.run_sql.error };
    const carry = {
      label: 'smart_query · ' + s.runStatus,
      runId: state.runId,
      subagentId: state.subagentId,
      workflow: 'smart-query',
      status: s.runStatus,
      nodes: 5,
      outputs: result,
      evidence: 'agentops/workflows/smart-query.yaml:20-139'
    };
    if (window.VT && typeof window.VT.handoff === 'function') window.VT.handoff('03', carry, this);
  });

  const incoming = window.VT && window.VT.carry;
  if (incoming) {
    const text = [incoming.label, incoming.workflow].filter(Boolean).join(' · ');
    $('carryText').textContent = text || '上下文已装载';
    $('carryChip').classList.add('show');
  }

  resetRun(true);
})();
