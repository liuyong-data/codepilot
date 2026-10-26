/* ============================================================
 * CodePilot Python 诊断规则 (python-rules.js)
 * 向全局 engine 注册 Python 语言规则
 * ============================================================ */

/* PY001: 括号不匹配 / 未闭合 */
engine.register('python', {
    id: 'PY001', name: '括号不匹配',
    run(lines, code, ctx) {
        const issues = [];
        const brackets = Utils.checkBrackets(lines, 'python', ctx);
        // 该行若有未闭合字符串，补括号会改坏代码；此时让 apply 返回原数组（被拉黑跳过），等 PY002 先修引号
        const unterminatedLines = new Set((ctx && ctx.unterminated || []).map(u => u.line));
        for (const b of brackets) {
            if (b.type === 'unclosed') {
                issues.push({
                    severity: 'error',
                    message: `括号 "${b.char}" 未闭合，缺少对应的 "${b.expected}"`,
                    line: b.line, column: b.column,
                    fix: {
                        description: `在末尾补上 "${b.expected}"`,
                        apply: (ls) => {
                            if (unterminatedLines.has(b.line)) return ls;
                            const out = ls.slice();
                            const idx = b.line - 1;
                            if (out[idx] === undefined) return out;
                            // 关键：补在「代码末尾」而不是行尾。
                            // 若该行有行尾注释，直接拼在行尾会被注释吞掉，
                            // 下一轮诊断仍判定未闭合，从而无限补括号。
                            const { commentStart } = Utils.stripStringsAndComments(out[idx], 'python');
                            if (commentStart >= 0) {
                                out[idx] = out[idx].substring(0, commentStart).trimEnd() +
                                    b.expected + ' ' + out[idx].substring(commentStart);
                            } else {
                                out[idx] = out[idx].trimEnd() + b.expected;
                            }
                            return out;
                        }
                    }
                });
            } else if (b.type === 'mismatch') {
                issues.push({
                    severity: 'error',
                    message: `括号 "${b.char}" 与上方不匹配，期望 "${b.expected}"`,
                    line: b.line, column: b.column,
                    fix: {
                        description: `替换为 "${b.expected}"`,
                        apply: Utils.replaceRange(b.line - 1, b.column, b.column + 1, b.expected)
                    }
                });
            } else {
                issues.push({
                    severity: 'error',
                    message: `多余的闭括号 "${b.char}"，没有对应的开括号`,
                    line: b.line, column: b.column,
                });
            }
        }
        return issues;
    }
});

/* PY002: 字符串引号未闭合
 * 直接使用扫描器给出的「真正未闭合」字符串，避免数引号导致的误报
 * （例如 print("it's fine") 中双引号内部的单引号）。
 */
engine.register('python', {
    id: 'PY002', name: '字符串引号未闭合',
    run(lines, code, ctx) {
        const issues = [];
        const info = ctx || Utils.scan(lines, 'python');
        for (const u of info.unterminated) {
            if (u.quote === '/*') continue;
            const quoteName = u.quote === "'" ? '单引号' : u.quote === '"' ? '双引号' : '三引号';
            issues.push({
                severity: 'error',
                message: `${quoteName}字符串未闭合`,
                line: u.line, column: u.column,
                fix: {
                    description: `在行尾补上 ${u.quote}`,
                    // 只补在「真正缺少闭合引号」的那一行行尾
                    apply: (ls) => {
                        const o = ls.slice();
                        const idx = u.line - 1;
                        if (o[idx] !== undefined) o[idx] = o[idx] + u.quote;
                        return o;
                    }
                }
            });
        }
        return issues;
    }
});

/* PY003: 控制结构缺少冒号 */
engine.register('python', {
    id: 'PY003', name: '控制结构缺少冒号',
    run(lines, code, ctx) {
        const issues = [];
        const keywords = ['if', 'elif', 'else', 'for', 'while', 'def', 'class', 'try', 'except', 'finally', 'with', 'match', 'case'];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const masked = masks[i] !== undefined ? masks[i] : raw;
            const trimmed = masked.trim();
            if (!trimmed) continue;
            const m = trimmed.match(/^(\w+)/);
            if (!m) continue;
            const kw = m[1];
            if (!keywords.includes(kw)) continue;

            const effTrim = masked.trimEnd();
            // 冒号在「代码部分」的任意位置出现都算合法（支持单行 if x: y = 1）
            if (effTrim.includes(':')) continue;
            // 已经以反斜杠续行、或下一行是本行的续行时，不判定
            if (effTrim.endsWith('\\')) continue;

            // 列号：指向行尾最后一个非空白字符之后
            const col = effTrim.length + 1;
            // 语句体内容（用于判断「单行体」是否像表达式，避免 PY006 误报）
            const inlineBody = effTrim.substring(effTrim.indexOf(kw) + kw.length);
            issues.push({
                severity: 'error',
                message: `"${kw}" 语句末尾缺少冒号 ":"`,
                line: i + 1, column: col,
                inlineBody,
                fix: {
                    description: '补上冒号 ":"',
                    apply: (ls) => {
                        const o = ls.slice();
                        const line = o[i];
                        const { commentStart } = Utils.stripStringsAndComments(line, 'python');
                        if (commentStart >= 0) {
                            o[i] = line.substring(0, commentStart).trimEnd() + ':' + line.substring(commentStart);
                        } else {
                            o[i] = line.trimEnd() + ':';
                        }
                        return o;
                    }
                }
            });
        }
        return issues;
    }
});

