/* ============================================================
 * CodePilot 主应用逻辑 (app.js)
 * 串联编辑器 / 诊断 / 修复 / 高亮 / 交互
 * ============================================================ */

(function () {
    'use strict';

    /* ---- DOM 引用 ---- */
    const $ = (id) => document.getElementById(id);
    const codeInput = $('codeInput');
    const codeHighlight = $('codeHighlight').querySelector('code');
    const gutter = $('gutter');
    const editorWrap = $('editorWrap');
    const langSelect = $('langSelect');
    const btnDiagnose = $('btnDiagnose');
    const btnFixAll = $('btnFixAll');
    const btnSample = $('btnSample');
    const btnClear = $('btnClear');
    const btnCopy = $('btnCopy');
    const resultList = $('resultList');
    const resultInfo = $('resultInfo');
    const statusCursor = $('statusCursor');
    const statusCount = $('statusCount');
    const statusMsg = $('statusMsg');
    const editorInfo = $('editorInfo');
    const sumErrors = $('sumErrors');
    const sumWarnings = $('sumWarnings');
    const sumHints = $('sumHints');
    const sumFixable = $('sumFixable');
    const fixModal = $('fixModal');
    const diffBefore = $('diffBefore');
    const diffAfter = $('diffAfter');
    const btnApplyFix = $('btnApplyFix');
    const btnDismissFix = $('btnDismissFix');
    const modalClose = $('modalClose');
    const toastEl = $('toast');
    const btnUndo = $('btnUndo');

    let currentIssues = [];
    let pendingFixedCode = null;

    /* ---- 撤销历史栈（针对修复/清空/载入示例等"批量改动"）---- */
    const undoStack = [];
    const MAX_UNDO = 50;
    function pushHistory() {
        undoStack.push(codeInput.value);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        btnUndo.disabled = false;
    }
    function undo() {
        if (undoStack.length === 0) return;
        codeInput.value = undoStack.pop();
        updateHighlight();
        btnUndo.disabled = undoStack.length === 0;
        currentIssues = [];
        renderResults();
        btnFixAll.disabled = true;
        statusMsg.textContent = '已撤销';
        toast('已撤销', 'success');
    }

    /* ---- 示例代码 ---- */
    const SAMPLES = {
        python: `# 这是一个包含多处错误的 Python 代码，点击「开始诊断」试试
def calculate_average(numbers
    total = 0
    for i in range(len(numbers))
        total += numbers[i]

    if total = 0
        Print("警告：总和为零")

    return total / 0

class DataProcessor:
    def __init__(self):
        self.items = []

    def add_item(self, x=[]):
        self.items.append(x)

    def get_count(self)
        return len(self.items)

result = calculate_average([10, 20, 30])
print("结果是: " + str(result))`,
        javascript: `// 包含多处错误的 JavaScript 代码
function sum(arr) {
    let total = 0
    for (let i = 0; i < arr.lenght; i++) {
        total += arr[i]
    }
    return total
}

if (total = 0) {
    Console.log("零")
}

const result = sum([1, 2, 3])
console.log("结果: " + result)`,
    };

    /* ---- 关键字表 ---- */
    const KEYWORDS = {
        python: ['def','class','if','elif','else','for','while','return','import','from','as','with','try','except','finally','raise','pass','break','continue','in','not','and','or','is','None','True','False','lambda','yield','global','nonlocal','del','assert','async','await','print'],
        javascript: ['var','let','const','function','return','if','else','for','while','do','switch','case','break','continue','new','this','class','extends','super','import','export','default','async','await','try','catch','finally','throw','typeof','instanceof','in','of','null','undefined','true','false','console'],
    };
    const BUILTINS = {
        python: ['len','range','print','str','int','float','list','dict','set','tuple','abs','max','min','sum','sorted','enumerate','zip','map','filter','open','input','type','isinstance','append'],
        javascript: ['Math','Array','Object','String','Number','Boolean','JSON','console','document','window','length','push','pop','slice','map','filter','reduce','forEach'],
    };

    /* ---- HTML 转义 ---- */
    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* ---- 语法高亮 ---- */
    function highlight(code, lang) {
        if (!code) return '';
        const kw = KEYWORDS[lang] || [];
        const bi = BUILTINS[lang] || [];
        const patterns = [
            { type: 'com', re: lang === 'python' ? /#[^\n]*/g : /\/\/[^\n]*/g },
            { type: 'str', re: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g },
            { type: 'num', re: /\b\d+\.?\d*\b/g },
            { type: 'kw', re: new RegExp(`\\b(${kw.join('|')})\\b`, 'g') },
            { type: 'builtin', re: new RegExp(`\\b(${bi.join('|')})\\b`, 'g') },
        ];
        const ranges = [];
        for (const { type, re } of patterns) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(code)) !== null) {
                ranges.push({ start: m.index, end: m.index + m[0].length, type, text: m[0] });
                if (m[0].length === 0) re.lastIndex++;
            }
        }
        ranges.sort((a, b) => a.start - b.start || b.end - a.end);
        const filtered = [];
        let lastEnd = 0;
        for (const r of ranges) {
            if (r.start >= lastEnd) { filtered.push(r); lastEnd = r.end; }
        }
        let html = '';
        let pos = 0;
        for (const r of filtered) {
            if (r.start > pos) html += esc(code.substring(pos, r.start));
            html += `<span class="tok-${r.type}">${esc(r.text)}</span>`;
            pos = r.end;
        }
        if (pos < code.length) html += esc(code.substring(pos));
        return html;
    }

    /* ---- 更新行号 ---- */
    function updateGutter() {
        const lines = codeInput.value.split('\n');
        const issueLines = new Map(); // line -> severity
        for (const iss of currentIssues) {
            const sev = iss.severity;
            const cur = issueLines.get(iss.line);
            if (!cur || (cur === 'hint' && sev === 'warning') || (cur !== 'error' && sev === 'error')) {
                issueLines.set(iss.line, sev);
            }
        }
        let html = '';
        for (let i = 1; i <= lines.length; i++) {
            const sev = issueLines.get(i);
            const cls = sev ? ` ${sev}` : '';
            html += `<div class="gutter-line${cls}">${i}</div>`;
        }
        gutter.innerHTML = html;
        statusCount.textContent = `${lines.length} 行`;
    }

    /* ---- 更新高亮层 ----
     * 输入时逐字符重绘整段代码，大文件会明显卡顿，
     * 这里用 requestAnimationFrame 合并同一帧内的多次输入事件。
     */
    let highlightPending = false;
    function updateHighlight() {
        if (highlightPending) return;
        highlightPending = true;
        requestAnimationFrame(() => {
            highlightPending = false;
            const code = codeInput.value;
            codeHighlight.innerHTML = highlight(code, langSelect.value) + '\n';
            updateGutter();
        });
    }

    /* ---- 同步滚动 ----
     * 原实现把滚动同步到 .code-area（overflow:hidden，实际不滚动），
     * 高亮层因此不会跟随，滚动后语法高亮与文字错位。
     * 这里直接同步高亮层自身。
     */
    codeInput.addEventListener('scroll', () => {
        const hl = $('codeHighlight');
        hl.scrollTop = codeInput.scrollTop;
        hl.scrollLeft = codeInput.scrollLeft;
        gutter.scrollTop = codeInput.scrollTop;
    });

    /* ---- 输入事件 ---- */
    codeInput.addEventListener('input', updateHighlight);

    /* ---- Tab 键插入 4 空格 ---- */
    codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const s = codeInput.selectionStart, en = codeInput.selectionEnd;
            const val = codeInput.value;
            codeInput.value = val.substring(0, s) + '    ' + val.substring(en);
            codeInput.selectionStart = codeInput.selectionEnd = s + 4;
            updateHighlight();
        }
    });

    /* ---- 光标位置 ---- */
    function updateCursor() {
        const pos = codeInput.selectionStart;
        const before = codeInput.value.substring(0, pos);
        const line = before.split('\n').length;
        const col = pos - before.lastIndexOf('\n');
        statusCursor.textContent = `行 ${line}, 列 ${col}`;
    }
    codeInput.addEventListener('click', updateCursor);
    codeInput.addEventListener('keyup', updateCursor);

    /* ---- Toast ---- */
    let toastTimer = null;
    function toast(msg, type = '') {
        toastEl.textContent = msg;
        toastEl.className = 'toast show ' + type;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.className = 'toast ' + type; }, 2200);
    }

    /* ---- 执行诊断 ---- */
    function runDiagnose() {
        const code = codeInput.value;
        const lang = langSelect.value;
        if (!code.trim()) {
            toast('请先输入代码', 'error');
            return;
        }
        statusMsg.textContent = '诊断中...';
        const t0 = performance.now();
        currentIssues = engine.diagnose(code, lang);
        const dt = (performance.now() - t0).toFixed(1);
        renderResults();
        const errs = currentIssues.filter(i => i.severity === 'error').length;
        const fixable = CodeFixer.countFixable(currentIssues);
        btnFixAll.disabled = fixable === 0;
        if (currentIssues.length === 0) {
            statusMsg.textContent = `✓ 未发现问题 (${dt}ms)`;
            editorInfo.textContent = '代码健康';
            toast('未发现任何问题，代码很棒！', 'success');
        } else {
            statusMsg.textContent = `发现 ${currentIssues.length} 个问题 (${dt}ms)`;
            editorInfo.textContent = `${errs} 错误 / ${fixable} 可修复`;
        }
        updateHighlight();
    }

    /* ---- 渲染诊断结果列表 ---- */
    function renderResults() {
        const issues = currentIssues;
        const errs = issues.filter(i => i.severity === 'error').length;
        const warns = issues.filter(i => i.severity === 'warning').length;
        const hints = issues.filter(i => i.severity === 'hint').length;
        const fixable = CodeFixer.countFixable(issues);
        sumErrors.textContent = errs;
        sumWarnings.textContent = warns;
        sumHints.textContent = hints;
        sumFixable.textContent = fixable;
        resultInfo.textContent = `${issues.length} 个问题`;

        if (issues.length === 0) {
            resultList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">✓</div>
                    <p>代码检查通过，没有发现问题</p>
                    <p class="empty-tip">继续保持良好的编码习惯</p>
                </div>`;
            return;
        }

        let html = '';
        for (let idx = 0; idx < issues.length; idx++) {
            const iss = issues[idx];
            const sev = iss.severity;
            const loc = `第 ${iss.line} 行, 第 ${iss.column} 列`;
            const evidenceHtml = iss.evidence ? `<div class="issue-evidence">${formatEvidence(iss)}</div>` : '';
            const fixHtml = iss.fix ? `
                <div class="issue-fix">
                    <span class="fix-suggestion">${esc(iss.fix.description)}</span>
                    ${iss.fix.apply ? `<button class="fix-btn" data-idx="${idx}">修复</button>` : ''}
                </div>` : '';
            html += `
                <div class="issue-item severity-${sev}" data-idx="${idx}" data-line="${iss.line}">
                    <div class="issue-head">
                        <span class="issue-badge ${sev}">${sev === 'error' ? '错误' : sev === 'warning' ? '警告' : '建议'}</span>
                        <span class="issue-rule">${iss.rule} · ${esc(iss.name)}</span>
                        <span class="issue-loc">${loc}</span>
                    </div>
                    <div class="issue-msg">${esc(iss.message)}</div>
                    ${evidenceHtml}
                    ${fixHtml}
                </div>`;
        }
        resultList.innerHTML = html;

        // 绑定点击事件
        resultList.querySelectorAll('.issue-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('fix-btn')) return;
                const line = parseInt(el.dataset.line, 10);
                jumpToLine(line);
            });
        });
        resultList.querySelectorAll('.fix-btn').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(el.dataset.idx, 10);
                applySingleFix(idx);
            });
        });
    }

    /* ---- 格式化证据行，高亮出错列 ---- */
    function formatEvidence(iss) {
        if (!iss.evidence) return '';
        const line = iss.evidence;
        const col = iss.column - 1;
        const end = (iss.endColumn - 1) || (col + 1);
        if (col < 0 || col >= line.length) return esc(line);
        return esc(line.substring(0, col)) +
            `<span class="marker">${esc(line.substring(col, end))}</span>` +
            esc(line.substring(end));
    }

    /* ---- 跳转到指定行 ---- */
    function jumpToLine(line) {
        const lines = codeInput.value.split('\n');
        let pos = 0;
        for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
        codeInput.focus();
        codeInput.selectionStart = pos;
        codeInput.selectionEnd = pos + (lines[line - 1] || '').length;
        // 滚动到可见
        const lineHeight = 21;
        codeInput.scrollTop = Math.max(0, (line - 1) * lineHeight - codeInput.clientHeight / 2);
        updateCursor();
    }

    /* ---- 应用单条修复 ---- */
    function applySingleFix(idx) {
        const iss = currentIssues[idx];
        if (!iss || !iss.fix) return;
        const before = codeInput.value;
        const after = CodeFixer.applyFix(before, iss);
        if (after === before) {
            toast('该修复未能改变代码', 'error');
            return;
        }
        showFixModal(before, after, `已应用规则 ${iss.rule}：${iss.name}`);
        pendingFixedCode = after;
    }

    /* ---- 一键修复 ---- */
    function fixAll() {
        const code = codeInput.value;
        const lang = langSelect.value;
        statusMsg.textContent = '正在批量修复...';
        const t0 = performance.now();
        const result = CodeFixer.fixAll(code, lang);
        const dt = (performance.now() - t0).toFixed(1);
        if (result.fixedCount === 0) {
            if (result.remainingIssues.length > 0) {
                toast('剩余 ' + result.remainingIssues.length + ' 个问题均无法自动修复，请手动处理', 'error');
                statusMsg.textContent = '剩余问题不可自动修复';
            } else {
                toast('没有可自动修复的问题', 'error');
                statusMsg.textContent = '无可修复项';
            }
            return;
        }
        const hitLimit = result.hitLimit;
        const summary = hitLimit
            ? `已修复 ${result.fixedCount} 处，达到单次修复上限，剩余 ${result.remainingIssues.length} 个问题，应用后请再点一次一键修复继续`
            : `已修复 ${result.fixedCount} 处问题，剩余 ${result.remainingIssues.length} 个`;
        showFixModal(code, result.code, summary);
        pendingFixedCode = result.code;
        statusMsg.textContent = hitLimit
            ? `修复 ${result.fixedCount} 处，已达上限 (${dt}ms)`
            : `修复 ${result.fixedCount} 处 (${dt}ms)`;
        if (hitLimit) {
            toast('已达单次修复上限，应用后请再点一次「一键修复」继续', 'error');
        }
    }

    /* ---- 显示修复对比模态框 ---- */
    function showFixModal(before, after, summary) {
        const diff = CodeFixer.diff(before, after);
        let beforeHtml = '', afterHtml = '';
        for (const d of diff) {
            const text = esc(d.text || '');
            if (d.type === 'same') {
                beforeHtml += `${d.oldLine || ''}\t${text}\n`;
                afterHtml += `${d.newLine || ''}\t${text}\n`;
            } else if (d.type === 'del') {
                beforeHtml += `<span class="diff-line-del">${d.oldLine || ''}\t- ${text}</span>\n`;
            } else if (d.type === 'add') {
                afterHtml += `<span class="diff-line-add">${d.newLine || ''}\t+ ${text}</span>\n`;
            }
        }
        diffBefore.innerHTML = beforeHtml || '<span style="color:#6e7681">(无变化)</span>';
        diffAfter.innerHTML = afterHtml || '<span style="color:#6e7681">(无变化)</span>';
        // summary 之前被传入却从未显示，这里补上修复摘要
        const titleEl = fixModal.querySelector('.modal-header h2');
        if (titleEl) {
            titleEl.textContent = '修复结果对比';
            let sub = fixModal.querySelector('.modal-summary');
            if (!sub) {
                sub = document.createElement('p');
                sub.className = 'modal-summary';
                titleEl.insertAdjacentElement('afterend', sub);
            }
            sub.textContent = summary || '';
        }
        fixModal.classList.add('show');
    }

    function closeFixModal() {
        fixModal.classList.remove('show');
        pendingFixedCode = null;
    }

    /* ---- 应用修复到编辑器 ---- */
    function applyPendingFix() {
        if (pendingFixedCode === null) return;
        pushHistory();
        codeInput.value = pendingFixedCode;
        updateHighlight();
        closeFixModal();
        toast('已应用修复，重新诊断中...', 'success');
        runDiagnose();
    }

    /* ---- ESC 关闭模态框 ---- */
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && fixModal.classList.contains('show')) {
            closeFixModal();
        }
    });

    /* ---- 事件绑定 ---- */
    btnDiagnose.addEventListener('click', runDiagnose);
    btnFixAll.addEventListener('click', fixAll);
    btnSample.addEventListener('click', () => {
        pushHistory();
        codeInput.value = SAMPLES[langSelect.value] || SAMPLES.python;
        updateHighlight();
        currentIssues = [];
        renderResults();
        btnFixAll.disabled = true;
        statusMsg.textContent = '已载入示例代码';
        editorInfo.textContent = '就绪';
        toast('已载入示例代码，点击「开始诊断」', 'success');
    });
    btnClear.addEventListener('click', () => {
        pushHistory();
        codeInput.value = '';
        updateHighlight();
        currentIssues = [];
        renderResults();
        btnFixAll.disabled = true;
        statusMsg.textContent = '已清空';
        editorInfo.textContent = '就绪';
        codeInput.focus();
    });
    btnCopy.addEventListener('click', async () => {
        if (!codeInput.value) { toast('编辑器为空', 'error'); return; }
        try {
            await navigator.clipboard.writeText(codeInput.value);
            toast('已复制到剪贴板', 'success');
        } catch {
            codeInput.select();
            document.execCommand('copy');
            toast('已复制', 'success');
        }
    });
    langSelect.addEventListener('change', () => {
        updateHighlight();
        currentIssues = [];
        renderResults();
        btnFixAll.disabled = true;
        statusMsg.textContent = `已切换到 ${langSelect.value === 'python' ? 'Python' : 'JavaScript'}`;
    });
    btnApplyFix.addEventListener('click', applyPendingFix);
    btnDismissFix.addEventListener('click', closeFixModal);
    modalClose.addEventListener('click', closeFixModal);
    fixModal.querySelector('.modal-mask').addEventListener('click', closeFixModal);
    btnUndo.addEventListener('click', undo);

    // Ctrl+Z 撤销 / Ctrl+Enter 诊断
    codeInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            if (undoStack.length > 0) { e.preventDefault(); undo(); }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            runDiagnose();
        }
    });

    /* ---- 初始化 ---- */
    updateHighlight();
    codeInput.focus();
})();