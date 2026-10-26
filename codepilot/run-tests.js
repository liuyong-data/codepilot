/* ============================================================
 * CodePilot 回归测试套件 (run-tests.js)
 * 用法: node run-tests.js
 * 全部通过返回 0，任一失败返回 1（可接 CI / 改完自检）
 * ============================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const dir = path.join(__dirname, 'js');
const ctx = { console, performance: { now: () => Date.now() } };
vm.createContext(ctx);
for (const f of ['diagnostic-engine.js', 'python-rules.js', 'javascript-rules.js', 'code-fixer.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
const diag = (c, lang = 'python') => vm.runInContext('engine.diagnose(' + JSON.stringify(c) + ',' + JSON.stringify(lang) + ')', ctx);
const fixAll = (c, lang = 'python') => vm.runInContext('CodeFixer.fixAll(' + JSON.stringify(c) + ',' + JSON.stringify(lang) + ')', ctx);

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  \u2713 ' + name); }
    catch (e) { failed++; console.log('  \u2717 ' + name); console.log('      ' + e.message); }
}
const findIssue = (is, rule) => is.find(i => i.rule === rule);
const hasRule = (is, rule) => is.some(i => i.rule === rule);
const errCount = (is) => is.filter(i => i.severity === 'error').length;

console.log('CodePilot 回归测试\n-------------------');

/* ---- PY019 安全闸 ---- */
test('PY019: print(helloworld) 提供加引号修复', () => {
    const py019 = findIssue(diag('print(helloworld)'), 'PY019');
    assert.ok(py019, '应报 PY019');
    assert.ok(py019.fix && py019.fix.apply, '应提供加引号修复');
});
test('PY019: x = undef_var + 1 只报告不自动修复', () => {
    const py019 = findIssue(diag('x = undef_var + 1'), 'PY019');
    assert.ok(py019, '应报 PY019');
    assert.ok(!py019.fix || !py019.fix.apply, '不应提供加引号修复（会改坏）');
});
test('PY019: foo(undef_var) 调用实参不自动修复', () => {
    const is = diag('foo(undef_var)');
    const u = findIssue(is, 'PY019');
    assert.ok(u, '应报 undef_var 未定义');
    assert.ok(!u.fix || !u.fix.apply, '调用实参不应加引号');
});
test('PY019: 海象运算符 := 不误报', () => {
    const is = diag('data = [1, 2, 3]\nif (n := len(data)) > 2:\n    print(n)');
    assert.ok(!hasRule(is, 'PY019'), 'n 由 := 定义，不应报未定义');
});
test('PY019: star import 时降级为 hint', () => {
    const is = diag('from os.path import *\nprint(join("a", "b"))');
    const py019 = findIssue(is, 'PY019');
    assert.ok(py019, '应报 PY019');
    assert.strictEqual(py019.severity, 'hint', '应降级为 hint 而非 error');
    assert.ok(!py019.fix || !py019.fix.apply, '降级后不应提供修复');
});
test('PY019: lambda 带默认值参数不误报', () => {
    const is = diag('f = lambda x, y=1: x + y\nprint(f(1, 2))');
    assert.ok(!hasRule(is, 'PY019'), 'lambda 参数 x,y 应被收集');
});
test('PY019: 分号多语句不误报', () => {
    const is = diag('x = 1; y = 2\nprint(x + y)');
    assert.ok(!hasRule(is, 'PY019'), '分号后的 y 应被收集');
});
test('PY019: 星号解包不误报', () => {
    const is = diag('first, *rest = [1, 2, 3, 4]\nprint(first, rest)');
    assert.ok(!hasRule(is, 'PY019'), '解包目标 first,rest 应被收集');
});
test('PY019: 正常代码不误报', () => {
    const is = diag('import math\nprint(math.pi)\nx = [i for i in range(10)]\ndef foo(a, b):\n    return a + b\nprint(foo(1, 2))');
    assert.ok(!hasRule(is, 'PY019'), '正常代码不应报未定义');
});
test('PY019: 属性访问 obj.attr 不误报', () => {
    const is = diag('class A:\n    def __init__(self):\n        self.value = 10\n    def get(self):\n        return self.value\na = A()\nprint(a.get())');
    assert.ok(!hasRule(is, 'PY019'), '属性访问不应报未定义');
});

