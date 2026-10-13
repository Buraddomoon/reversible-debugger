def collect(n):
    values = []
    i = 0
    while i < n:
        values.append(i)
        print(i)
        i += 1
    return len(values)

result = collect(120)
