# sample_buggy.py — 包含多种典型错误的 Python 代码
# 把它粘贴进 CodePilot 编辑器，点击「开始诊断」即可看到效果
# 也可以直接点击网页里的「示例」按钮自动载入

def calculate_average(numbers    # 错误1: 缺少右括号 )  错误2: 缺少冒号 :
    total = 0
    for i in range(len(numbers)   # 错误3: 缺少右括号  错误4: 缺少冒号
        total += numbers[i]

    if total = 0                  # 错误5: 条件里用了 = 应为 ==
        Print("警告：总和为零")   # 错误6: Print 拼写错误，应为 print

    return total / 0              # 警告: 除以零


class DataProcessor:
    def __init__(self):
        self.items = []

    def add_item(self, x=[]):     # 警告: 可变默认参数陷阱
        self.items.append(x)

    def get_count(self)           # 错误7: 缺少冒号
        return len(self.items)


result = calculate_average([10, 20, 30])
print("结果是: " + str(result))