/* PY004: 缩进混用空格与 Tab */
engine.register('python', {
    id: 'PY004', name: '缩进混用空格与 Tab',
    run(lines) {
        const issues = [];
        for (let i = 0; i < lines.length; i++) {
            const ind = Utils.indentOf(lines[i]);
            if (ind.mixed) {
                issues.push({
                    severity: 'error',
                    message: `行首混用了空格与 Tab 缩进，Python 不允许混用`,
                    line: i + 1, column: 1,
                    fix: {
                        description: '统一为 4 空格缩进',
                        apply: (ls) => {
                            const o = ls.slice();
                            o[i] = '    '.repeat(Math.ceil(ind.total / 4)) + o[i].substring(ind.total);
                            return o;
                        }
                    }
                });
            }
        }
        return issues;
    }
});

/* PY005: print 拼写错误 */
engine.register('python', {
    id: 'PY005', name: 'print 拼写错误',
    run(lines, code, ctx) {
        const issues = [];
        const typos = ['Print', 'PRINT', 'prnit', 'prnt', 'pint', 'PRINTF'];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            const line = masks[i] !== undefined ? masks[i] : lines[i];
            for (const typo of typos) {
                const re = new RegExp(`\\b${typo}\\b`, 'g');
                let m;
                while ((m = re.exec(line)) !== null) {
                    const col = m.index + 1;
                    issues.push({
                        severity: 'error',
                        message: `"${typo}" 拼写错误，应为 "print"`,
                        line: i + 1, column: col,
                        fix: {
                            description: '改为 "print"',
                            apply: Utils.replaceRange(i, col, col + typo.length, 'print')
                        }
                    });
                }
            }
        }
        return issues;
    }
});

/* PY006: 条件中误用 = 而非 == */
engine.register('python', {
    id: 'PY006', name: '条件中误用赋值符 =',
    run(lines, code, ctx) {
        const issues = [];
        const condKw = /\b(if|elif|while)\b/;
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            if (!condKw.test(masked)) continue;

            // 只扫描「条件头」：从 if/elif/while 到冒号（或行尾），
            // 避免把单行 if x: y = 1 里语句体的赋值误判成条件比较。
            const kwMatch = masked.match(condKw);
            let start = kwMatch ? masked.indexOf(kwMatch[0]) : 0;
            let colon = masked.indexOf(':', start + 2);
            const limit = colon === -1 ? masked.length : colon;

            for (let c = start; c < limit; c++) {
                if (masked[c] !== '=') continue;
                const prev = masked[c - 1] || '';
                const next = masked[c + 1] || '';
                if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>' ||
                    prev === ':' || prev === '+' || prev === '-' || prev === '*' || prev === '/' ||
                    prev === '%' || prev === '&' || prev === '|' || prev === '^' || prev === '@') continue;
                // 掩码与原文等长，列号直接可用（无需 indexOf，避免字符串在前时错位）
                const absCol = c + 1;
                issues.push({
                    severity: 'error',
                    message: `条件表达式中使用了赋值符 "="，是否应为比较符 "=="？`,
                    line: i + 1, column: absCol,
                    fix: {
                        description: '改为 "=="',
                        apply: Utils.replaceRange(i, absCol, absCol + 1, '==')
                    }
                });
            }
        }
        return issues;
    }
});

/* PY007: print 语句缺少括号 (Python3) */
engine.register('python', {
    id: 'PY007', name: 'print 缺少括号',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            // 在掩码上匹配，天然跳过注释与字符串中的 print
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const m = masked.match(/\bprint\s+([^(\s])/);
            if (!m) continue;
            const printIdx = masked.indexOf('print');
            const after = lines[i].substring(printIdx + 5);
            const col = printIdx + 6; // print 之后的第一个字符
            issues.push({
                severity: 'error',
                message: `Python3 中 print 是函数，需要用括号包裹参数`,
                line: i + 1, column: col,
                fix: {
                    description: '改为 print(...) 形式',
                    apply: (ls) => {
                        const o = ls.slice();
                        const l = o[i];
                        const idx = l.indexOf('print', printIdx);
                        if (idx < 0) return o;
                        const rest = l.substring(idx + 5);
                        const { commentStart } = Utils.stripStringsAndComments(l, 'python');
                        let core = rest;
                        let tail = '';
                        if (commentStart >= 0 && commentStart > idx + 5) {
                            core = rest.substring(0, commentStart - (idx + 5));
                            tail = rest.substring(commentStart - (idx + 5));
                        }
                        const leading = core.match(/^\s*/)[0];
                        const body = core.trim();
                        // 已经是 print(...) 形态则不再处理
                        if (body.startsWith('(')) return o;
                        o[i] = l.substring(0, idx + 5) + leading + '(' + body + ')' + tail;
                        return o;
                    }
                }
            });
        }
        return issues;
    }
});

