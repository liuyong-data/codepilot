/* ============================================================
 * CodePilot JavaScript 诊断规则 (javascript-rules.js)
 * 向全局 engine 注册 JavaScript 语言规则
 * ============================================================ */

/* J001: 括号不匹配 */
engine.register('javascript', {
    id: 'J001', name: '括号不匹配',
    run(lines, code, ctx) {
        const issues = [];
        const brackets = Utils.checkBrackets(lines, 'javascript', ctx);
        for (const b of brackets) {
            if (b.type === 'unclosed') {
                issues.push({
                    severity: 'error',
                    message: `括号 "${b.char}" 未闭合，缺少 "${b.expected}"`,
                    line: b.line, column: b.column,
                    fix: {
                        description: `补上 "${b.expected}"`,
                        apply: (ls) => { const o = ls.slice(); o[b.line - 1] = o[b.line - 1] + b.expected; return o; }
                    }
                });
            } else if (b.type === 'mismatch') {
                issues.push({
                    severity: 'error',
                    message: `括号 "${b.char}" 与上方不匹配，期望 "${b.expected}"`,
                    line: b.line, column: b.column,
                    fix: { description: `替换为 "${b.expected}"`, apply: Utils.replaceRange(b.line - 1, b.column, b.column + 1, b.expected) }
                });
            } else {
                issues.push({ severity: 'error', message: `多余的闭括号 "${b.char}"`, line: b.line, column: b.column });
            }
        }
        return issues;
    }
});

/* J002: 字符串引号未闭合（单/双/反引号）
 * 使用扫描器给出的真正未闭合项，避免 "it's" 这类引号计数误报。
 */
engine.register('javascript', {
    id: 'J002', name: '字符串引号未闭合',
    run(lines, code, ctx) {
        const issues = [];
        const info = ctx || Utils.scan(lines, 'javascript');
        for (const u of info.unterminated) {
            if (u.quote === '/*') {
                issues.push({
                    severity: 'error',
                    message: '块注释 "/*" 未闭合',
                    line: u.line, column: u.column,
                    fix: {
                        description: '在文件末尾补上 "*/"',
                        apply: (ls) => { const o = ls.slice(); o[o.length - 1] = o[o.length - 1] + ' */'; return o; }
                    }
                });
                continue;
            }
            const name = u.quote === '`' ? '模板字符串反引号' : u.quote === '"' ? '双引号字符串' : '单引号字符串';
            issues.push({
                severity: 'error',
                message: `${name}未闭合`,
                line: u.line, column: u.column,
                fix: {
                    description: `在行尾补上 ${u.quote}`,
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

/* J003: 建议使用 === 而非 == */
engine.register('javascript', {
    id: 'J003', name: '建议使用严格相等 ===',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'javascript').masks;
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            for (let c = 0; c < masked.length; c++) {
                if (masked[c] !== '=' || masked[c + 1] !== '=' || masked[c + 2] === '=') continue;
                const prev = masked[c - 1] || '';
                if (prev === '!' || prev === '<' || prev === '>' || prev === '=') continue;
                // 掩码与原文等长，列号直接可用
                const absCol = c + 1;
                issues.push({
                    severity: 'hint',
                    message: `建议使用严格相等 "===" 避免隐式类型转换`,
                    line: i + 1, column: absCol,
                    fix: { description: '改为 "==="', apply: Utils.replaceRange(i, absCol, absCol + 2, '===') }
                });
                c += 2;
            }
        }
        return issues;
    }
});

/* J004: console.log 拼写错误 */
engine.register('javascript', {
    id: 'J004', name: 'console 拼写错误',
    run(lines, code, ctx) {
        const issues = [];
        const typos = { 'Console': 'console', 'CONSOLE': 'console', 'consol': 'console', 'cosnole': 'console' };
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'javascript').masks;
        for (let i = 0; i < lines.length; i++) {
            const line = masks[i] !== undefined ? masks[i] : lines[i];
            for (const [wrong, right] of Object.entries(typos)) {
                const re = new RegExp(`\\b${wrong}\\b`, 'g');
                let m;
                while ((m = re.exec(line)) !== null) {
                    issues.push({
                        severity: 'error', message: `"${wrong}" 应为 "${right}"`,
                        line: i + 1, column: m.index + 1,
                        fix: { description: `改为 "${right}"`, apply: Utils.replaceRange(i, m.index + 1, m.index + 1 + wrong.length, right) }
                    });
                }
            }
        }
        return issues;
    }
});

/* J005: 常见关键字拼写错误 */
engine.register('javascript', {
    id: 'J005', name: '关键字拼写错误',
    run(lines, code, ctx) {
        const issues = [];
        const typos = { 'funtion': 'function', 'funciton': 'function', 'retrun': 'return', 'retunr': 'return',
                        'flase': 'false', 'ture': 'true', 'fasle': 'false', 'truw': 'true',
                        'lenght': 'length', 'legnth': 'length' };
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'javascript').masks;
        for (let i = 0; i < lines.length; i++) {
            const line = masks[i] !== undefined ? masks[i] : lines[i];
            for (const [wrong, right] of Object.entries(typos)) {
                if (wrong === right) continue;
                const re = new RegExp(`\\b${wrong}\\b`, 'g');
                let m;
                while ((m = re.exec(line)) !== null) {
                    issues.push({
                        severity: 'error', message: `"${wrong}" 应为 "${right}"`,
                        line: i + 1, column: m.index + 1,
                        fix: { description: `改为 "${right}"`, apply: Utils.replaceRange(i, m.index + 1, m.index + 1 + wrong.length, right) }
                    });
                }
            }
        }
        return issues;
    }
});

/* J006: 疑似除零 */
engine.register('javascript', {
    id: 'J006', name: '疑似除零',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'javascript').masks;
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            // 排除 / 0.5 这类合法小数
            const m = masked.match(/\/\s*0(?![\d.])/);
            if (m) {
                issues.push({
                    severity: 'warning', message: `检测到除以零，结果为 Infinity`,
                    line: i + 1, column: masked.indexOf(m[0]) + 1,
                });
            }
        }
        return issues;
    }
});

/* J007: if 语句缺少括号 */
engine.register('javascript', {
    id: 'J007', name: 'if 语句缺少圆括号',
    run(lines, code, ctx) {
        const issues = [];
        const masks = (ctx && ctx.masks) || Utils.scan(lines, 'javascript').masks;
        for (let i = 0; i < lines.length; i++) {
            const masked = masks[i] !== undefined ? masks[i] : lines[i];
            // \s* 而非 \s+：允许 if 与括号之间存在多个空格
            const m = masked.match(/\bif\s*([^\s(])/);
            if (m) {
                issues.push({
                    severity: 'error', message: `if 语句条件必须用圆括号包裹`,
                    line: i + 1, column: masked.indexOf('if') + 1,
                });
            }
        }
        return issues;
    }
});
