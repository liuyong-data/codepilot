/* ============================================================
 * CodePilot 诊断引擎核心 (diagnostic-engine.js)
 * 提供通用辅助函数 + 规则注册/调度框架
 * ============================================================ */

/* ---- 诊断结果数据结构 ----
 * {
 *   severity: 'error' | 'warning' | 'hint',
 *   rule:     规则 ID（如 PY001）
 *   name:     规则名称
 *   message:  面向用户的错误描述
 *   line:     起始行号 (1-based)
 *   column:   起始列号 (1-based)
 *   endLine:  结束行号
 *   endColumn:结束列号
 *   evidence: 出错代码片段（用于展示）
 *   fix: { description, apply(lines)->lines } | null
 * }
 */

class DiagnosticEngine {
    constructor() {
        this.rules = {}; // { language: [rule, ...] }
    }

    register(language, rule) {
        if (!this.rules[language]) this.rules[language] = [];
        this.rules[language].push(rule);
    }

    diagnose(code, language) {
        const { lines } = Utils.splitLines(code);
        const issues = [];
        const ruleList = this.rules[language] || [];
        // 只扫描一次，得到「等长掩码」：字符串/注释位置被替换为空格，列号与原文严格对齐
        const ctx = Utils.scan(lines, language);
        for (const rule of ruleList) {
            let result;
            try {
                result = rule.run(lines, code, ctx) || [];
            } catch (e) {
                console.warn(`规则 ${rule.id} 执行出错:`, e);
                result = [];
            }
            for (const issue of result) {
                issue.rule = rule.id;
                issue.name = rule.name;
                if (!issue.severity) issue.severity = 'error';
                if (!issue.endLine) issue.endLine = issue.line;
                if (!issue.endColumn) issue.endColumn = issue.column + 1;
                if (!issue.evidence && lines[issue.line - 1] !== undefined) {
                    issue.evidence = lines[issue.line - 1];
                }
                issues.push(issue);
            }
        }
        // 按行号、列号排序
        issues.sort((a, b) => a.line - b.line || a.column - b.column);
        return DiagnosticEngine.dedupe(issues);
    }

    /* 去重：同一位置被多条规则命中时，只保留更「具体」的一条，
     * 避免 "Print" 同时被 PY005（拼写）和 PY019（未定义名字）报两次。 */
    static dedupe(issues) {
        const genericRules = new Set(['PY019']);
        const seen = new Map();
        const out = [];
        for (const issue of issues) {
            const key = `${issue.line}:${issue.column}`;
            const prev = seen.get(key);
            if (!prev) {
                seen.set(key, issue);
                out.push(issue);
                continue;
            }
            // 同一位置：优先保留非「通用启发式」规则
            if (genericRules.has(prev.rule) && !genericRules.has(issue.rule)) {
                const idx = out.indexOf(prev);
                if (idx >= 0) out[idx] = issue;
                seen.set(key, issue);
            }
        }
        return out;
    }
}

/* ============================================================
 * 通用辅助函数（供各语言规则复用）
 * ============================================================ */