/* PY008: 控制结构 / 函数定义后缺少缩进体 */
engine.register('python', {
    id: 'PY008', name: '语句后缺少缩进体',
    run(lines, code, ctx) {
        const issues = [];
        const kwRe = /\b(if|elif|else|for|while|def|class|try|except|finally|with|match|case)\b/;
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length - 1; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const trimmed = masked.trim();
            if (!trimmed || !kwRe.test(trimmed)) continue;
            if (!trimmed.endsWith(':')) continue;
            const curIndent = Utils.indentOf(lines[i]).total;
            const nextIndent = Utils.indentOf(lines[i + 1]).total;
            const nextTrim = lines[i + 1].trim();
            if (nextTrim === '') continue;
            if (nextIndent <= curIndent && !nextTrim.startsWith('#')) {
                issues.push({
                    severity: 'error',
                    message: `该语句缺少缩进的代码体，下一行缩进应大于本行`,
                    line: i + 2, column: 1,
                    fix: {
                        description: '为下一行增加 4 空格缩进',
                        apply: (ls) => { const o = ls.slice(); o[i + 1] = '    ' + o[i + 1]; return o; }
                    }
                });
            }
        }
        return issues;
    }
});

/* PY009: 可变默认参数陷阱
 * 改进：支持多行 def（参数跨行）；守卫代码插入到函数体第一行之前，
 * 而不是紧跟在签名后面（原来会插到多行签名的中间）。
 */
engine.register('python', {
    id: 'PY009', name: '可变默认参数陷阱',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            if (!/\bdef\s+\w+\s*\(/.test(masked)) continue;

            // 收集完整签名（可能跨多行），直到括号配平
            let sigEnd = i, buf = masked;
            let depth = 0;
            let sigClosed = false;
            for (let k = i; k < lines.length; k++) {
                const seg = masks[k] !== undefined ? masks[k] : lines[k];
                if (k > i) buf += '\n' + seg;
                for (const ch of seg) {
                    if (ch === '(') depth++;
                    else if (ch === ')') depth--;
                }
                if (depth <= 0 && buf.includes('(')) { sigEnd = k; sigClosed = true; break; }
                if (k - i > 30) break; // 防御：异常输入
            }
            // 签名未闭合（缺右括号等）：跳过，避免把函数体误当参数；等 PY001 修好括号下一轮再检测
            if (!sigClosed) continue;
            const open = buf.indexOf('(');
            const close = buf.lastIndexOf(')');
            if (open === -1 || close === -1 || close < open) continue;
            const params = buf.substring(open + 1, close);

            const mutRe = /(\w+)\s*=\s*(\[\s*\]|\{\s*\}|set\s*\(\s*\))/g;
            let m;
            while ((m = mutRe.exec(params)) !== null) {
                const paramName = m[1];
                const mutValue = m[2];
                const lineNo = i + buf.substring(0, open + 1 + m.index).split('\n').length - 1;
                const colInLine = (() => {
                    const upto = buf.substring(0, open + 1 + m.index);
                    const nl = upto.lastIndexOf('\n');
                    return nl === -1 ? open + 1 + m.index + 1 : (open + 1 + m.index - nl);
                })();
                issues.push({
                    severity: 'warning',
                    message: `参数 "${paramName}" 使用可变对象 ${mutValue} 作默认值，多次调用会共享状态，建议用 None 作哨兵`,
                    line: lineNo + 1, column: colInLine,
                    fix: {
                        description: `改为 ${paramName}=None 并在函数体首部加判断`,
                        apply: (ls) => {
                            const out = ls.slice();
                            const escaped = mutValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const re = new RegExp(`\\b${paramName}\\s*=\\s*${escaped}`);
                            // 只改签名所在行（多行签名时逐行找）
                            for (let k = i; k <= Math.min(sigEnd, out.length - 1); k++) {
                                if (re.test(out[k])) {
                                    out[k] = out[k].replace(re, `${paramName}=None`);
                                    break;
                                }
                            }
                            const defIndent = Utils.indentOf(ls[i]).total;
                            const pad = ' '.repeat(defIndent + 4);
                            const guard = `${pad}if ${paramName} is None:\n${pad}    ${paramName} = ${mutValue}`;
                            // 插到签名结束之后的第一行（函数体起始处）
                            const insertAt = Math.min(sigEnd + 1, out.length);
                            out.splice(insertAt, 0, guard);
                            return out;
                        }
                    }
                });
            }
        }
        return issues;
    }
});

/* PY010: == None / != None 应使用 is None */
engine.register('python', {
    id: 'PY010', name: '应使用 is None 比较 None',
    run(lines) {
        const issues = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let m;
            const reEq = /([^=!<>])==\s*None\b/g;
            while ((m = reEq.exec(line)) !== null) {
                const col = m.index + m[1].length + 1;
                issues.push({
                    severity: 'hint',
                    message: `比较 None 建议使用 "is None" 而非 "== None"`,
                    line: i + 1, column: col,
                    fix: {
                        description: '改为 "is None"',
                        apply: Utils.replaceRange(i, col, col + 2, 'is')
                    }
                });
            }
            const reNe = /([^=!<>])!=\s*None\b/g;
            while ((m = reNe.exec(line)) !== null) {
                const col = m.index + m[1].length + 1;
                issues.push({
                    severity: 'hint',
                    message: `比较 None 建议使用 "is not None" 而非 "!= None"`,
                    line: i + 1, column: col,
                    fix: {
                        description: '改为 "is not"',
                        apply: Utils.replaceRange(i, col, col + 2, 'is not')
                    }
                });
            }
        }
        return issues;
    }
});