/* ---- PY020 缩进 ---- */
test('PY020: 3 空格缩进报 warning', () => {
    const is = diag('def f():\n   x = 1\n   return x');
    const py020 = findIssue(is, 'PY020');
    assert.ok(py020 && py020.severity === 'warning', '应报缩进 warning');
});
test('PY020: 4 空格缩进不报', () => {
    const is = diag('def f():\n    x = 1\n    return x');
    assert.ok(!hasRule(is, 'PY020'), '4 空格缩进正常');
});

/* ---- PY021 未使用导入 ---- */
test('PY021: 未使用导入报 warning', () => {
    const is = diag('import os\nimport sys\nprint(sys.version)');
    const py021 = findIssue(is, 'PY021');
    assert.ok(py021 && py021.message.includes('os'), '应报 os 未使用');
});
test('PY021: 一键修复删除未使用导入', () => {
    const r = fixAll('import os\nimport sys\nprint(sys.version)');
    assert.ok(r.code.includes('import sys'), '应保留 sys');
    assert.ok(!r.code.includes('import os'), '应删除 os');
});

/* ---- PY022 浮点比较 ---- */
test('PY022: 浮点 == 比较报 warning', () => {
    const is = diag('x = 0.1 + 0.2\nif x == 0.3:\n    print("equal")');
    const py022 = findIssue(is, 'PY022');
    assert.ok(py022 && py022.severity === 'warning', '应报浮点比较 warning');
});

/* ---- PY009 可变默认参数 ---- */
test('PY009: 可变默认参数修复为 None 哨兵', () => {
    const r = fixAll('def add(x=[]):\n    return x');
    assert.ok(r.code.includes('x=None'), '应改为 x=None');
    assert.ok(r.code.includes('if x is None:'), '应插入 None 判断');
});

/* ---- PY014 裸 except ---- */
test('PY014: 裸 except 修复为 except Exception:', () => {
    const r = fixAll('try:\n    x = 1\nexcept:\n    pass');
    assert.ok(r.code.includes('except Exception:'), '应改为 except Exception:');
});

/* ---- fixAll 安全闸 ---- */
const SAMPLE = 'def calculate_average(numbers\n    total = 0\n    for i in range(len(numbers))\n        total += numbers[i]\n    if total = 0\n        Print("warn")\n    return total / 0\nclass D:\n    def __init__(self):\n        self.items = []\n    def add(self, x=[]):\n        self.items.append(x)\n    def get(self)\n        return len(self.items)\nresult = calculate_average([10, 20, 30])\nprint("ok " + str(result))';
test('fixAll: 示例代码修复后 error 数为 0', () => {
    const r = fixAll(SAMPLE);
    assert.strictEqual(errCount(r.remainingIssues), 0, '修复后不应有 error');
});
test('fixAll: 示例代码修复关键项', () => {
    const r = fixAll(SAMPLE);
    assert.ok(r.code.includes('def calculate_average(numbers):'), '补冒号');
    assert.ok(r.code.includes('if total == 0:'), '= 改 ==');
    assert.ok(r.code.includes('print("warn")'), 'Print 改 print');
    assert.ok(r.code.includes('x=None'), '可变默认参数改 None');
});
test('fixAll: 不引入新 error（安全闸）', () => {
    const before = errCount(diag(SAMPLE));
    const r = fixAll(SAMPLE);
    const after = errCount(r.remainingIssues);
    assert.ok(after <= before, '修复后 error 数应不增（' + before + ' -> ' + after + '）');
});

/* ---- JS 规则不退步 ---- */
test('J001: JS 括号不匹配报错', () => {
    const is = diag('function f() {\n  return 1;\n', 'javascript');
    assert.ok(hasRule(is, 'J001'), '应报括号未闭合');
});
test('J005: JS 关键字拼写错误', () => {
    const is = diag('funtion f() { return 1; }', 'javascript');
    assert.ok(hasRule(is, 'J005'), '应报 funtion 拼写错误');
});

/* ---- 撤销/语法守卫：app.js 必须可解析 ---- */
test('app.js 语法正确（撤销/编辑器逻辑不破坏）', () => {
    const src = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
    new vm.Script(src, { filename: 'app.js' }); // 解析失败会抛 SyntaxError
    assert.ok(true);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);