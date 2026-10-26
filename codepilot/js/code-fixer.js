/* ============================================================
 * CodePilot 代码修复器 (code-fixer.js)
 * 负责应用单条修复 / 一键修复 / 生成 diff
 * ============================================================ */

const CodeFixer = {
    /* 应用单条修复，返回修复后的完整代码字符串 */
    applyFix(code, issue) {
        if (!issue || !issue.fix || !issue.fix.apply) return code;
        const { lines, eol } = Utils.splitLines(code);
        const newLines = issue.fix.apply(lines);
        return Utils.joinLines(newLines, eol);
    },

    /* 一键修复所有可修复的 issue
     * 策略：迭代应用，每次重新诊断以获取最新位置，直到无可修复项或达到上限。
     * 关键点：某条修复「没有产生变化」时，不能直接 break（否则一条坏规则会
     * 让整批修复停摆），而应把它拉黑后继续处理其它规则。
     * 返回 { code, fixedCount, remainingIssues, appliedRules, skipped }
     */
    fixAll(code, language, maxIterations = 200) {
        let current = code;
        let fixedCount = 0;
        const appliedRules = [];
        const skipped = [];       // 无变化 / 被跳过的规则签名
        const skippedKeys = new Set();
        const syntaxRules = new Set([
            'PY001','PY002','PY003','PY004','PY005','PY006','PY007','PY008',
            'PY015','PY018','PY010','PY011',
            'J001','J002','J003','J004','J005','J007',
        ]);

        for (let iter = 0; iter < maxIterations; iter++) {
            const issues = engine.diagnose(current, language);
            const beforeErrs = issues.filter(i => i.severity === 'error').length;
            const fixable = issues.filter(i => i.fix && i.fix.apply)
                .filter(i => !skippedKeys.has(`${i.rule}:${i.line}:${i.column}`))
                .sort((a, b) => {
                    const sp = (syntaxRules.has(a.rule) ? 0 : 1) - (syntaxRules.has(b.rule) ? 0 : 1);
                    if (sp !== 0) return sp;
                    // 语法类内部：引号(PY002)优先于括号(PY001)——引号没闭合时括号匹配会误判
                    const subPri = (r) => r === 'PY002' ? 0 : r === 'PY001' ? 1 : 2;
                    const sub = subPri(a.rule) - subPri(b.rule);
                    if (sub !== 0) return sub;
                    const sev = { error: 0, warning: 1, hint: 2 };
                    return (sev[a.severity] - sev[b.severity]) || (a.line - b.line);
                });
            if (fixable.length === 0) break;

            // 按行去重：同一行只取一条（同一行多个修复的列号会互相干扰），其余留到下一轮
            const byLine = new Map();
            for (const iss of fixable) {
                if (!byLine.has(iss.line)) byLine.set(iss.line, iss);
            }
            // 按行号倒序：从后往前应用，前面行的修复不影响后面已算好的行号
            const batch = [...byLine.values()].sort((a, b) => b.line - a.line);

            let roundFixed = 0;
            for (const target of batch) {
                const before = current;
                const candidate = this.applyFix(current, target);

                if (candidate === before) {
                    skippedKeys.add(`${target.rule}:${target.line}:${target.column}`);
                    skipped.push({ rule: target.rule, name: target.name, line: target.line });
                    continue;
                }

                // 安全闸：每条应用后仍检查 error 数不增（防止改坏 / 行号错位）
                const afterErrs = engine.diagnose(candidate, language).filter(i => i.severity === 'error').length;
                if (afterErrs > beforeErrs) {
                    skippedKeys.add(`${target.rule}:${target.line}:${target.column}`);
                    skipped.push({ rule: target.rule, name: target.name, line: target.line, reason: '安全闸：会引入新错误，已回滚' });
                    continue;
                }

                current = candidate;
                fixedCount++;
                roundFixed++;
                appliedRules.push({ rule: target.rule, name: target.name, line: target.line, message: target.message });
                // 行数变化的修复（插入哨兵 / 删导入）会使批次内后续项的行号失效，
                // 立即结束本轮，下一轮重新诊断；行内替换（行数不变）可继续批量。
                if ((candidate.match(/\n/g) || []).length !== (before.match(/\n/g) || []).length) break;
            }
            if (roundFixed === 0) break; // 本轮一条都没修成，避免空转
        }


        const remainingIssues = engine.diagnose(current, language);
        // 是否还有可自动修复的剩余项；若同时达到迭代上限，说明没修完是"撞上限"而非真的无解
        const stillFixable = remainingIssues.some(i => i.fix && i.fix.apply);
        const hitLimit = stillFixable && fixedCount >= maxIterations;
        return { code: current, fixedCount, remainingIssues, appliedRules, skipped, hitLimit };
    },

    /* 生成逐行 diff，返回 [{type:'same'|'add'|'del', text, oldLine, newLine}]
     * 大文件时先剥离公共前后缀，避免 O(n*m) 二维 DP 造成内存暴涨
     * （5000 行时原实现约 120MB / 近 2 秒）。
     */
    diff(oldCode, newCode) {
        const oldLines = Utils.splitLines(oldCode).lines;
        const newLines = Utils.splitLines(newCode).lines;
        const n = oldLines.length, m = newLines.length;

        if (n * m > 400000) {
            let head = 0;
            while (head < n && head < m && oldLines[head] === newLines[head]) head++;
            let tail = 0;
            while (tail < n - head && tail < m - head &&
                   oldLines[n - 1 - tail] === newLines[m - 1 - tail]) tail++;

            const result = [];
            for (let i = 0; i < head; i++) {
                result.push({ type: 'same', text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
            }
            const midOld = oldLines.slice(head, n - tail);
            const midNew = newLines.slice(head, m - tail);
            if (midOld.length * midNew.length > 400000) {
                // 中间段仍然过大：直接按「先删后加」展示，保证不卡死
                for (let i = 0; i < midOld.length; i++) {
                    result.push({ type: 'del', text: midOld[i], oldLine: head + i + 1, newLine: null });
                }
                for (let j = 0; j < midNew.length; j++) {
                    result.push({ type: 'add', text: midNew[j], oldLine: null, newLine: head + j + 1 });
                }
            } else {
                result.push(...this._lcsDiff(midOld, midNew, head, head));
            }
            for (let k = tail - 1; k >= 0; k--) {
                result.push({ type: 'same', text: oldLines[n - 1 - k], oldLine: n - k, newLine: m - k });
            }
            return result;
        }
        return this._lcsDiff(oldLines, newLines, 0, 0);
    },

    /* 标准 LCS diff，offset 用于还原真实行号 */
    _lcsDiff(oldLines, newLines, oldOffset = 0, newOffset = 0) {
        const n = oldLines.length, m = newLines.length;
        const w = m + 1;
        // Uint32Array 扁平化，比二维数组省内存
        const dp = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i * w + j] = oldLines[i] === newLines[j]
                    ? dp[(i + 1) * w + j + 1] + 1
                    : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
            }
        }
        const result = [];
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (oldLines[i] === newLines[j]) {
                result.push({ type: 'same', text: oldLines[i], oldLine: oldOffset + i + 1, newLine: newOffset + j + 1 });
                i++; j++;
            } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
                result.push({ type: 'del', text: oldLines[i], oldLine: oldOffset + i + 1, newLine: null });
                i++;
            } else {
                result.push({ type: 'add', text: newLines[j], oldLine: null, newLine: newOffset + j + 1 });
                j++;
            }
        }
        while (i < n) { result.push({ type: 'del', text: oldLines[i], oldLine: oldOffset + i + 1, newLine: null }); i++; }
        while (j < m) { result.push({ type: 'add', text: newLines[j], oldLine: null, newLine: newOffset + j + 1 }); j++; }
        return result;
    },

    /* 统计可修复数量 */
    countFixable(issues) {
        return issues.filter(i => i.fix && i.fix.apply).length;
    },
};