/* PY011: 行尾多余空白 */
engine.register('python', {
    id: 'PY011', name: '行尾多余空白',
    run(lines) {
        const issues = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const m = line.match(/(\s+)$/);
            if (m && line.trim() !== '') {
                issues.push({
                    severity: 'hint',
                    message: `行尾存在多余空白字符`,
                    line: i + 1, column: line.length - m[1].length + 1,
                    fix: {
                        description: '去除行尾空白',
                        apply: (ls) => { const o = ls.slice(); o[i] = o[i].trimEnd(); return o; }
                    }
                });
            }
        }
        return issues;
    }
});

/* PY012: 疑似除零
 * 修复策略：绝不做「把 0 改成 1」这种消症状式修复 —— 那样虽然不再抛
 * ZeroDivisionError，却会悄悄算出错误结果，比不修更糟。
 * 改为根据函数上下文推断真正的除数：
 *   若某个参数被用于 len(x) / sum(x) / for ... in x，说明函数在对该容器
 *   求平均，除数应为 len(x)；
 *   推断不出来时只提示、不提供自动修复（交由使用者判断）。
 */
engine.register('python', {
    id: 'PY012', name: '疑似除零',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        const divisorCache = new Map();

        const inferDivisor = (lineIdx) => {
            if (divisorCache.has(lineIdx)) return divisorCache.get(lineIdx);
            const result = (() => {
                const ind = Utils.indentOf(lines[lineIdx]).total;
                // 向上寻找最近的、缩进更小的 def
                for (let k = lineIdx - 1; k >= 0; k--) {
                    const masked = masks[k] !== undefined ? masks[k] : lines[k];
                    const m = masked.match(/^(\s*)(?:async\s+)?def\s+\w+\s*\((.*)$/);
                    if (!m) continue;
                    if (m[1].length >= ind) continue;

                    // 参数只取 def 行本身，多行签名不强行推断（宁可不给修复）
                    let params = m[2];
                    const close = params.indexOf(')');
                    if (close !== -1) params = params.substring(0, close);
                    const names = params.split(',')
                        .map(p => p.split('=')[0].trim())
                        .filter(p => /^\w+$/.test(p) && p !== 'self' && p !== 'cls');
                    if (!names.length) return null;

                    // 确定函数体范围
                    const defIndent = m[1].length;
                    let bodyEnd = lines.length - 1;
                    for (let q = k + 1; q < lines.length; q++) {
                        const seg = masks[q] !== undefined ? masks[q] : lines[q];
                        if (!seg.trim()) continue;
                        if (Utils.indentOf(lines[q]).total <= defIndent) { bodyEnd = q - 1; break; }
                    }
                    const body = [];
                    for (let q = k + 1; q <= bodyEnd; q++) {
                        body.push(masks[q] !== undefined ? masks[q] : lines[q]);
                    }
                    const bodyText = body.join('\n');

                    // 强信号：len(x) / sum(x)
                    const strong = names.filter(p =>
                        new RegExp(`\\blen\\s*\\(\\s*${p}\\b|\\bsum\\s*\\(\\s*${p}\\b`).test(bodyText));
                    if (strong.length === 1) return `len(${strong[0]})`;
                    // 次强信号：for ... in x
                    const viaLoop = names.filter(p =>
                        new RegExp(`\\bfor\\s+[\\w\\s,]+?\\s+in\\s+${p}\\b`).test(bodyText));
                    if (strong.length === 0 && viaLoop.length === 1) return `len(${viaLoop[0]})`;
                    return null;
                }
                return null;
            })();
            divisorCache.set(lineIdx, result);
            return result;
        };

        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            // 排除 / 0.5 这类合法小数
            const re = /\/\s*0(?![\d.])/g;
            let m;
            while ((m = re.exec(masked)) !== null) {
                const idx = m.index;
                const raw = m[0];
                const col = idx + 1;
                const divisor = inferDivisor(i);
                issues.push({
                    severity: 'warning',
                    message: divisor
                        ? `检测到除以零，会抛出 ZeroDivisionError（这里看起来是在求平均，除数应为 ${divisor}）`
                        : `检测到除以零，会抛出 ZeroDivisionError，请确认除数是否写错`,
                    line: i + 1, column: col,
                    fix: divisor ? {
                        description: `将除数 0 改为 ${divisor}`,
                        apply: (ls) => {
                            const o = ls.slice();
                            if (o[i] === undefined) return o;
                            // 保留原写法里的空格：`/ 0` -> `/ len(x)`，`/0` -> `/len(x)`
                            const gap = raw.replace(/^\/\s*0$/, m0 => (m0.length > 2 ? ' ' : ''));
                            o[i] = o[i].substring(0, idx) + '/' + gap + divisor + o[i].substring(idx + raw.length);
                            return o;
                        }
                    } : null
                });
            }
        }
        return issues;
    }
});

/* PY013: 使用 import * */
engine.register('python', {
    id: 'PY013', name: '避免使用 import *',
    run(lines) {
        const issues = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const m = line.match(/\bfrom\s+(\S+)\s+import\s+\*/);
            if (m) {
                issues.push({
                    severity: 'warning',
                    message: `使用 "import *" 会污染命名空间，难以追踪来源，建议显式导入`,
                    line: i + 1, column: line.indexOf('*') + 1,
                    fix: {
                        description: `请改为显式导入，如：from ${m[1]} import <需要的名字>`,
                    }
                });
            }
        }
        return issues;
    }
});

