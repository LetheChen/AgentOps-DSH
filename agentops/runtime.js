/* ============================================================
   AgentOps 三章演示 · 公共运行时（classic script）
   离线 file:// 可直接运行；不依赖模块、CDN 或远程资源。
   ============================================================ */
(function (g) {
  'use strict';
  var CH = [
    { k: '01', name: '能力地图', hint: 'manager · smart_query · dag', file: '01-capabilities.html' },
    { k: '02', name: '跨 Agent 运行', hint: 'subagent → workflow → node', file: '02-runtime.html' },
    { k: '03', name: '治理边界', hint: 'policy · guard · limits', file: '03-governance.html' }
  ];
  var qs = new URLSearchParams(typeof g.__QS === 'string' ? g.__QS : location.search);
  function param(n, d) { var v = qs.get(n); return v === null ? d : v; }
  function enc(o) { return btoa(encodeURIComponent(JSON.stringify(o))); }
  function dec(s) { try { return JSON.parse(decodeURIComponent(atob(s))); } catch (e) { return null; } }
  var carry = dec(param('cw', ''));
  var inFrame = (function () { try { return g.top !== g.self; } catch (e) { return true; } })();
  var isShell = !inFrame && !!document.getElementById('tabs') && !!document.querySelector('iframe');

  function go(k, c, fly) {
    if (inFrame) {
      g.parent.postMessage({ type: 'vt:go', k: k, carry: c || null, fly: fly || null }, '*');
      return;
    }
    location.href = '../index.html#' + k;
  }

  function navAction(action) {
    if (inFrame) g.parent.postMessage({ type: 'vt:nav', action: action }, '*');
    else {
      if (action === 'home') location.href = '../index.html#01';
      else if (action === 'end') location.href = '../index.html#03';
      else if (action === 'prev') location.href = '../index.html#02';
      else if (action === 'next') location.href = '../index.html#02';
      else if (/^[123]$/.test(action)) location.href = '../index.html#' + action.padStart(2, '0');
    }
  }

  function bindChapterKeys() {
    if (isShell) return;
    g.addEventListener('keydown', function (e) {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      var action = '';
      if (e.key === '1' || e.key === '2' || e.key === '3') action = e.key;
      else if (e.key === 'ArrowRight') action = 'next';
      else if (e.key === 'ArrowLeft') action = 'prev';
      else if (e.key === 'Home') action = 'home';
      else if (e.key === 'End') action = 'end';
      if (!action) return;
      e.preventDefault();
      navAction(action);
    });
  }

  var CSS = [
    '#vt-hot{position:fixed;top:0;left:0;right:0;height:7px;z-index:2147483001}',
    '#vt-nav{position:fixed;top:5px;left:50%;z-index:2147483000;',
    'font:11px/1 -apple-system,"PingFang SC","Noto Sans SC",system-ui,sans-serif;color:#9fb4c2;',
    'display:flex;align-items:center;gap:1px;padding:3px 4px;border-radius:999px;',
    'background:rgba(8,12,16,.86);border:1px solid rgba(120,170,195,.28);',
    'box-shadow:0 8px 26px rgba(0,0,0,.45);backdrop-filter:blur(8px);',
    'transform:translate(-50%,-160%);opacity:0;pointer-events:none;transition:transform .22s ease,opacity .22s ease}',
    '#vt-nav.show{transform:translate(-50%,0);opacity:1;pointer-events:auto}',
    '#vt-nav button{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:4px 7px;border-radius:999px;line-height:1}',
    '#vt-nav button:hover{background:rgba(57,215,255,.16);color:#39d7ff}',
    '#vt-nav .n{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;letter-spacing:.06em;padding:0 3px}',
    '#vt-nav .n b{font-weight:600;color:#39d7ff}',
    '#vt-nav .l{position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);display:none;',
    'flex-direction:column;gap:1px;padding:5px;background:rgba(8,12,16,.96);',
    'border:1px solid rgba(120,170,195,.25);border-radius:10px;white-space:nowrap;box-shadow:0 12px 34px rgba(0,0,0,.5)}',
    '#vt-nav:hover .l{display:flex}',
    '#vt-nav .l a{color:#9fb4c2;text-decoration:none;padding:6px 10px;border-radius:6px;display:flex;gap:9px;align-items:center}',
    '#vt-nav .l a:hover{background:rgba(57,215,255,.13);color:#d6e7ef}',
    '#vt-nav .l a.on{color:#39d7ff}',
    '#vt-nav .l i{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-style:normal;font-size:9.5px;color:#5c7381}'
  ].join('');

  function nav() {
    if (inFrame || isShell || g.VT_NO_NAV || document.getElementById('vt-nav')) return;
    var here = location.pathname.split('/').pop();
    var i = 0;
    for (var n = 0; n < CH.length; n++) if (CH[n].file === here) i = n;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var hot = document.createElement('div'); hot.id = 'vt-hot';
    var d = document.createElement('div'); d.id = 'vt-nav';
    d.innerHTML = '<button data-d="-1" title="上一章">‹</button>'
      + '<span class="n"><b>' + CH[i].k + '</b> / ' + CH.length + '</span>'
      + '<button data-d="1" title="下一章">›</button>'
      + '<div class="l">' + CH.map(function (c, k) {
        return '<a href="../index.html#' + c.k + '" class="' + (k === i ? 'on' : '') + '">' + c.k + ' ' + c.name + '<i>' + c.hint + '</i></a>';
      }).join('') + '</div>';
    d.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        var t = i + (+b.dataset.d);
        if (t < 0 || t >= CH.length) return;
        location.href = '../index.html#' + CH[t].k;
      };
    });
    var timer = 0;
    function show(ms){ d.classList.add('show'); clearTimeout(timer); if(ms !== 0) timer = setTimeout(hide, ms || 4200); }
    function hide(){ d.classList.remove('show'); }
    hot.addEventListener('mouseenter', function(){ show(0); });
    d.addEventListener('mouseenter', function(){ clearTimeout(timer); });
    d.addEventListener('mouseleave', hide);
    document.body.appendChild(hot); document.body.appendChild(d);
    setTimeout(function(){ show(2600); }, 650);
  }

  g.VT = {
    CH: CH, param: param, carry: carry, go: go, nav: nav, inFrame: inFrame,
    enc: enc, dec: dec, bindChapterKeys: bindChapterKeys,
    handoff: function(k, c, el){ var r = el && el.getBoundingClientRect(); go(k, c, r ? {x:r.left+r.width/2,y:r.top+r.height/2} : null); }
  };
  bindChapterKeys();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', nav);
  else nav();
})(window);
