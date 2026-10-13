items = [1, 2]
alias = items
items.append(items)
print(items)  # [1, 2, [...]]
alias[0] = 9
result = items[0]
print(items)