/* PY014: except 后无异常类型（裸 except） */
engine.register('python', {
    id: 'PY014', name: '避免裸 except',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const trimmed = masked.trim();
            if (!/^except\s*:/.test(trimmed)) continue;
            const col = masked.indexOf('except') + 1;
            issues.push({
                severity: 'warning',
                message: `裸 "except:" 会捕获所有异常（含 KeyboardInterrupt），建议指定异常类型`,
                line: i + 1, column: col,
                fix: {
                    description: '改为 "except Exception:"',
                    apply: Utils.replaceRange(i, col, col + 'except'.length, 'except Exception')
                }
            });
        }
        return issues;
    }
});

/* PY015: 常见函数名拼写错误
 * 注意：typo 表必须是「错 -> 对」，之前 'occur': 'occur' 这类自映射会导致
 * 对合法单词报错，并且「修复」后与原文相同，还会让一键修复提前中断。
 */
engine.register('python', {
    id: 'PY015', name: '函数名拼写错误',
    run(lines, code, ctx) {
        const issues = [];
        const typos = {
            'lenght': 'length', 'legnth': 'length',
            'recieve': 'receive', 'receieve': 'receive',
            'occured': 'occurred', 'ocurred': 'occurred',
            'seperate': 'separate', 'seperat': 'separat',
            'appendd': 'append', 'apend': 'append',
            'splt': 'split', 'spilt': 'split',
            'retrun': 'return', 'retunr': 'return',
        };
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            const line = masks[i] !== undefined ? masks[i] : lines[i];
            for (const [wrong, right] of Object.entries(typos)) {
                if (wrong === right) continue; // 防御：绝不自映射
                const re = new RegExp(`\\b${wrong}\\b`, 'g');
                let m;
                while ((m = re.exec(line)) !== null) {
                    const col = m.index + 1;
                    issues.push({
                        severity: 'error',
                        message: `"${wrong}" 拼写错误，应为 "${right}"`,
                        line: i + 1, column: col,
                        fix: {
                            description: `改为 "${right}"`,
                            apply: Utils.replaceRange(i, col, col + wrong.length, right)
                        }
                    });
                }
            }
        }
        return issues;
    }
});

/* PY016: 字典/列表/集合跨行末尾缺少逗号（简化：检测跨行结构中每行以值结尾且下一行缩进相同无逗号） */
engine.register('python', {
    id: 'PY016', name: '容器元素可能缺少逗号',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;

        // 关键性能修复：原来对每个候选行都从第 0 行重新数一遍括号，
        // 复杂度 O(n²)（1000 行时 100ms+）。这里一次性预计算「每行行首的容器深度」。
        const depthAtLineStart = new Array(lines.length);
        let depth = 0;
        for (let i = 0; i < lines.length; i++) {
            depthAtLineStart[i] = depth;
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            for (let k = 0; k < masked.length; k++) {
                const ch = masked[k];
                if (ch === '[' || ch === '{') depth++;
                else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
            }
        }

        for (let i = 0; i < lines.length - 1; i++) {
            const maskedCur = masks[i] !== undefined ? masks[i] : lines[i];
            const maskedNext = masks[i + 1] !== undefined ? masks[i + 1] : lines[i + 1];
            const curTrim = maskedCur.trim();
            const nextTrim = maskedNext.trim();
            if (!curTrim || !nextTrim) continue;
            if (/[}\])]\s*$/.test(curTrim)) continue;   // 以闭括号结尾
            if (curTrim.endsWith(',')) continue;        // 已有逗号
            if (curTrim.endsWith(':')) continue;        // 字典键
            if (/^[([{]/.test(curTrim)) continue;       // 以开括号开头
            const indentCur = Utils.indentOf(lines[i]).total;
            const indentNext = Utils.indentOf(lines[i + 1]).total;
            if (indentCur !== indentNext || indentCur === 0) continue;
            if (/^[^:]+\s*\(/.test(curTrim)) continue;  // 函数调用行
            // 本行行首已处于容器内部（未闭合的 [ 或 {）
            if (depthAtLineStart[i] > 0) {
                issues.push({
                    severity: 'warning',
                    message: `多行容器中元素之间可能缺少逗号`,
                    line: i + 1, column: lines[i].trimEnd().length + 1,
                    fix: {
                        description: '行尾补逗号',
                        apply: (ls) => { const o = ls.slice(); o[i] = o[i].trimEnd() + ','; return o; }
                    }
                });
            }
        }
        return issues;
    }
});

/* PY017: return / break / continue 出现在函数外
 * 修复点：
 *  - 识别 async def
 *  - break / continue 只要处于循环体内就合法（顶层 for 里的 break 不应报错）
 */
