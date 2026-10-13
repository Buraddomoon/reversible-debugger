def change(values):
    values[len(values) - 1] = 99
    values.append(42)
    return values

original = [3, 1, 2]
copy = original  # bug: compartilha a lista em vez de copiar
changed = change(copy)
result = original[2]  # deveria continuar sendo 2
print(original)