const Utils = {
    /* ---- 按行切分，兼容 CRLF / CR ----
     * 关键：Windows 换行 \r\n 若只按 \n 切分，每行末尾会残留 \r，
     * 导致「行尾补字符」类修复补到 \r 之后，下一轮诊断依然认为未闭合，
     * 形成无限累加（例如括号越补越多）。这里统一剥离行尾 \r，
     * 并返回原始换行符以便修复后原样还原。
     */
    splitLines(code) {
        const eol = code.includes('\r\n') ? '\r\n' : '\n';
        const normalized = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        return { lines: normalized.split('\n'), eol, hadCR: /\r/.test(code) };
    },

    /* 把行数组还原成代码字符串（与 splitLines 配套） */
    joinLines(lines, eol) {
        return lines.join(eol || '\n');
    },

    /* ---- 全文件扫描：产出等长掩码 ----
     * 返回 {
     *   masks:        string[]，与 lines 等长；masks[i] 与 lines[i] 等长，
     *                 属于字符串/注释的字符为 ' '，其余保持原字符。
     *   unterminated: [{line, column, quote}] 未闭合的字符串
     * }
     * 列号与原文严格一一对应，彻底避免 indexOf 错位问题。
     */
    scan(lines, lang) {
        const isPy = lang === 'python';
        const n = lines.length;
        // 用 Uint8Array 做「是否被抹掉」的标记，比 split('') 生成字符数组快一个数量级
        const marks = new Array(n);
        for (let i = 0; i < n; i++) marks[i] = new Uint8Array(lines[i].length);
        const unterminated = [];

        const blank = (l, from, to) => {
            const row = marks[l];
            if (!row) return;
            const s = Math.max(0, from);
            const e = Math.min(to, row.length);
            for (let k = s; k < e; k++) row[k] = 1;
        };

        let li = 0, ci = 0;
        while (li < n) {
            const raw = lines[li];
            if (ci >= raw.length) { li++; ci = 0; continue; }
            const ch = raw[ci];

            /* ---- 行注释 ---- */
            if (isPy ? ch === '#' : (ch === '/' && raw[ci + 1] === '/')) {
                blank(li, ci, raw.length);
                li++; ci = 0;
                continue;
            }

            /* ---- 块注释 (仅 JS) ---- */
            if (!isPy && ch === '/' && raw[ci + 1] === '*') {
                const startLine = li, startCol = ci;
                let closed = false;
                while (li < n) {
                    const end = lines[li].indexOf('*/', li === startLine ? ci + 2 : 0);
                    if (end === -1) {
                        blank(li, li === startLine ? ci : 0, lines[li].length);
                        li++; ci = 0;
                    } else {
                        blank(li, li === startLine ? ci : 0, end + 2);
                        ci = end + 2;
                        closed = true;
                        break;
                    }
                }
                if (!closed) unterminated.push({ line: startLine + 1, column: startCol + 1, quote: '/*' });
                continue;
            }

            /* ---- 正则字面量 (仅 JS，尽力而为) ---- */
            if (!isPy && ch === '/' && raw[ci + 1] !== '/' && raw[ci + 1] !== '*') {
                let prev = '';
                for (let k = ci - 1; k >= 0; k--) {
                    if (raw[k] !== ' ' && raw[k] !== '\t') { prev = raw[k]; break; }
                }
                if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) {
                    let k = ci + 1, inClass = false, ok = false;
                    while (k < raw.length) {
                        const c2 = raw[k];
                        if (c2 === '\\') { k += 2; continue; }
                        if (c2 === '[') inClass = true;
                        else if (c2 === ']') inClass = false;
                        else if (c2 === '/' && !inClass) { ok = true; break; }
                        k++;
                    }
                    if (ok) {
                        blank(li, ci, k + 1);
                        ci = k + 1;
                        while (ci < raw.length && /[gimsuy]/.test(raw[ci])) ci++;
                        continue;
                    }
                }
            }

            /* ---- 字符串 ---- */
            const isQuote = ch === '"' || ch === "'" || (!isPy && ch === '`');
            if (isQuote) {
                let prefixStart = ci;
                if (isPy) {
                    let p = ci;
                    while (p > 0 && /[A-Za-z]/.test(raw[p - 1]) && ci - p < 2) p--;
                    const prefix = raw.slice(p, ci).toLowerCase();
                    if (['', 'r', 'u', 'b', 'f', 'br', 'rb', 'fr', 'rf'].includes(prefix) &&
                        !(p > 0 && /\w/.test(raw[p - 1]))) {
                        prefixStart = p;
                    }
                }

                const triple = raw.substr(ci, 3) === ch + ch + ch;
                const term = triple ? ch + ch + ch : ch;
                const startLine = li, startCol = ci;
                blank(li, prefixStart, ci + term.length);
                ci += term.length;

                let closed = false;
                while (li < n) {
                    const row = lines[li];
                    let k = ci;
                    let hit = -1;
                    while (k < row.length) {
                        if (row[k] === '\\') { k += 2; continue; }
                        if (row.startsWith(term, k)) { hit = k; break; }
                        k++;
                    }
                    if (hit !== -1) {
                        blank(li, ci, hit + term.length);
                        ci = hit + term.length;
                        closed = true;
                        break;
                    }
                    blank(li, ci, row.length);
                    if (!triple && ch !== '`') {
                        // 单行字符串不允许换行：判定为未闭合
                        unterminated.push({ line: startLine + 1, column: startCol + 1, quote: ch });
                        ci = row.length;
                        break;
                    }
                    li++; ci = 0;
                }
                if (!closed && (triple || ch === '`')) {
                    unterminated.push({ line: startLine + 1, column: startCol + 1, quote: ch });
                }
                continue;
            }

            ci++;
        }

        // 还原为「等长掩码字符串」
        const masks = new Array(n);
        for (let i = 0; i < n; i++) {
            const row = marks[i];
            const src = lines[i];
            let out = '';
            let run = 0; // 连续未标记区间的起点
            for (let k = 0; k < src.length; k++) {
                if (row[k]) {
                    if (run < k) out += src.substring(run, k);
                    out += ' ';
                    run = k + 1;
                }
            }
            if (run < src.length) out += src.substring(run);
            masks[i] = out;
        }

        return { masks, unterminated };
    },

    /* 单行版（兼容旧调用）
     * 返回 { code, stringRanges, commentStart }
     * code 与原文等长（字符串/注释被替换为空格），列号可直接使用
     */
    stripStringsAndComments(line, lang) {
        // 直接对单行做轻量扫描，避免为了解析一行而构造整个 scan 结构
        const masked = Utils._maskLine(line, lang);
        const stringRanges = [];
        let start = -1;
        for (let i = 0; i <= line.length; i++) {
            const blanked = i < line.length && masked[i] === ' ' && line[i] !== ' ';
            if (blanked && start === -1) start = i;
            if (!blanked && start !== -1) { stringRanges.push([start, i - 1]); start = -1; }
        }
        let commentStart = -1;
        for (let i = 0; i < line.length; i++) {
            if (masked[i] !== ' ' || line[i] === ' ') continue;
            if (lang === 'python' && line[i] === '#') { commentStart = i; break; }
            if (lang === 'javascript' && line[i] === '/' && line[i + 1] === '/') { commentStart = i; break; }
        }
        return { code: masked, stringRanges, commentStart };
    },

    /* 单行掩码：处理引号与行注释，够用即可（不做跨行） */
    _maskLine(line, lang) {
        const isPy = lang === 'python';
        const out = line.split('');
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            if (isPy ? ch === '#' : (ch === '/' && line[i + 1] === '/')) {
                for (let k = i; k < line.length; k++) out[k] = ' ';
                break;
            }
            if (ch === '"' || ch === "'" || (!isPy && ch === '`')) {
                const triple = line.substr(i, 3) === ch + ch + ch;
                const term = triple ? ch + ch + ch : ch;
                let k = i + term.length;
                let hit = -1;
                while (k < line.length) {
                    if (line[k] === '\\') { k += 2; continue; }
                    if (line.startsWith(term, k)) { hit = k; break; }
                    k++;
                }
                const end = hit === -1 ? line.length : hit + term.length;
                for (let m = i; m < end; m++) out[m] = ' ';
                i = end;
                continue;
            }
            i++;
        }
        return out.join('');
    },

    /* 括号匹配检查
     * 返回：[{type:'mismatch'|'unclosed'|'extra', char, line, column, expected?}]
     */
    checkBrackets(lines, lang, ctx) {
        const pairs = { ')': '(', ']': '[', '}': '{' };
        const opens = '([{';
        const stack = []; // {char, line, column}
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, lang).masks;
        for (let l = 0; l < lines.length; l++) {
            const code = masks[l] !== undefined ? masks[l] : lines[l];
            for (let c = 0; c < code.length; c++) {
                const ch = code[c];
                if (opens.includes(ch)) {
                    stack.push({ char: ch, line: l + 1, column: c + 1 });
                } else if (pairs[ch]) {
                    if (stack.length === 0) {
                        issues.push({ type: 'extra', char: ch, line: l + 1, column: c + 1 });
                    } else if (stack[stack.length - 1].char !== pairs[ch]) {
                        // 报告后弹栈，避免一个错误引发后续连环报错
                        issues.push({
                            type: 'mismatch', char: ch, line: l + 1, column: c + 1,
                            expected: Utils.closeOf(stack[stack.length - 1].char),
                        });
                        stack.pop();
                    } else {
                        stack.pop();
                    }
                }
            }
        }
        for (const item of stack) {
            issues.push({ type: 'unclosed', char: item.char, line: item.line, column: item.column, expected: Utils.closeOf(item.char) });
        }
        return issues;
    },

    closeOf(open) { return { '(': ')', '[': ']', '{': '}' }[open] || open; },

    /* 判断字符是否可作为标识符的一部分 */
    isIdentChar(ch) { return /[A-Za-z0-9_]/.test(ch); },

    /* 提取某行某列开始的标识符 token */
    tokenAt(line, column) {
        if (!line) return '';
        let s = column - 1;
        while (s > 0 && Utils.isIdentChar(line[s - 1])) s--;
        let e = s;
        while (e < line.length && Utils.isIdentChar(line[e])) e++;
        return line.substring(s, e);
    },

    /* 计算行首缩进：返回 { spaces, tabs, mixed, total } */
    indentOf(line) {
        let spaces = 0, tabs = 0;
        for (const ch of line) {
            if (ch === ' ') spaces++;
            else if (ch === '\t') tabs++;
            else break;
        }
        return { spaces, tabs, mixed: spaces > 0 && tabs > 0, total: spaces + tabs };
    },

    /* 构造修复函数：替换指定行指定区间的文本（列号 1-based） */
    replaceRange(lineIdx, startCol, endCol, newText) {
        return (lines) => {
            const out = lines.slice();
            if (out[lineIdx] !== undefined) {
                const l = out[lineIdx];
                out[lineIdx] = l.substring(0, startCol - 1) + newText + l.substring(endCol - 1);
            }
            return out;
        };
    },

    /* 构造修复函数：整行替换 */
    replaceLine(lineIdx, newLine) {
        return (lines) => {
            const out = lines.slice();
            out[lineIdx] = newLine;
            return out;
        };
    },

    /* 构造修复函数：在指定行列插入文本 */
    insertAt(lineIdx, column, text) {
        return (lines) => {
            const out = lines.slice();
            if (out[lineIdx] !== undefined) {
                out[lineIdx] = out[lineIdx].substring(0, column - 1) + text + out[lineIdx].substring(column - 1);
            }
            return out;
        };
    },
};

/* 全局引擎实例 */
const engine = new DiagnosticEngine();