engine.register('python', {
    id: 'PY017', name: 'return 出现在函数外',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        const defStack = [];  // 函数定义缩进栈（支持嵌套）
        const loopStack = []; // 循环体缩进
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const trim = masked.trim();
            if (!trim) continue;
            const ind = Utils.indentOf(masked).total;

            // 退出已结束的循环作用域
            while (loopStack.length && ind <= loopStack[loopStack.length - 1] && !/^(for|while)\b/.test(trim)) {
                loopStack.pop();
            }
            // 函数作用域用栈维护，支持嵌套函数（内层 def 结束后应回退到外层）
            if (/^(async\s+def|def)\b/.test(trim)) {
                defStack.push(ind);
                continue;
            }
            while (defStack.length && ind <= defStack[defStack.length - 1]) defStack.pop();
            if (/^(for|while)\b/.test(trim)) { loopStack.push(ind); continue; }

            const m = trim.match(/^(return|break|continue)\b/);
            if (!m) continue;
            const kw = m[1];
            if (kw === 'return') {
                if (defStack.length === 0) {
                    issues.push({
                        severity: 'error',
                        message: `"return" 出现在函数外部`,
                        line: i + 1, column: masked.indexOf('return') + 1,
                    });
                }
            } else {
                // break / continue 必须在循环体内
                if (loopStack.length === 0) {
                    issues.push({
                        severity: 'error',
                        message: `"${kw}" 出现在循环外部`,
                        line: i + 1, column: masked.indexOf(kw) + 1,
                    });
                }
            }
        }
        return issues;
    }
});

/* PY018: True/False/None 拼写错误（首字母小写） */
engine.register('python', {
    id: 'PY018', name: '布尔常量拼写错误',
    run(lines, code, ctx) {
        const issues = [];
        const map = { 'true': 'True', 'false': 'False', 'none': 'None',
                      'TRUE': 'True', 'FALSE': 'False', 'NONE': 'None',
                      'Ture': 'True', 'Flase': 'False', 'NOne': 'None' };
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        for (let i = 0; i < lines.length; i++) {
            // 在掩码上扫描：字符串 / 注释中的 true、none 不再误报
            const line = masks[i] !== undefined ? masks[i] : lines[i];
            for (const [wrong, right] of Object.entries(map)) {
                const re = new RegExp(`\\b${wrong}\\b`, 'g');
                let m;
                while ((m = re.exec(line)) !== null) {
                    const col = m.index + 1;
                    issues.push({
                        severity: 'error',
                        message: `"${wrong}" 应为 "${right}"（Python 区分大小写）`,
                        line: i + 1, column: col,
                        fix: {
                            description: `改为 "${right}"`,
                            apply: Utils.replaceRange(i, col, col + wrong.length, right)
                        }
                    });
                }
            }
        }
        return issues;
    }
});
/* PY019: 使用了未定义的名字（忘记加引号的字符串 / 未定义变量） */
engine.register('python', {
    id: 'PY019', name: '使用了未定义的名字',
    run(lines, code, ctx) {
        const issues = [];
        const PY_KEYWORDS = new Set(['def','class','if','elif','else','for','while','return','import','from','as','with','try','except','finally','raise','pass','break','continue','in','not','and','or','is','lambda','yield','global','nonlocal','del','assert','async','await','match','case']);
        const PY_BUILTINS = new Set([
            'abs','aiter','all','anext','any','ascii','bin','bool','breakpoint','bytearray','bytes','callable','chr','classmethod','compile','complex','delattr','dict','dir','divmod','enumerate','eval','exec','exit','filter','float','format','frozenset','getattr','globals','hasattr','hash','help','hex','id','input','int','isinstance','issubclass','iter','len','license','list','locals','map','max','memoryview','min','next','object','oct','open','ord','pow','print','property','quit','range','repr','reversed','round','set','setattr','slice','sorted','staticmethod','str','sum','super','tuple','type','vars','zip',
            'True','False','None','NotImplemented','Ellipsis','__debug__','__name__','__file__','__doc__','__spec__','__loader__','__package__','__builtins__','__import__','__class__','__dict__','__qualname__','__module__','__bases__','__mro__','__init__','__new__','__del__','__repr__','__str__','__len__','__getitem__','__setitem__','__iter__','__next__','__call__','__enter__','__exit__','__eq__','__ne__','__lt__','__le__','__gt__','__ge__','__hash__','__add__','__sub__','__mul__','__truediv__','__floordiv__','__mod__','__pow__','__contains__','__format__','__bytes__','__all__','__version__','__author__',
            'self','cls',
            'BaseException','Exception','ArithmeticError','AssertionError','AttributeError','BufferError','EOFError','FloatingPointError','GeneratorExit','ImportError','ModuleNotFoundError','IndexError','KeyError','KeyboardInterrupt','MemoryError','NameError','NotImplementedError','OSError','OverflowError','RecursionError','ReferenceError','RuntimeError','StopIteration','StopAsyncIteration','SyntaxError','IndentationError','TabError','SystemError','SystemExit','TypeError','UnboundLocalError','UnicodeError','UnicodeDecodeError','UnicodeEncodeError','UnicodeTranslateError','ValueError','ZeroDivisionError','Warning','UserWarning','DeprecationWarning','PendingDeprecationWarning','RuntimeWarning','SyntaxWarning','FutureWarning','ImportWarning','UnicodeWarning','BytesWarning','ResourceWarning','ConnectionError','ConnectionAbortedError','ConnectionRefusedError','ConnectionResetError','BrokenPipeError','TimeoutError','FileExistsError','FileNotFoundError','IsADirectoryError','NotADirectoryError','PermissionError','ProcessLookupError','BlockingIOError','ChildProcessError','InterruptedError','EnvironmentError','IOError',
        ]);

        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        const defined = new Set();
        const addNames = (s) => {
            for (const p of s.split(',')) {
                const nm = p.trim().replace(/^\*/, '').match(/^(\w+)/);
                if (nm) defined.add(nm[1]);
            }
        };

        // 第一步：收集所有定义的名字（全部在掩码上做，避免字符串/注释干扰）
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const trim = masked.trim();
            if (!trim) continue;
            let m;
            const compRe = /\bfor\s+([\w\s,]+?)\s+in\b/g;
            let cm;
            while ((cm = compRe.exec(masked)) !== null) addNames(cm[1]);
            if ((m = masked.match(/lambda\s+([^:]*?):/))) addNames(m[1]);
            // as 绑定：支持 with a as f, b as g / except E as e（可能多个）
            {
                const asRe = /\bas\s+(\w+)/g;
                let am2;
                while ((am2 = asRe.exec(masked)) !== null) defined.add(am2[1]);
            }
            // 海象运算符 name := expr（PEP 572，可在任意位置赋值，如 if (n := len(x)) > 2:）
            {
                const walrusRe = /\b(\w+)\s*:=/g;
                let wm;
                while ((wm = walrusRe.exec(masked)) !== null) defined.add(wm[1]);
            }
            if ((m = trim.match(/^(?:async\s+)?def\s+(\w+)/))) {
                defined.add(m[1]);
                const pm = trim.match(/def\s+\w+\s*\(([^)]*)/);
                if (pm) addNames(pm[1]);
                continue;
            }
            if ((m = trim.match(/^class\s+(\w+)/))) { defined.add(m[1]); continue; }
            if ((m = trim.match(/^for\s+([\w\s,]+?)\s+in\b/))) { addNames(m[1]); continue; }
            if ((m = trim.match(/^import\s+(\w+)/))) {
                defined.add(m[1]);
                const am = trim.match(/\bas\s+(\w+)/);
                if (am) defined.add(am[1]);
                continue;
            }
            if ((m = trim.match(/^from\s+(\S+)\s+import\s+(.+)/))) {
                const modName = m[1].split('.')[0];
                if (/^\w+$/.test(modName)) defined.add(modName);
                for (const p of m[2].split(',')) {
                    const nm = p.trim().match(/^(\w+)/);
                    if (nm) defined.add(nm[1]);
                    const am = p.trim().match(/\bas\s+(\w+)/);
                    if (am) defined.add(am[1]);
                }
                continue;
            }
            if ((m = trim.match(/^global\s+([\w\s,]+)/)) || (m = trim.match(/^nonlocal\s+([\w\s,]+)/))) {
                addNames(m[1]); continue;
            }
            if ((m = trim.match(/^(\w+)\s*:/))) { defined.add(m[1]); }
            // 赋值目标：支持分号分隔的多语句（x = 1; y = 2）与星号解包（first, *rest = ...）
            for (const stmt of masked.split(';')) {
                const s = stmt.trim();
                if (!s) continue;
                const am = s.match(/^([\w\s,*]+?)\s*=(?!=)/);
                if (am) addNames(am[1]);
            }
        }

        // 第二步：在「掩码」上扫描名字使用 —— 字符串与注释天然被跳过，
        // 且列号与原文完全一致，不会出现 indexOf 错位。
        const unterminatedLines = new Set((ctx && ctx.unterminated || [])
            .filter(u => u.quote !== '/*').map(u => u.line));

        // star import 降级：存在 from X import * 时，未定义名字可能来自通配导入，
        // 静态无法确认，降级为 hint，避免误报 error 并触发加引号修复。
        let hasStarImport = false;
        for (let i = 0; i < lines.length; i++) {
            const mm = masks[i] !== undefined ? masks[i] : lines[i];
            if (/^\s*from\s+\S+\s+import\s+\*\s*$/.test(mm.trim())) { hasStarImport = true; break; }
        }

        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const re = /\b([A-Za-z_]\w*)\b/g;
            let m;
            while ((m = re.exec(masked)) !== null) {
                const idx = m.index;
                const name = m[1];
                const col = idx + 1;
                if (defined.has(name) || PY_BUILTINS.has(name) || PY_KEYWORDS.has(name)) continue;
                // 跳过属性访问 obj.attr
                if (idx > 0 && masked[idx - 1] === '.') continue;
                const after = masked.substring(idx + name.length);
                // 跳过关键字参数 key= 与赋值左值
                if (/^\s*=(?!=)/.test(after)) continue;
                // 安全闸：仅当 name 是 print( name ) 的唯一参数时才提供「加引号」修复。
                // 这是"忘记给字符串加引号"最明确、最安全的场景；其余位置（赋值右值、
                // 表达式操作数、函数调用实参等）只报告不自动修复，避免把变量改成字符串而毁代码。
                // 另：该行存在未闭合引号时也不提供（引号没闭合造成的假象，加引号会改坏）。
                const isPrintSingleArg = masked.includes('print(') &&
                    new RegExp(`\\bprint\\s*\\(\\s*${name}\\s*\\)`).test(masked);
                const safe = isPrintSingleArg && !unterminatedLines.has(i + 1);

                issues.push({
                    severity: hasStarImport ? 'hint' : 'error',
                    message: hasStarImport
                        ? `使用了未定义的名字 "${name}"（文件存在 import *，可能来自通配导入，已降级为提示）`
                        : `使用了未定义的名字 "${name}"，可能是未定义的变量，或忘记给字符串加引号`,
                    line: i + 1, column: col,
                    fix: (safe && !hasStarImport) ? {
                        description: `给 "${name}" 加引号作为字符串`,
                        apply: Utils.replaceRange(i, col, col + name.length, `'${name}'`)
                    } : null
                });
            }
        }
        return issues;
    }
});

/* PY020: 缩进不是 4 的倍数（PEP8 E111）——跳过续行（括号未闭合时的隐式续行） */
engine.register('python', {
    id: 'PY020', name: '缩进非 4 空格倍数',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        let depth = 0;
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const atStart = depth;
            for (const ch of masked) {
                if (ch === '(' || ch === '[' || ch === '{') depth++;
                else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
            }
            if (atStart > 0) continue;
            const trim = lines[i].trim();
            if (!trim || trim.startsWith('#')) continue;
            const ind = Utils.indentOf(lines[i]);
            if (ind.mixed || ind.tabs > 0) continue;
            if (ind.spaces > 0 && ind.spaces % 4 !== 0) {
                const newIndent = Math.round(ind.spaces / 4) * 4;
                issues.push({
                    severity: 'warning',
                    message: `缩进为 ${ind.spaces} 个空格，PEP8 建议每级 4 空格`,
                    line: i + 1, column: 1,
                    fix: {
                        description: `调整为 ${newIndent} 个空格`,
                        apply: (ls) => { const o = ls.slice(); o[i] = ' '.repeat(newIndent) + o[i].substring(ind.total); return o; }
                    }
                });
            }
        }
        return issues;
    }
});

/* PY021: 导入从未使用 */
engine.register('python', {
    id: 'PY021', name: '未使用的导入',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        const imports = [];
        const importLines = new Set();
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const trim = masked.trim();
            let m;
            if ((m = trim.match(/^import\s+(.+)$/))) {
                importLines.add(i);
                for (const part of m[1].split(',')) {
                    const pm = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?/);
                    if (pm) imports.push({ name: pm[2] || pm[1], line: i });
                }
            } else if ((m = trim.match(/^from\s+\S+\s+import\s+(.+)$/))) {
                if (m[1].trim() === '*') continue;
                importLines.add(i);
                for (const part of m[1].split(',')) {
                    const pm = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?/);
                    if (pm) imports.push({ name: pm[2] || pm[1], line: i });
                }
            }
        }
        const used = new Set();
        for (let i = 0; i < lines.length; i++) {
            if (importLines.has(i)) continue;
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            const re = /\b([A-Za-z_]\w*)\b/g;
            let m;
            while ((m = re.exec(masked)) !== null) used.add(m[1]);
        }
        for (const im of imports) {
            if (used.has(im.name)) continue;
            issues.push({
                severity: 'warning',
                message: `导入的 "${im.name}" 从未使用`,
                line: im.line + 1, column: 1,
                fix: {
                    description: `移除未使用的导入`,
                    apply: (ls) => {
                        const o = ls.slice();
                        const line = o[im.line];
                        const trim = line.trim();
                        const single = /^(import\s+\w+(?:\s+as\s+\w+)?|from\s+\S+\s+import\s+\w+(?:\s+as\s+\w+)?)$/.test(trim);
                        if (single) {
                            o.splice(im.line, 1);
                        } else {
                            const partRe = new RegExp(`\\b${im.name}\\b(?:\\s+as\\s+\\w+)?\\s*,?\\s*`);
                            o[im.line] = line.replace(partRe, '').replace(/(import)\s*,\s*/, '$1 ').replace(/,\s*,/g, ',').replace(/\s+$/, '');
                        }
                        return o;
                    }
                }
            });
        }
        return issues;
    }
});

/* PY022: 浮点数直接用 == / != 比较（精度陷阱） */
engine.register('python', {
    id: 'PY022', name: '浮点数直接比较',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'python').masks;
        const isFloatTok = (s) => /\d/.test(s) && /[.eE]/.test(s);
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            for (let c = 0; c < masked.length - 1; c++) {
                const two = masked[c] + masked[c + 1];
                if (two !== '==' && two !== '!=') continue;
                if (masked[c + 2] === '=') continue;
                if (/[=!<>]/.test(masked[c - 1] || '')) continue;
                let le = c;
                while (le > 0 && /[.\deE]/.test(masked[le - 1])) le--;
                const leftTok = masked.substring(le, c);
                let rs = c + 2;
                while (rs < masked.length && /[ \t]/.test(masked[rs])) rs++;
                let re2 = rs;
                while (re2 < masked.length && /[.\deE]/.test(masked[re2])) re2++;
                const rightTok = masked.substring(rs, re2);
                if (isFloatTok(leftTok) || isFloatTok(rightTok)) {
                    issues.push({
                        severity: 'warning',
                        message: `浮点数用 ${two} 直接比较可能因精度误差失效，建议用 math.isclose() 或容差判断`,
                        line: i + 1, column: c + 1,
                        fix: {
                            description: '改用 math.isclose(a, b) 或 abs(a - b) < 1e-9',
                        }
                    });
                    c += 2;
                }
            }
        }
        return issues;
    }
});